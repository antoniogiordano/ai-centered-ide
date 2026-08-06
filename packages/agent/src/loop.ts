import { randomUUID } from "node:crypto";
import type {
  AiProvider,
  AssistantToolCall,
  ChatMessage,
} from "@ai-ide/provider";
import type { SessionState, ToolCall, ToolResult, Turn } from "@ai-ide/shared";
import { formatAppErrorDisplay } from "@ai-ide/shared";
import {
  ToolGateway,
  createDefaultRegistry,
  defaultRedact,
  CBM_TOOL_NAMES,
  formatToolResultForModel,
  type ToolExecutionContext,
} from "@ai-ide/tools";
import {
  applyPlanTool,
  applyUpsertPlan,
  buildContext,
  bumpSessionSequence,
  CHECKLIST_CONTINUE_NUDGE,
  compactProviderMessages,
  isAgentTankMode,
  isPlanMutationTool,
  parseToolCallsFromText,
  planChecklistProgress,
  planHasOpenWork,
  PLAN_CONTINUE_NUDGE,
  productPhaseForState,
  tryParsePartialJson,
  TurnStateMachine,
} from "./state.js";

function isTankMode(state: SessionState): boolean {
  return isAgentTankMode(state);
}

function toolMessageContent(
  toolName: string,
  result: Pick<ToolResult, "summary" | "output" | "error">,
): string {
  return formatToolResultForModel({
    toolName,
    summary: result.summary,
    output: result.output,
    error: result.error ?? null,
  });
}

const INDEXED_CODEBASE_RULES = [
  "CODEBASE INDEX: READY — graph tools are available this turn.",
  "Explore with search_graph / search_code / get_architecture / get_code_snippet / trace_path FIRST.",
  "Do NOT walk the repo with repeated list_dir (src → components → …). list_dir/read_file/search_text stay allowed only after you have a concrete path from the graph or the user, or if a graph call fails.",
  "Typical first move: search_graph (or get_architecture) on the user's terms, then get_code_snippet / read_file on hits, then plan tools.",
].join("\n");

function toolDescriptionForModel(
  name: string,
  description: string,
  indexed: boolean,
): string {
  if (!indexed) return description;
  if (name === "list_dir") {
    return (
      "FALLBACK directory listing when the graph is indexed. Prefer search_graph / get_architecture / search_code for discovery. " +
      "Use list_dir only for a known path — do not chain list_dir to explore the tree."
    );
  }
  if (name === "search_text") {
    return (
      "FALLBACK workspace text search when the graph is indexed. Prefer search_code / search_graph instead."
    );
  }
  if (name === "read_file") {
    return (
      "Read a file window by path. When indexed, prefer get_code_snippet after search_graph; use read_file for a concrete path from graph hits or the user."
    );
  }
  return description;
}

function buildModelToolDefs(
  registry: ReturnType<typeof createDefaultRegistry>,
  stateLike: Pick<SessionState, "mode" | "planStatus" | "sessionKind">,
  indexed: boolean,
): Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  const tools = registry
    .listForPhase(productPhaseForState(stateLike))
    .filter((t) => {
      const isCbm = CBM_TOOL_NAMES.includes(t.name);
      // Keep FS read tools even when indexed — otherwise models fall back to shell.
      if (!indexed && isCbm) return false;
      return true;
    });

  const ranked = indexed
    ? [
        ...tools.filter((t) => CBM_TOOL_NAMES.includes(t.name)),
        ...tools.filter((t) => !CBM_TOOL_NAMES.includes(t.name)),
      ]
    : tools;

  return ranked.map((t) => ({
    name: t.name,
    description: toolDescriptionForModel(t.name, t.description, indexed),
    parameters: t.parameters,
  }));
}

async function appendIndexedCodebasePrompt(
  contextTurns: Turn[],
  cbm: ToolExecutionContext["cbm"] | undefined,
): Promise<void> {
  if (!cbm?.isIndexed()) return;
  const system = contextTurns[0];
  if (!system || system.role !== "system") return;
  let extra = INDEXED_CODEBASE_RULES;
  try {
    const preseed = await cbm.architecturePreseed();
    if (preseed?.trim()) {
      extra = `${extra}\n\nIndexed codebase graph summary (pre-seed):\n${preseed.trim()}`;
    }
  } catch {
    /* ignore preseed failures — rules still apply */
  }
  contextTurns[0] = {
    ...system,
    content: `${system.content}\n\n${extra}`,
  };
}

/** Keep the build/plan loop alive — no max rounds while tank mode applies. */
function pushTankContinue(
  workingState: SessionState,
  messages: ChatMessage[],
  tankRounds: number,
  emit: (event: AgentProgressEvent) => void,
): { state: SessionState; tankRounds: number } {
  const nextRound = tankRounds + 1;
  const planning = productPhaseForState(workingState) === "planning";
  const { done, total } = planChecklistProgress(workingState);
  const open = Math.max(0, total - done);
  const label = planning
    ? `Tank · planning · go ${nextRound}`
    : `Tank · ${done}/${total} done · ${open} open · go ${nextRound}`;
  let state = workingState;
  if (nextRound === 1 || nextRound % 5 === 0) {
    const notice: Turn = {
      id: randomUUID(),
      role: "assistant",
      content: planning
        ? `**Tank mode** · planning still open — upsert_plan / questions / propose_plan_ready (round ${nextRound})…`
        : `**Tank mode** · checklist **${done}/${total} done** (${open} open) — continue from the next open item; do not uncheck or restart (round ${nextRound})…`,
      createdAt: new Date().toISOString(),
    };
    state = { ...state, turns: [...state.turns, notice] };
  }
  state = {
    ...state,
    activityLabel: label,
    status: "thinking",
  };
  emit({
    type: "session_patch",
    patch: {
      turns: state.turns,
      activityLabel: label,
      status: "thinking",
    },
  });
  emit({ type: "activity", label, status: "thinking" });
  // Drop bloated history before the nudge — plan + goal + fresh tail only.
  const compacted = compactProviderMessages(messages, state);
  messages.length = 0;
  messages.push(...compacted, {
    role: "user",
    content: planning ? PLAN_CONTINUE_NUDGE : CHECKLIST_CONTINUE_NUDGE,
  });
  return { state, tankRounds: nextRound };
}

function refreshBuildMessages(
  messages: ChatMessage[],
  state: SessionState,
): void {
  // Bound context during long tank runs (planning or building).
  if (!isTankMode(state) && productPhaseForState(state) !== "building") {
    return;
  }
  const compacted = compactProviderMessages(messages, state);
  messages.length = 0;
  messages.push(...compacted);
}

export type AgentProgressEvent =
  | { type: "activity"; label: string; status: SessionState["status"] }
  | { type: "token"; text: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
    }
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
      patch: Partial<
        Pick<
          SessionState,
          | "planPhases"
          | "planQuestions"
          | "planStatus"
          | "mode"
          | "planReadyProposal"
          | "testingConfirmedAt"
          | "turns"
          | "activityLabel"
          | "status"
        >
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
  let tankRounds = 0;

  let workingState: SessionState = { ...state };
  const registry = createDefaultRegistry();
  const gateway = deps.gateway ?? new ToolGateway(registry);

  const toolDefsFor = (
    stateLike: Pick<SessionState, "mode" | "planStatus" | "sessionKind">,
  ) =>
    buildModelToolDefs(
      registry,
      stateLike,
      Boolean(deps.toolCtx?.cbm?.isIndexed()),
    );

  let toolDefs = toolDefsFor(workingState);

  const contextTurns = buildContext(workingState, userMessage);
  await appendIndexedCodebasePrompt(contextTurns, deps.toolCtx?.cbm);
  const messages: ChatMessage[] = contextTurns.map((t) => ({
    role: t.role === "system" || t.role === "user" ? t.role : "assistant",
    content: t.content,
  }));

  let assistantContent = "";
  const toolResults: ToolResult[] = [];
  const allToolCalls: ToolCall[] = [];

  while (machine.nextIteration(isTankMode(workingState))) {
    if (deps.signal?.aborted) {
      return fail(workingState, "Interrupted by user.", {
        assistantContent,
        toolCalls: allToolCalls,
        toolResults,
      });
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

    refreshBuildMessages(messages, workingState);
    for await (const chunk of deps.provider.chat(messages, {
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })) {
      if (deps.signal?.aborted) {
        return fail(workingState, "Interrupted by user.", {
        assistantContent,
        toolCalls: allToolCalls,
        toolResults,
      });
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
        return fail(workingState, formatAppErrorDisplay(chunk.error), {
          assistantContent,
          toolCalls: allToolCalls,
          toolResults,
        });
      }
      if (
        chunk.type === "done" &&
        chunk.usage &&
        (chunk.usage.inputTokens > 0 || chunk.usage.outputTokens > 0)
      ) {
        emit({
          type: "usage",
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
        });
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
      // Keep provider history coherent when the model narrates without tools.
      if (roundContent.trim()) {
        messages.push({
          role: "assistant",
          content: roundContent,
        });
      }
      if (isTankMode(workingState)) {
        const tank = pushTankContinue(workingState, messages, tankRounds, emit);
        workingState = tank.state;
        tankRounds = tank.tankRounds;
        continue;
      }
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
        const applied = applyPlanTool(call.name, workingState, call.arguments, {
          userMessage,
        });

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
            testingConfirmedAt: workingState.testingConfirmedAt,
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
          content: toolMessageContent(call.name, result),
        });
        toolDefs = toolDefsFor(workingState);
        if (!machine.recordToolResult(call.name, result.success, isTankMode(workingState))) {
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
        if (!machine.recordToolResult(call.name, false, isTankMode(workingState))) {
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

      const toolContent = toolMessageContent(call.name, outcome.result);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolContent,
      });

      if (!machine.recordToolResult(call.name, outcome.result.success, isTankMode(workingState))) {
        stop = true;
        break;
      }
    }

    if (stop) {
      return fail(
        workingState,
        "Agent stopped: repeated tool failures or loop detected.",
        {
          assistantContent,
          toolCalls: allToolCalls,
          toolResults,
        },
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
      turns: appendAssistantTurn(workingState, assistantTurn),
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
  const command =
    typeof call.arguments.command === "string" ? call.arguments.command : null;
  const query =
    typeof call.arguments.query === "string" ? call.arguments.query : null;
  switch (call.name) {
    case "read_file":
      return path ? `Reading ${path}…` : "Reading file…";
    case "list_dir":
      return path && path !== "." ? `Listing ${path}…` : "Listing files…";
    case "search_text":
      return query
        ? `Searching “${query.length > 48 ? `${query.slice(0, 45)}…` : query}”…`
        : "Searching…";
    case "write_file":
      return path ? `Writing ${path}…` : "Writing file…";
    case "run_command": {
      if (!command) return "Running command…";
      const compact = command.trim().replace(/\s+/g, " ");
      return `Running \`${compact.length > 64 ? `${compact.slice(0, 61)}…` : compact}\`…`;
    }
    case "search_graph":
      return query
        ? `Graph search “${query.length > 48 ? `${query.slice(0, 45)}…` : query}”…`
        : "Searching codebase graph…";
    case "trace_path":
      return "Tracing call path…";
    case "get_code_snippet":
      return "Fetching code snippet…";
    case "get_architecture":
      return "Reading architecture graph…";
    case "search_code":
      return query
        ? `Code search “${query.length > 48 ? `${query.slice(0, 45)}…` : query}”…`
        : "Searching indexed code…";
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
    case "read_plan":
      return "Reading plan…";
    case "add_phase":
      return "Adding phase…";
    case "replace_phase":
      return "Updating phase…";
    case "delete_phase":
      return "Removing phase…";
    case "add_check":
      return "Adding checklist item…";
    case "replace_check":
      return "Updating checklist item…";
    case "delete_check":
      return "Removing checklist item…";
    case "set_questions":
      return "Updating questions…";
    case "propose_plan_ready":
      return "Marking plan ready…";
    case "propose_testing_ready":
      return "Confirming testing ready…";
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

function fail(
  state: SessionState,
  message: string,
  opts?: {
    assistantContent?: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
  },
): AgentLoopResult {
  const turns = [...state.turns];
  const prose = opts?.assistantContent?.trim() ?? "";
  const tools = opts?.toolCalls ?? [];
  const results = opts?.toolResults ?? [];
  if (prose || tools.length || results.length) {
    turns.push({
      id: randomUUID(),
      role: "assistant",
      content: prose || (tools.length ? "" : message),
      ...(tools.length ? { toolCalls: tools } : {}),
      ...(results.length ? { toolResults: results } : {}),
      createdAt: new Date().toISOString(),
    });
  }
  const interrupted = message === "Interrupted by user.";
  if (
    !interrupted &&
    productPhaseForState(state) === "building" &&
    planHasOpenWork(state)
  ) {
    const { done, total } = planChecklistProgress(state);
    const open = Math.max(0, total - done);
    turns.push({
      id: randomUUID(),
      role: "assistant",
      content: [
        `**Build paused** · checklist **${done}/${total} done** (${open} open).`,
        "",
        message,
        "",
        "Press **Resume** when you want to continue.",
      ].join("\n"),
      createdAt: new Date().toISOString(),
    });
  } else if (!interrupted && !prose && tools.length === 0) {
    turns.push({
      id: randomUUID(),
      role: "assistant",
      content: message,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    state: bumpSessionSequence({
      ...state,
      status: "error",
      error: message,
      turns,
      partialAssistantText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
    }),
    assistantContent: opts?.assistantContent ?? "",
    toolResults: results,
  };
}

function appendAssistantTurn(state: SessionState, assistantTurn: Turn): Turn[] {
  return [...state.turns, assistantTurn];
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
  let tankRounds = 0;
  const registry = createDefaultRegistry();
  const gateway = deps.gateway ?? new ToolGateway(registry);

  const toolDefsFor = (
    stateLike: Pick<SessionState, "mode" | "planStatus" | "sessionKind">,
  ) =>
    buildModelToolDefs(
      registry,
      stateLike,
      Boolean(deps.toolCtx?.cbm?.isIndexed()),
    );

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
      return fail(workingState, "Interrupted by user.", {
        assistantContent,
        toolCalls: allToolCalls,
        toolResults,
      });
    }
    if (!allToolCalls.some((c) => c.id === call.id)) {
      allToolCalls.push(call);
    }
    const label = toolActivityLabel(call);
    emit({ type: "tool_start", call, label });
    emit({ type: "activity", label, status: "tool" });

    if (isPlanMutationTool(call.name)) {
      const applied = applyPlanTool(call.name, workingState, call.arguments, {
        userMessage,
      });
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
          testingConfirmedAt: workingState.testingConfirmedAt,
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
        content: toolMessageContent(call.name, result),
      });
      toolDefs = toolDefsFor(workingState);
      if (!machine.recordToolResult(call.name, result.success, isTankMode(workingState))) {
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
      if (!machine.recordToolResult(call.name, false, isTankMode(workingState))) {
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
      content: toolMessageContent(call.name, outcome.result),
    });
    if (!machine.recordToolResult(call.name, outcome.result.success, isTankMode(workingState))) {
      stop = true;
      break;
    }
  }

  if (stop) {
    return fail(
      workingState,
      "Agent stopped: repeated tool failures or loop detected.",
      {
        assistantContent,
        toolCalls: allToolCalls,
        toolResults,
      },
    );
  }

  // Continue provider rounds (same as runAgentTurn after a tool batch).
  while (machine.nextIteration(isTankMode(workingState))) {
    if (deps.signal?.aborted) {
      return fail(workingState, "Interrupted by user.", {
        assistantContent,
        toolCalls: allToolCalls,
        toolResults,
      });
    }

    machine.phase = "awaiting_provider";
    emit({ type: "activity", label: "Thinking…", status: "thinking" });

    let roundContent = "";
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean }
    >();
    let streamedThisRound = false;

    refreshBuildMessages(messages, workingState);
    for await (const chunk of deps.provider.chat(messages, {
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    })) {
      if (deps.signal?.aborted) {
        return fail(workingState, "Interrupted by user.", {
        assistantContent,
        toolCalls: allToolCalls,
        toolResults,
      });
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
        return fail(workingState, formatAppErrorDisplay(chunk.error), {
          assistantContent,
          toolCalls: allToolCalls,
          toolResults,
        });
      }
      if (
        chunk.type === "done" &&
        chunk.usage &&
        (chunk.usage.inputTokens > 0 || chunk.usage.outputTokens > 0)
      ) {
        emit({
          type: "usage",
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
        });
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
      if (roundContent.trim()) {
        messages.push({
          role: "assistant",
          content: roundContent,
        });
      }
      if (isTankMode(workingState)) {
        const tank = pushTankContinue(workingState, messages, tankRounds, emit);
        workingState = tank.state;
        tankRounds = tank.tankRounds;
        continue;
      }
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
        const applied = applyPlanTool(call.name, workingState, call.arguments, {
          userMessage,
        });
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
            testingConfirmedAt: workingState.testingConfirmedAt,
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
          content: toolMessageContent(call.name, result),
        });
        toolDefs = toolDefsFor(workingState);
        if (!machine.recordToolResult(call.name, result.success, isTankMode(workingState))) {
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
        if (!machine.recordToolResult(call.name, false, isTankMode(workingState))) {
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
        content: toolMessageContent(call.name, outcome.result),
      });
      if (!machine.recordToolResult(call.name, outcome.result.success, isTankMode(workingState))) {
        batchStop = true;
        break;
      }
    }

    if (batchStop) {
      return fail(
        workingState,
        "Agent stopped: repeated tool failures or loop detected.",
        {
          assistantContent,
          toolCalls: allToolCalls,
          toolResults,
        },
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
      turns: appendAssistantTurn(workingState, assistantTurn),
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
