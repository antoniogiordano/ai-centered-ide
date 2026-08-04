import { randomUUID } from "node:crypto";
import type {
  AiProvider,
  AssistantToolCall,
  ChatMessage,
} from "@ai-ide/provider";
import type { SessionState, ToolCall, ToolResult, Turn } from "@ai-ide/shared";
import {
  ToolGateway,
  createDefaultRegistry,
  defaultRedact,
  CBM_TOOL_NAMES,
  FS_READ_TOOL_NAMES,
  type ToolExecutionContext,
} from "@ai-ide/tools";
import {
  applyFinalizePlan,
  applyProposePlanReady,
  applyUpsertPlan,
  buildContext,
  bumpSessionSequence,
  isPlanMutationTool,
  parseToolCallsFromText,
  productPhaseForState,
  tryParsePartialJson,
  TurnStateMachine,
} from "./state.js";

export type AgentProgressEvent =
  | { type: "activity"; label: string; status: SessionState["status"] }
  | { type: "token"; text: string }
  | {
      type: "tool_start";
      call: ToolCall;
      label: string;
    }
  | {
      type: "tool_args";
      callId: string;
      name: string;
      argumentsJson: string;
      label: string;
    }
  | {
      type: "tool_end";
      result: ToolResult;
      label: string;
    }
  | {
      type: "session_patch";
      patch: Pick<
        SessionState,
        | "planPhases"
        | "planQuestions"
        | "planStatus"
        | "mode"
        | "planReadyProposal"
      >;
      /** Live draft while tool args stream — do not persist. */
      provisional?: boolean;
    };

export type AgentLoopDeps = {
  provider: AiProvider;
  gateway?: ToolGateway;
  toolCtx?: Partial<ToolExecutionContext>;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
};

/** In-memory snapshot so Approve can resume the tool loop. */
export type PausedAgentTurn = {
  approvalId: string;
  messages: ChatMessage[];
  assistantContent: string;
  toolResults: ToolResult[];
  allToolCalls: ToolCall[];
  /** Includes the call awaiting approval, then any not-yet-run siblings. */
  remainingCalls: ToolCall[];
  userMessage: string;
};

export type AgentLoopResult = {
  state: SessionState;
  assistantContent: string;
  toolResults: ToolResult[];
  pause?: PausedAgentTurn;
};

export async function runAgentTurn(
  state: SessionState,
  userMessage: string,
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  const machine = new TurnStateMachine();
  machine.begin();
  const emit = deps.onProgress ?? (() => undefined);

  let workingState: SessionState = { ...state };
  const registry = createDefaultRegistry();
  const gateway = deps.gateway ?? new ToolGateway(registry);

  const toolDefsFor = (
    stateLike: Pick<SessionState, "mode" | "planStatus" | "sessionKind">,
  ) => {
    const indexed = Boolean(deps.toolCtx?.cbm?.isIndexed());
    return registry
      .listForPhase(productPhaseForState(stateLike))
      .filter((t) => {
        const isFs = (FS_READ_TOOL_NAMES as readonly string[]).includes(t.name);
        const isCbm = CBM_TOOL_NAMES.includes(t.name);
        if (indexed) {
          if (isFs) return false;
          return true;
        }
        if (isCbm) return false;
        return true;
      })
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  };

  let toolDefs = toolDefsFor(workingState);

  const contextTurns = buildContext(workingState, userMessage);
  if (deps.toolCtx?.cbm?.isIndexed()) {
    try {
      const preseed = await deps.toolCtx.cbm.architecturePreseed();
      const system = contextTurns[0];
      if (preseed && system?.role === "system") {
        contextTurns[0] = {
          ...system,
          content: `${system.content}\n\nIndexed codebase graph summary (pre-seed):\n${preseed}`,
        };
      }
    } catch {
      /* ignore preseed failures */
    }
  }
  const messages: ChatMessage[] = contextTurns.map((t) => ({
    role: t.role === "system" || t.role === "user" ? t.role : "assistant",
    content: t.content,
  }));

  let assistantContent = "";
  const toolResults: ToolResult[] = [];
  const allToolCalls: ToolCall[] = [];

  while (machine.nextIteration()) {
    if (deps.signal?.aborted) {
      return fail(workingState, "Interrupted by user.");
    }

    machine.phase = "awaiting_provider";
    emit({ type: "activity", label: "Thinking…", status: "thinking" });

    let roundContent = "";
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean }
    >();
    let streamedThisRound = false;
    let lastProvisionalEmit = 0;

    for await (const chunk of deps.provider.chat(messages, {
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })) {
      if (deps.signal?.aborted) {
        return fail(workingState, "Interrupted by user.");
      }
      if (chunk.type === "content") {
        if (!streamedThisRound) {
          emit({ type: "activity", label: "Writing…", status: "streaming" });
          streamedThisRound = true;
        }
        roundContent += chunk.delta;
        assistantContent += chunk.delta;
        emit({ type: "token", text: assistantContent });
      }
      if (chunk.type === "tool_call") {
        const current = pendingToolCalls.get(chunk.index) ?? {
          id: chunk.id || randomUUID(),
          name: chunk.name || "",
          arguments: "",
          started: false,
        };
        if (chunk.id) current.id = chunk.id;
        if (chunk.name) current.name = chunk.name;
        current.arguments += chunk.argumentsDelta;
        pendingToolCalls.set(chunk.index, current);

        if (current.name && !current.started) {
          current.started = true;
          const earlyCall: ToolCall = {
            id: current.id,
            name: current.name,
            arguments: {},
            riskLevel: "safe",
          };
          emit({
            type: "tool_start",
            call: earlyCall,
            label: toolActivityLabel(earlyCall),
          });
          emit({
            type: "activity",
            label: toolActivityLabel(earlyCall),
            status: "tool",
          });
        }

        if (current.name) {
          const label = toolActivityLabel({
            id: current.id,
            name: current.name,
            arguments: {},
            riskLevel: "safe",
          });
          emit({
            type: "tool_args",
            callId: current.id,
            name: current.name,
            argumentsJson: current.arguments,
            label,
          });

          if (current.name === "upsert_plan") {
            const now = Date.now();
            if (now - lastProvisionalEmit >= 80) {
              const partial = tryParsePartialJson(current.arguments);
              if (partial && typeof partial === "object" && partial !== null) {
                const args = partial as Record<string, unknown>;
                if (Array.isArray(args.phases) && args.phases.length > 0) {
                  const draft = applyUpsertPlan(workingState, args);
                  if (draft.result.success) {
                    lastProvisionalEmit = now;
                    emit({
                      type: "session_patch",
                      provisional: true,
                      patch: {
                        planPhases: draft.state.planPhases,
                        planQuestions: draft.state.planQuestions,
                        planStatus: draft.state.planStatus,
                        mode: draft.state.mode,
                        planReadyProposal: draft.state.planReadyProposal,
                      },
                    });
                  }
                }
              }
            }
          }
        }
      }
      if (chunk.type === "error") {
        return fail(workingState, chunk.error.userMessage);
      }
    }

    let toolCalls: ToolCall[] = [...pendingToolCalls.values()]
      .filter((c) => c.name)
      .map((c) => {
        let args: Record<string, unknown> = {};
        try {
          args = c.arguments.trim()
            ? (JSON.parse(c.arguments) as Record<string, unknown>)
            : {};
        } catch {
          args = {};
        }
        return {
          id: c.id || randomUUID(),
          name: c.name,
          arguments: args,
          riskLevel: "safe" as const,
        };
      });

    if (toolCalls.length === 0) {
      toolCalls = parseToolCallsFromText(roundContent);
    }

    if (toolCalls.length === 0) {
      machine.complete();
      break;
    }

    machine.phase = "executing_tools";
    const baseCtx = deps.toolCtx;
    const openAiToolCalls: AssistantToolCall[] = toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: JSON.stringify(c.arguments ?? {}),
    }));

    messages.push({
      role: "assistant",
      content: roundContent || null,
      tool_calls: openAiToolCalls,
    });

    let stop = false;
    for (const call of toolCalls) {
      allToolCalls.push(call);
      const label = toolActivityLabel(call);
      // tool_start may already have been emitted while arguments streamed.
      emit({ type: "tool_start", call, label });
      emit({ type: "activity", label, status: "tool" });

      if (isPlanMutationTool(call.name)) {
        const applied =
          call.name === "propose_plan_ready"
            ? applyProposePlanReady(workingState, call.arguments)
            : call.name === "finalize_plan"
              ? applyFinalizePlan(workingState, call.arguments, { userMessage })
              : applyUpsertPlan(workingState, call.arguments);

        // Keep the model-facing call id aligned with the tool message.
        const result: ToolResult = { ...applied.result, callId: call.id };
        workingState = applied.state;
        toolResults.push(result);
        emit({
          type: "session_patch",
          patch: {
            planPhases: workingState.planPhases,
            planQuestions: workingState.planQuestions,
            planStatus: workingState.planStatus,
            mode: workingState.mode,
            planReadyProposal: workingState.planReadyProposal,
          },
        });
        emit({
          type: "tool_end",
          result,
          label: result.success ? label : `${label} failed`,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(
            {
              summary: result.summary,
              output: result.output ?? null,
              error: result.error ?? null,
            },
            null,
            2,
          ),
        });
        toolDefs = toolDefsFor(workingState);
        if (!machine.recordToolResult(call.name, result.success)) {
          stop = true;
          break;
        }
        continue;
      }

      if (
        !baseCtx?.fs ||
        !baseCtx.git ||
        !baseCtx.checkpoint ||
        !baseCtx.workspaceRoot
      ) {
        const failed: ToolResult = {
          callId: call.id,
          success: false,
          summary: "Tool context not configured (open a workspace first).",
          error: "No workspace",
        };
        toolResults.push(failed);
        emit({ type: "tool_end", result: failed, label });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: failed.summary,
        });
        if (!machine.recordToolResult(call.name, false)) {
          stop = true;
          break;
        }
        continue;
      }

      const ctx: ToolExecutionContext = {
        workspaceRoot: baseCtx.workspaceRoot,
        mode: workingState.mode,
        grants: workingState.approvalGrants,
        fs: baseCtx.fs,
        git: baseCtx.git,
        checkpoint: baseCtx.checkpoint,
        audit: baseCtx.audit ?? (() => undefined),
        redact: baseCtx.redact ?? defaultRedact,
        approvedCategories: baseCtx.approvedCategories ?? new Set(),
        ...(baseCtx.terminals ? { terminals: baseCtx.terminals } : {}),
        ...(baseCtx.cbm ? { cbm: baseCtx.cbm } : {}),
      };

      const outcome = await gateway.executeTool(call, ctx);
      if (outcome.status === "approval_required") {
        const idx = toolCalls.findIndex((c) => c.id === call.id);
        const remainingCalls = toolCalls.slice(idx >= 0 ? idx : toolCalls.length - 1);
        return {
          state: bumpSessionSequence({
            ...workingState,
            status: "awaiting_approval",
            pendingApprovals: [
              ...workingState.pendingApprovals,
              {
                id: outcome.approvalId,
                toolCall: outcome.call,
                description: outcome.description,
                riskLevel: outcome.call.riskLevel,
              },
            ],
            partialAssistantText: null,
            activityLabel: "Waiting for approval…",
            liveTools: [],
          }),
          assistantContent,
          toolResults,
          pause: {
            approvalId: outcome.approvalId,
            messages: [...messages],
            assistantContent,
            toolResults: [...toolResults],
            allToolCalls: [...allToolCalls],
            remainingCalls,
            userMessage,
          },
        };
      }

      toolResults.push(outcome.result);
      emit({
        type: "tool_end",
        result: outcome.result,
        label: outcome.result.success ? label : `${label} failed`,
      });

      const toolContent = JSON.stringify(
        {
          summary: outcome.result.summary,
          output: outcome.result.output ?? null,
          error: outcome.result.error ?? null,
        },
        null,
        2,
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolContent,
      });

      if (!machine.recordToolResult(call.name, outcome.result.success)) {
        stop = true;
        break;
      }
    }

    if (stop) {
      return fail(
        workingState,
        "Agent stopped: repeated tool failures or loop detected.",
      );
    }

    emit({ type: "activity", label: "Thinking…", status: "thinking" });
  }

  machine.complete();

  const assistantTurn: Turn = {
    id: randomUUID(),
    role: "assistant",
    content: assistantContent || "(no response)",
    toolCalls: allToolCalls.length ? allToolCalls : undefined,
    toolResults: toolResults.length ? toolResults : undefined,
    createdAt: new Date().toISOString(),
  };

  return {
    state: bumpSessionSequence({
      ...workingState,
      status: "idle",
      turns: [...workingState.turns, assistantTurn],
      error: null,
      partialAssistantText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
    }),
    assistantContent,
    toolResults,
  };
}

function toolActivityLabel(call: ToolCall): string {
  const path =
    typeof call.arguments.path === "string" ? call.arguments.path : null;
  switch (call.name) {
    case "read_file":
      return path ? `Reading ${path}…` : "Reading file…";
    case "list_dir":
      return path && path !== "." ? `Listing ${path}…` : "Listing files…";
    case "search_text":
      return "Searching…";
    case "write_file":
      return path ? `Writing ${path}…` : "Writing file…";
    case "run_command":
      return "Running command…";
    case "search_graph":
      return "Searching codebase graph…";
    case "trace_path":
      return "Tracing call path…";
    case "get_code_snippet":
      return "Fetching code snippet…";
    case "get_architecture":
      return "Reading architecture graph…";
    case "search_code":
      return "Searching indexed code…";
    case "get_graph_schema":
      return "Reading graph schema…";
    case "detect_changes":
      return "Detecting change blast radius…";
    case "terminal_open":
      return "Opening terminal…";
    case "terminal_write":
      return "Writing to terminal…";
    case "terminal_ask":
      return "Waiting for terminal decision…";
    case "terminal_read":
      return "Reading terminal…";
    case "terminal_list":
      return "Listing terminals…";
    case "terminal_close":
      return "Closing terminal…";
    case "upsert_plan":
      return "Updating plan…";
    case "propose_plan_ready":
      return "Marking plan ready…";
    case "read_architecture":
      return "Reading architecture…";
    case "upsert_architecture":
      return "Updating architecture…";
    case "finalize_plan":
      return "Finalizing plan…";
    default:
      return `Running ${call.name}…`;
  }
}

function fail(state: SessionState, message: string): AgentLoopResult {
  return {
    state: bumpSessionSequence({
      ...state,
      status: "error",
      error: message,
      partialAssistantText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
    }),
    assistantContent: "",
    toolResults: [],
  };
}

/**
 * Continue after the user approves a pending tool call.
 * Re-executes the paused call (and siblings) with a one-shot approval bypass.
 */
export async function resumeAgentTurn(
  state: SessionState,
  pause: PausedAgentTurn,
  deps: AgentLoopDeps & { approvedCallId: string },
): Promise<AgentLoopResult> {
  const machine = new TurnStateMachine();
  machine.begin();
  const emit = deps.onProgress ?? (() => undefined);
  const registry = createDefaultRegistry();
  const gateway = deps.gateway ?? new ToolGateway(registry);

  const toolDefsFor = (
    stateLike: Pick<SessionState, "mode" | "planStatus" | "sessionKind">,
  ) => {
    const indexed = Boolean(deps.toolCtx?.cbm?.isIndexed());
    return registry
      .listForPhase(productPhaseForState(stateLike))
      .filter((t) => {
        const isFs = (FS_READ_TOOL_NAMES as readonly string[]).includes(t.name);
        const isCbm = CBM_TOOL_NAMES.includes(t.name);
        if (indexed) {
          if (isFs) return false;
          return true;
        }
        if (isCbm) return false;
        return true;
      })
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
  };

  let workingState: SessionState = {
    ...state,
    pendingApprovals: state.pendingApprovals.filter(
      (a) => a.id !== pause.approvalId,
    ),
    status: "tool",
    activityLabel: "Running approved tool…",
  };
  let toolDefs = toolDefsFor(workingState);
  const messages: ChatMessage[] = [...pause.messages];
  let assistantContent = pause.assistantContent;
  const toolResults: ToolResult[] = [...pause.toolResults];
  const allToolCalls: ToolCall[] = [...pause.allToolCalls];
  const userMessage = pause.userMessage;
  const baseCtx = deps.toolCtx;
  const oneShot = new Set<string>([deps.approvedCallId]);

  let stop = false;
  for (const call of pause.remainingCalls) {
    if (deps.signal?.aborted) {
      return fail(workingState, "Interrupted by user.");
    }
    if (!allToolCalls.some((c) => c.id === call.id)) {
      allToolCalls.push(call);
    }
    const label = toolActivityLabel(call);
    emit({ type: "tool_start", call, label });
    emit({ type: "activity", label, status: "tool" });

    if (isPlanMutationTool(call.name)) {
      const applied =
        call.name === "propose_plan_ready"
          ? applyProposePlanReady(workingState, call.arguments)
          : call.name === "finalize_plan"
            ? applyFinalizePlan(workingState, call.arguments, { userMessage })
            : applyUpsertPlan(workingState, call.arguments);
      const result: ToolResult = { ...applied.result, callId: call.id };
      workingState = applied.state;
      toolResults.push(result);
      emit({
        type: "session_patch",
        patch: {
          planPhases: workingState.planPhases,
          planQuestions: workingState.planQuestions,
          planStatus: workingState.planStatus,
          mode: workingState.mode,
          planReadyProposal: workingState.planReadyProposal,
        },
      });
      emit({
        type: "tool_end",
        result,
        label: result.success ? label : `${label} failed`,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(
          {
            summary: result.summary,
            output: result.output ?? null,
            error: result.error ?? null,
          },
          null,
          2,
        ),
      });
      toolDefs = toolDefsFor(workingState);
      if (!machine.recordToolResult(call.name, result.success)) {
        stop = true;
        break;
      }
      continue;
    }

    if (
      !baseCtx?.fs ||
      !baseCtx.git ||
      !baseCtx.checkpoint ||
      !baseCtx.workspaceRoot
    ) {
      const failed: ToolResult = {
        callId: call.id,
        success: false,
        summary: "Tool context not configured (open a workspace first).",
        error: "No workspace",
      };
      toolResults.push(failed);
      emit({ type: "tool_end", result: failed, label });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: failed.summary,
      });
      if (!machine.recordToolResult(call.name, false)) {
        stop = true;
        break;
      }
      continue;
    }

    const ctx: ToolExecutionContext = {
      workspaceRoot: baseCtx.workspaceRoot,
      mode: workingState.mode,
      grants: workingState.approvalGrants,
      fs: baseCtx.fs,
      git: baseCtx.git,
      checkpoint: baseCtx.checkpoint,
      audit: baseCtx.audit ?? (() => undefined),
      redact: baseCtx.redact ?? defaultRedact,
      approvedCategories: baseCtx.approvedCategories ?? new Set(),
      oneShotApprovedIds: oneShot,
      ...(baseCtx.terminals ? { terminals: baseCtx.terminals } : {}),
      ...(baseCtx.cbm ? { cbm: baseCtx.cbm } : {}),
    };

    const outcome = await gateway.executeTool(call, ctx);
    if (outcome.status === "approval_required") {
      const idx = pause.remainingCalls.findIndex((c) => c.id === call.id);
      const remainingCalls = pause.remainingCalls.slice(
        idx >= 0 ? idx : pause.remainingCalls.length - 1,
      );
      return {
        state: bumpSessionSequence({
          ...workingState,
          status: "awaiting_approval",
          pendingApprovals: [
            ...workingState.pendingApprovals,
            {
              id: outcome.approvalId,
              toolCall: outcome.call,
              description: outcome.description,
              riskLevel: outcome.call.riskLevel,
            },
          ],
          partialAssistantText: null,
          activityLabel: "Waiting for approval…",
          liveTools: [],
        }),
        assistantContent,
        toolResults,
        pause: {
          approvalId: outcome.approvalId,
          messages: [...messages],
          assistantContent,
          toolResults: [...toolResults],
          allToolCalls: [...allToolCalls],
          remainingCalls,
          userMessage,
        },
      };
    }

    toolResults.push(outcome.result);
    emit({
      type: "tool_end",
      result: outcome.result,
      label: outcome.result.success ? label : `${label} failed`,
    });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(
        {
          summary: outcome.result.summary,
          output: outcome.result.output ?? null,
          error: outcome.result.error ?? null,
        },
        null,
        2,
      ),
    });
    if (!machine.recordToolResult(call.name, outcome.result.success)) {
      stop = true;
      break;
    }
  }

  if (stop) {
    return fail(
      workingState,
      "Agent stopped: repeated tool failures or loop detected.",
    );
  }

  // Continue provider rounds (same as runAgentTurn after a tool batch).
  while (machine.nextIteration()) {
    if (deps.signal?.aborted) {
      return fail(workingState, "Interrupted by user.");
    }

    machine.phase = "awaiting_provider";
    emit({ type: "activity", label: "Thinking…", status: "thinking" });

    let roundContent = "";
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean }
    >();
    let streamedThisRound = false;

    for await (const chunk of deps.provider.chat(messages, {
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })) {
      if (deps.signal?.aborted) {
        return fail(workingState, "Interrupted by user.");
      }
      if (chunk.type === "content") {
        if (!streamedThisRound) {
          emit({ type: "activity", label: "Writing…", status: "streaming" });
          streamedThisRound = true;
        }
        roundContent += chunk.delta;
        assistantContent += chunk.delta;
        emit({ type: "token", text: assistantContent });
      }
      if (chunk.type === "tool_call") {
        const current = pendingToolCalls.get(chunk.index) ?? {
          id: chunk.id || randomUUID(),
          name: chunk.name || "",
          arguments: "",
          started: false,
        };
        if (chunk.id) current.id = chunk.id;
        if (chunk.name) current.name = chunk.name;
        current.arguments += chunk.argumentsDelta;
        pendingToolCalls.set(chunk.index, current);
        if (current.name && !current.started) {
          current.started = true;
          const earlyCall: ToolCall = {
            id: current.id,
            name: current.name,
            arguments: {},
            riskLevel: "safe",
          };
          emit({
            type: "tool_start",
            call: earlyCall,
            label: toolActivityLabel(earlyCall),
          });
        }
      }
      if (chunk.type === "error") {
        return fail(workingState, chunk.error.userMessage);
      }
    }

    let toolCalls: ToolCall[] = [...pendingToolCalls.values()]
      .filter((c) => c.name)
      .map((c) => {
        let args: Record<string, unknown> = {};
        try {
          args = c.arguments.trim()
            ? (JSON.parse(c.arguments) as Record<string, unknown>)
            : {};
        } catch {
          args = {};
        }
        return {
          id: c.id || randomUUID(),
          name: c.name,
          arguments: args,
          riskLevel: "safe" as const,
        };
      });

    if (toolCalls.length === 0) {
      toolCalls = parseToolCallsFromText(roundContent);
    }

    if (toolCalls.length === 0) {
      machine.complete();
      break;
    }

    machine.phase = "executing_tools";
    const openAiToolCalls: AssistantToolCall[] = toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: JSON.stringify(c.arguments ?? {}),
    }));
    messages.push({
      role: "assistant",
      content: roundContent || null,
      tool_calls: openAiToolCalls,
    });

    let batchStop = false;
    for (const call of toolCalls) {
      allToolCalls.push(call);
      const label = toolActivityLabel(call);
      emit({ type: "tool_start", call, label });
      emit({ type: "activity", label, status: "tool" });

      if (isPlanMutationTool(call.name)) {
        const applied =
          call.name === "propose_plan_ready"
            ? applyProposePlanReady(workingState, call.arguments)
            : call.name === "finalize_plan"
              ? applyFinalizePlan(workingState, call.arguments, { userMessage })
              : applyUpsertPlan(workingState, call.arguments);
        const result: ToolResult = { ...applied.result, callId: call.id };
        workingState = applied.state;
        toolResults.push(result);
        emit({
          type: "session_patch",
          patch: {
            planPhases: workingState.planPhases,
            planQuestions: workingState.planQuestions,
            planStatus: workingState.planStatus,
            mode: workingState.mode,
            planReadyProposal: workingState.planReadyProposal,
          },
        });
        emit({
          type: "tool_end",
          result,
          label: result.success ? label : `${label} failed`,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(
            {
              summary: result.summary,
              output: result.output ?? null,
              error: result.error ?? null,
            },
            null,
            2,
          ),
        });
        toolDefs = toolDefsFor(workingState);
        if (!machine.recordToolResult(call.name, result.success)) {
          batchStop = true;
          break;
        }
        continue;
      }

      if (
        !baseCtx?.fs ||
        !baseCtx.git ||
        !baseCtx.checkpoint ||
        !baseCtx.workspaceRoot
      ) {
        const failed: ToolResult = {
          callId: call.id,
          success: false,
          summary: "Tool context not configured (open a workspace first).",
          error: "No workspace",
        };
        toolResults.push(failed);
        emit({ type: "tool_end", result: failed, label });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: failed.summary,
        });
        if (!machine.recordToolResult(call.name, false)) {
          batchStop = true;
          break;
        }
        continue;
      }

      const ctx: ToolExecutionContext = {
        workspaceRoot: baseCtx.workspaceRoot,
        mode: workingState.mode,
        grants: workingState.approvalGrants,
        fs: baseCtx.fs,
        git: baseCtx.git,
        checkpoint: baseCtx.checkpoint,
        audit: baseCtx.audit ?? (() => undefined),
        redact: baseCtx.redact ?? defaultRedact,
        approvedCategories: baseCtx.approvedCategories ?? new Set(),
        ...(baseCtx.terminals ? { terminals: baseCtx.terminals } : {}),
        ...(baseCtx.cbm ? { cbm: baseCtx.cbm } : {}),
      };

      const outcome = await gateway.executeTool(call, ctx);
      if (outcome.status === "approval_required") {
        const idx = toolCalls.findIndex((c) => c.id === call.id);
        const remainingCalls = toolCalls.slice(idx >= 0 ? idx : toolCalls.length - 1);
        return {
          state: bumpSessionSequence({
            ...workingState,
            status: "awaiting_approval",
            pendingApprovals: [
              ...workingState.pendingApprovals,
              {
                id: outcome.approvalId,
                toolCall: outcome.call,
                description: outcome.description,
                riskLevel: outcome.call.riskLevel,
              },
            ],
            partialAssistantText: null,
            activityLabel: "Waiting for approval…",
            liveTools: [],
          }),
          assistantContent,
          toolResults,
          pause: {
            approvalId: outcome.approvalId,
            messages: [...messages],
            assistantContent,
            toolResults: [...toolResults],
            allToolCalls: [...allToolCalls],
            remainingCalls,
            userMessage,
          },
        };
      }

      toolResults.push(outcome.result);
      emit({
        type: "tool_end",
        result: outcome.result,
        label: outcome.result.success ? label : `${label} failed`,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(
          {
            summary: outcome.result.summary,
            output: outcome.result.output ?? null,
            error: outcome.result.error ?? null,
          },
          null,
          2,
        ),
      });
      if (!machine.recordToolResult(call.name, outcome.result.success)) {
        batchStop = true;
        break;
      }
    }

    if (batchStop) {
      return fail(
        workingState,
        "Agent stopped: repeated tool failures or loop detected.",
      );
    }
    emit({ type: "activity", label: "Thinking…", status: "thinking" });
  }

  machine.complete();
  const assistantTurn: Turn = {
    id: randomUUID(),
    role: "assistant",
    content: assistantContent || "(no response)",
    toolCalls: allToolCalls.length ? allToolCalls : undefined,
    toolResults: toolResults.length ? toolResults : undefined,
    createdAt: new Date().toISOString(),
  };

  return {
    state: bumpSessionSequence({
      ...workingState,
      status: "idle",
      turns: [...workingState.turns, assistantTurn],
      error: null,
      partialAssistantText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
      pendingApprovals: [],
    }),
    assistantContent,
    toolResults,
  };
}
