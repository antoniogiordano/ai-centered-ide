import { randomUUID } from "node:crypto";
import type {
  AiProvider,
  AssistantToolCall,
  ChatMessage,
  ContentPart,
} from "@ai-ide/provider";
import { chatContentText } from "@ai-ide/provider";
import type { SessionState, ToolCall, ToolResult, Turn } from "@ai-ide/shared";
import {
  formatAppErrorDisplay,
  MAX_GATE_EVIDENCE_ROUNDS,
  MAX_GATE_FIX_ROUNDS_WITHOUT_EDIT,
} from "@ai-ide/shared";
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
  CHECK_CONTINUE_NUDGE,
  CHECKLIST_CONTINUE_NUDGE,
  isAgentTankMode,
  isPlanMutationTool,
  parseToolCallsFromText,
  planChecklistProgress,
  planHasOpenWork,
  PLAN_CONTINUE_NUDGE,
  sanitizeProviderMessagesInPlace,
  TEST_CONTINUE_NUDGE,
  productPhaseForState,
  tryParsePartialJson,
  TurnStateMachine,
} from "./state.js";
import {
  maybeCompactProviderMessages,
  refreshSystemMessage,
  triggerTokensForContextWindow,
} from "./compaction.js";

function isTankMode(state: SessionState): boolean {
  return isAgentTankMode(state);
}

const GATE_EDIT_TOOLS = new Set(["write_file", "replace_in_file"]);

/**
 * Evidence the gate itself told the agent to fetch. Pulling a piece of it for
 * the first time is the work we asked for, not thrash — a failed e2e suite
 * costs a report, the failed titles, a log chunk and a screenshot before any
 * edit can be justified.
 */
const GATE_EVIDENCE_TOOLS = new Set([
  "get_test_report",
  "list_failed_tests",
  "read_test_log",
  "read_image",
]);

/** Per-turn thrash budget for the Check/Test fix tank. */
export type GateFixBudget = {
  roundsWithoutEdit: number;
  /** Evidence already fetched this turn, so re-reading it counts as thrash. */
  evidenceSeen: Set<string>;
  evidenceRoundsLeft: number;
};

export function newGateFixBudget(): GateFixBudget {
  return {
    roundsWithoutEdit: 0,
    evidenceSeen: new Set(),
    evidenceRoundsLeft: MAX_GATE_EVIDENCE_ROUNDS,
  };
}

/** One round of the tank: the executed batch, or null when the model only narrated. */
export type GateFixRound = {
  toolCalls: ToolCall[];
  results: ToolResult[];
} | null;

function batchHadSuccessfulEdit(
  toolCalls: ToolCall[],
  batchResults: ToolResult[],
): boolean {
  const byId = new Map(batchResults.map((r) => [r.callId, r]));
  for (const call of toolCalls) {
    if (!GATE_EDIT_TOOLS.has(call.name)) continue;
    if (byId.get(call.id)?.success) return true;
  }
  return false;
}

function evidenceKey(call: ToolCall): string {
  const args = call.arguments ?? {};
  const stable = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("&");
  return `${call.name}(${stable})`;
}

/** Evidence keys this batch fetched successfully and had not fetched before. */
function freshEvidenceKeys(
  toolCalls: ToolCall[],
  batchResults: ToolResult[],
  seen: Set<string>,
): string[] {
  const byId = new Map(batchResults.map((r) => [r.callId, r]));
  const fresh: string[] = [];
  for (const call of toolCalls) {
    if (!GATE_EVIDENCE_TOOLS.has(call.name)) continue;
    if (!byId.get(call.id)?.success) continue;
    const key = evidenceKey(call);
    if (seen.has(key) || fresh.includes(key)) continue;
    fresh.push(key);
  }
  return fresh;
}

/**
 * Detect read/report-only thrash during Check/Test fix tank.
 * Opens the circuit so the session does not auto-rekick forever.
 */
export function noteGateFixRound(
  state: SessionState,
  budget: GateFixBudget,
  round: GateFixRound,
): { stop: boolean; budget: GateFixBudget; state: SessionState } {
  const phase = productPhaseForState(state);
  if (phase !== "checking" && phase !== "testing") {
    return { stop: false, budget: newGateFixBudget(), state };
  }
  if (!isTankMode(state)) {
    return { stop: false, budget: newGateFixBudget(), state };
  }
  if (round && batchHadSuccessfulEdit(round.toolCalls, round.results)) {
    return { stop: false, budget: { ...budget, roundsWithoutEdit: 0 }, state };
  }
  const fresh = round
    ? freshEvidenceKeys(round.toolCalls, round.results, budget.evidenceSeen)
    : [];
  if (fresh.length > 0 && budget.evidenceRoundsLeft > 0) {
    const evidenceSeen = new Set(budget.evidenceSeen);
    for (const key of fresh) evidenceSeen.add(key);
    return {
      stop: false,
      budget: {
        ...budget,
        evidenceSeen,
        evidenceRoundsLeft: budget.evidenceRoundsLeft - 1,
      },
      state,
    };
  }
  const roundsWithoutEdit = budget.roundsWithoutEdit + 1;
  if (roundsWithoutEdit < MAX_GATE_FIX_ROUNDS_WITHOUT_EDIT) {
    return { stop: false, budget: { ...budget, roundsWithoutEdit }, state };
  }
  const label = phase === "checking" ? "Check" : "Test";
  const notice: Turn = {
    id: randomUUID(),
    role: "assistant",
    content: `**Build paused** · ${label} fix loop stalled (no file edits in ${roundsWithoutEdit} rounds, after reading the gate evidence). Press **Resume · Enter** when you want to continue.`,
    createdAt: new Date().toISOString(),
  };
  return {
    stop: true,
    budget: { ...budget, roundsWithoutEdit },
    state: {
      ...state,
      testGateCircuitOpen: true,
      testGateCircuitReason: "stalled",
      turns: [...state.turns, notice],
    },
  };
}

function buildToolExecutionContext(
  baseCtx: Partial<ToolExecutionContext>,
  workingState: SessionState,
  extras?: { oneShotApprovedIds?: Set<string> },
): ToolExecutionContext {
  if (
    !baseCtx.workspaceRoot ||
    !baseCtx.fs ||
    !baseCtx.git ||
    !baseCtx.checkpoint
  ) {
    throw new Error("Tool context incomplete");
  }
  return {
    workspaceRoot: baseCtx.workspaceRoot,
    mode: workingState.mode,
    grants: workingState.approvalGrants,
    fs: baseCtx.fs,
    git: baseCtx.git,
    checkpoint: baseCtx.checkpoint,
    audit: baseCtx.audit ?? (() => undefined),
    redact: baseCtx.redact ?? defaultRedact,
    approvedCategories: baseCtx.approvedCategories ?? new Set(),
    ...(extras?.oneShotApprovedIds
      ? { oneShotApprovedIds: extras.oneShotApprovedIds }
      : {}),
    ...(baseCtx.terminals ? { terminals: baseCtx.terminals } : {}),
    ...(baseCtx.ask ? { ask: baseCtx.ask } : {}),
    ...(baseCtx.cbm ? { cbm: baseCtx.cbm } : {}),
    ...(baseCtx.humanSetup ? { humanSetup: baseCtx.humanSetup } : {}),
    ...(baseCtx.notice ? { notice: baseCtx.notice } : {}),
    ...(baseCtx.testLogs ? { testLogs: baseCtx.testLogs } : {}),
    ...(baseCtx.testGate ? { testGate: baseCtx.testGate } : {}),
    ...(baseCtx.attachments ? { attachments: baseCtx.attachments } : {}),
  };
}

/**
 * True when this batch opened a blocking human-setup checklist.
 *
 * The turn must end here: the missing answer is a human creating an account or
 * pasting a connection string, and no further round of thinking can produce it.
 * Without this stop the model keeps narrating the same blocker and re-reading the
 * same env files until the stall detector trips — which is exactly the loop
 * request_human_setup exists to break.
 *
 * `allSatisfied` declarations do not stop anything: the values turned out to be
 * there already, so the agent should carry on with the real work.
 */
/** Shown when the model stopped on the checklist without writing a closing line. */
export const HUMAN_SETUP_WAIT_NOTICE =
  "Waiting on the setup checklist above — those values can only come from you. I stopped here instead of retrying the gate.";

export function declaredBlockingHumanSetup(
  calls: Array<{ id: string; name: string }>,
  results: ToolResult[],
): boolean {
  const ids = new Set(
    calls
      .filter((call) => call.name === "request_human_setup")
      .map((call) => call.id),
  );
  if (ids.size === 0) return false;
  return results.some((result) => {
    if (!ids.has(result.callId) || !result.success) return false;
    const output = result.output as
      | { declared?: unknown; allSatisfied?: unknown }
      | undefined;
    return output?.declared === true && output.allSatisfied !== true;
  });
}

export const NOTICE_WAIT_LINE =
  "Stopped so you can see the banner above — I will not keep going as if nothing happened.";

export function declaredBlockingNotice(
  calls: Array<{ id: string; name: string }>,
  results: ToolResult[],
): boolean {
  const ids = new Set(
    calls.filter((call) => call.name === "post_notice").map((call) => call.id),
  );
  if (ids.size === 0) return false;
  return results.some((result) => {
    if (!ids.has(result.callId) || !result.success) return false;
    const output = result.output as
      | { posted?: unknown; blocking?: unknown }
      | undefined;
    return output?.posted === true && output.blocking === true;
  });
}

/** Attach image_url parts to the latest user message (current turn only). */
function attachVisionToLatestUserMessage(
  messages: ChatMessage[],
  visionImages: Array<{ mime: string; dataBase64: string }> | undefined,
): void {
  if (!visionImages?.length) return;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return;
  const msg = messages[lastUserIdx]!;
  if (msg.role !== "user") return;
  const text = chatContentText(msg.content);
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const img of visionImages) {
    const mime = img.mime || "image/png";
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${img.dataBase64}` },
    });
  }
  messages[lastUserIdx] = { role: "user", content: parts };
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
  stateLike: SessionState,
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
  const phase = productPhaseForState(workingState);
  const planning = phase === "planning";
  const checking = phase === "checking";
  const testing = phase === "testing";
  const { done, total } = planChecklistProgress(workingState);
  const open = Math.max(0, total - done);
  const label = planning
    ? `Tank · planning · go ${nextRound}`
    : checking
      ? `Tank · check · go ${nextRound}`
      : testing
        ? `Tank · testing · go ${nextRound}`
        : `Tank · ${done}/${total} done · ${open} open · go ${nextRound}`;
  let state = workingState;
  if (nextRound === 1 || nextRound % 5 === 0) {
    const notice: Turn = {
      id: randomUUID(),
      role: "assistant",
      content: planning
        ? `**Tank mode** · planning still open — upsert_plan / questions / propose_plan_ready (round ${nextRound})…`
        : checking
          ? `**Tank mode** · check — get_test_report / fix baseline failures (round ${nextRound})…`
          : testing
            ? `**Tank mode** · testing — get_test_report / fix failures (round ${nextRound})…`
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
  // Drop bloated history only via token-triggered summarization (prepareMessagesForProvider).
  // Here: refresh plan/system and append the continue nudge.
  refreshSystemMessage(messages, state);
  messages.push({
    role: "user",
    content: planning
      ? PLAN_CONTINUE_NUDGE
      : checking
        ? CHECK_CONTINUE_NUDGE
        : testing
          ? TEST_CONTINUE_NUDGE
          : CHECKLIST_CONTINUE_NUDGE,
  });
  return { state, tankRounds: nextRound };
}

/** Keep in sync with `isContextOverflowError` in `@ai-ide/provider`. */
function looksLikeContextOverflow(error: {
  userMessage?: string;
  technicalDetail?: string | null;
}): boolean {
  const t = `${error.userMessage ?? ""}\n${error.technicalDetail ?? ""}`.toLowerCase();
  if (!t.trim()) return false;
  if (t.includes("tokens to keep from the initial prompt")) return true;
  if (t.includes("n_keep") && t.includes("context")) return true;
  if (t.includes("greater than the context length")) return true;
  if (t.includes("context_length_exceeded")) return true;
  if (t.includes("maximum context length") || t.includes("max context length")) {
    return true;
  }
  if (t.includes("exceeds the context") || t.includes("exceeds context length")) {
    return true;
  }
  if (t.includes("context length exceeded")) return true;
  if (t.includes("prompt is too long") || t.includes("prompt too long")) {
    return true;
  }
  if (t.includes("please reduce the length of the messages")) return true;
  if (t.includes("this model's maximum context")) return true;
  if (t.includes("loaded context is too small")) return true;
  return false;
}

/**
 * Refresh system prompt every round; summarize+compact only near the token trigger
 * (Cursor-style), instead of sliding-window truncating every tank iteration.
 */
async function prepareMessagesForProvider(
  messages: ChatMessage[],
  state: SessionState,
  deps: {
    provider: AiProvider;
    signal?: AbortSignal;
    workspaceRoot?: string | null;
    lastInputTokens?: number;
    contextWindowTokens?: number | null;
    emit: (event: AgentProgressEvent) => void;
    /** Compact even when the live body is still under the char floor. */
    force?: boolean;
  },
): Promise<SessionState> {
  const phase = productPhaseForState(state);
  const shouldConsider =
    isTankMode(state) ||
    phase === "building" ||
    phase === "checking" ||
    phase === "testing" ||
    phase === "planning";
  if (!shouldConsider) {
    refreshSystemMessage(messages, state);
    sanitizeProviderMessagesInPlace(messages);
    return state;
  }

  const result = await maybeCompactProviderMessages({
    messages,
    state,
    provider: deps.provider,
    ...(deps.workspaceRoot !== undefined
      ? { workspaceRoot: deps.workspaceRoot }
      : {}),
    ...(typeof deps.lastInputTokens === "number"
      ? { lastInputTokens: deps.lastInputTokens }
      : {}),
    ...(typeof deps.contextWindowTokens === "number"
      ? { contextWindowTokens: deps.contextWindowTokens }
      : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.force === true ? { force: true } : {}),
  });
  if (result.compacted) {
    messages.length = 0;
    messages.push(...result.messages);
    const trigger = triggerTokensForContextWindow(deps.contextWindowTokens);
    deps.emit({
      type: "activity",
      label:
        result.method === "summary"
          ? `Context compacted (summary · trigger ~${trigger.toLocaleString()})…`
          : "Context compacted (tail)…",
      status: "thinking",
    });
    deps.emit({
      type: "session_patch",
      patch: {
        contextSummary: result.state.contextSummary,
        contextCompactionCount: result.state.contextCompactionCount,
        agentHistoryPath: result.state.agentHistoryPath,
      },
    });
  }
  refreshSystemMessage(messages, result.state);
  sanitizeProviderMessagesInPlace(messages);
  return result.state;
}

export type AgentProgressEvent =
  | { type: "activity"; label: string; status: SessionState["status"] }
  | { type: "token"; text: string }
  /** Chain of thought so far for the whole turn, not just the current round. */
  | { type: "reasoning"; text: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      /** Part of inputTokens the provider served from its prompt cache. */
      cachedInputTokens?: number;
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
          | "contextSummary"
          | "contextCompactionCount"
          | "agentHistoryPath"
          | "testGateCircuitOpen"
          | "testGateCircuitReason"
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
  /** Vision for the current user message only (not re-sent on later turns). */
  visionImages?: Array<{ mime: string; dataBase64: string }>;
  /** Active provider context window (tokens) for compaction trigger. */
  contextWindowTokens?: number | null;
};

/** In-memory snapshot so Approve can resume the tool loop. */
export type PausedAgentTurn = {
  approvalId: string;
  messages: ChatMessage[];
  assistantContent: string;
  /** Chain of thought so far, so resuming does not lose the first rounds. */
  assistantReasoning: string;
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
  let gateFixBudget = newGateFixBudget();

  let workingState: SessionState = { ...state };
  const registry = createDefaultRegistry();
  const gateway = deps.gateway ?? new ToolGateway(registry);
  let lastInputTokens = 0;

  const toolDefsFor = (stateLike: SessionState) =>
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
  attachVisionToLatestUserMessage(messages, deps.visionImages);

  let assistantContent = "";
  let assistantReasoning = "";
  const toolResults: ToolResult[] = [];
  const allToolCalls: ToolCall[] = [];
  const workspaceRoot =
    workingState.workspace?.resolvedRootPath ??
    workingState.workspace?.rootPath ??
    deps.toolCtx?.workspaceRoot ??
    null;

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
    let roundReasoning = "";
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean }
    >();
    let streamedThisRound = false;
    let lastProvisionalEmit = 0;

    workingState = await prepareMessagesForProvider(messages, workingState, {
      provider: deps.provider,
      workspaceRoot,
      lastInputTokens,
      emit,
      ...(typeof deps.contextWindowTokens === "number"
        ? { contextWindowTokens: deps.contextWindowTokens }
        : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    let overflowRetryUsed = false;
    let retryForOverflow = false;
    do {
      if (retryForOverflow) {
        emit({
          type: "activity",
          label: "Prompt exceeds model context — compacting…",
          status: "thinking",
        });
        workingState = await prepareMessagesForProvider(messages, workingState, {
          provider: deps.provider,
          workspaceRoot,
          lastInputTokens,
          emit,
          force: true,
          ...(typeof deps.contextWindowTokens === "number"
            ? { contextWindowTokens: deps.contextWindowTokens }
            : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        roundContent = "";
        roundReasoning = "";
        pendingToolCalls.clear();
        streamedThisRound = false;
        lastProvisionalEmit = 0;
        overflowRetryUsed = true;
        retryForOverflow = false;
      }
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
      if (chunk.type === "reasoning") {
        roundReasoning += chunk.delta;
        // Rounds are an implementation detail of the tool loop, so the reader
        // gets one continuous train of thought for the whole turn.
        assistantReasoning += chunk.delta;
        emit({ type: "reasoning", text: assistantReasoning });
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
        if (!overflowRetryUsed && looksLikeContextOverflow(chunk.error)) {
          retryForOverflow = true;
          break;
        }
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
        if (chunk.usage.inputTokens > 0) {
          lastInputTokens = chunk.usage.inputTokens;
        }
        emit({
          type: "usage",
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          ...(chunk.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: chunk.usage.cachedInputTokens }
            : {}),
        });
      }
    }
    } while (retryForOverflow);

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
      if (roundContent.trim() || roundReasoning.trim()) {
        messages.push({
          role: "assistant",
          content: roundContent || null,
          ...(roundReasoning
            ? { reasoning_content: roundReasoning }
            : {}),
        });
      }
      if (isTankMode(workingState)) {
        const thrash = noteGateFixRound(workingState, gateFixBudget, null);
        gateFixBudget = thrash.budget;
        workingState = thrash.state;
        if (thrash.stop) {
          if (thrash.state.testGateCircuitOpen) {
            emit({
              type: "session_patch",
              patch: {
                testGateCircuitOpen: true,
                testGateCircuitReason: "stalled",
              },
            });
          }
          machine.complete();
          break;
        }
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
      ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
    });

    let stop = false;
    const batchStart = toolResults.length;
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

      const ctx = buildToolExecutionContext(baseCtx, workingState);

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
            partialReasoningText: null,
            activityLabel: "Waiting for approval…",
            liveTools: [],
          }),
          assistantContent,
          toolResults,
          pause: {
            approvalId: outcome.approvalId,
            messages: [...messages],
            assistantContent,
            assistantReasoning,
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
        // Pixels stay out of SessionState; the provider decides the wire shape.
        ...(outcome.images?.length ? { images: outcome.images } : {}),
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

    if (declaredBlockingHumanSetup(toolCalls, toolResults.slice(batchStart))) {
      if (!assistantContent.trim()) {
        assistantContent = HUMAN_SETUP_WAIT_NOTICE;
      }
      machine.complete();
      break;
    }
    if (declaredBlockingNotice(toolCalls, toolResults.slice(batchStart))) {
      if (!assistantContent.trim()) {
        assistantContent = NOTICE_WAIT_LINE;
      }
      machine.complete();
      break;
    }

    {
      const thrash = noteGateFixRound(workingState, gateFixBudget, {
        toolCalls,
        results: toolResults.slice(batchStart),
      });
      gateFixBudget = thrash.budget;
      workingState = thrash.state;
      if (thrash.stop) {
        if (thrash.state.testGateCircuitOpen) {
          emit({
            type: "session_patch",
            patch: {
              testGateCircuitOpen: true,
              testGateCircuitReason: "stalled",
            },
          });
        }
        machine.complete();
        break;
      }
    }

    emit({ type: "activity", label: "Thinking…", status: "thinking" });
  }

  machine.complete();

  const assistantTurn: Turn = {
    id: randomUUID(),
    role: "assistant",
    content: assistantContent || "(no response)",
    ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
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
      partialReasoningText: null,
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
    case "replace_in_file":
      return path ? `Editing ${path}…` : "Editing file…";
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
    case "web_fetch": {
      const url =
        typeof call.arguments.url === "string" ? call.arguments.url : null;
      return url
        ? `Fetching ${url.length > 48 ? `${url.slice(0, 45)}…` : url}…`
        : "Fetching URL…";
    }
    case "web_search":
      return query
        ? `Web search “${query.length > 48 ? `${query.slice(0, 45)}…` : query}”…`
        : "Searching the web…";
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
  if (!interrupted) {
    if (productPhaseForState(state) === "building" && planHasOpenWork(state)) {
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
    } else {
      // Every other phase needs this too. The error banner lives above a long
      // scroll and the Resume banner has phase-specific conditions, so without a
      // turn at the end of the transcript a failed turn looks like the agent
      // simply chose to stop talking.
      turns.push({
        id: randomUUID(),
        role: "assistant",
        content: [
          "**Stopped** · the turn ended on an error.",
          "",
          message,
          "",
          "Press **Resume · Enter** when you want to continue.",
        ].join("\n"),
        createdAt: new Date().toISOString(),
      });
    }
  }
  return {
    state: bumpSessionSequence({
      ...state,
      status: "error",
      error: message,
      turns,
      partialAssistantText: null,
      partialReasoningText: null,
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
  let gateFixBudget = newGateFixBudget();
  const registry = createDefaultRegistry();
  const gateway = deps.gateway ?? new ToolGateway(registry);

  const toolDefsFor = (stateLike: SessionState) =>
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
  let assistantReasoning = pause.assistantReasoning;
  const toolResults: ToolResult[] = [...pause.toolResults];
  const allToolCalls: ToolCall[] = [...pause.allToolCalls];
  const userMessage = pause.userMessage;
  const baseCtx = deps.toolCtx;
  const oneShot = new Set<string>([deps.approvedCallId]);
  let lastInputTokens = 0;
  const workspaceRoot =
    workingState.workspace?.resolvedRootPath ??
    workingState.workspace?.rootPath ??
    deps.toolCtx?.workspaceRoot ??
    null;

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

    const ctx = buildToolExecutionContext(baseCtx, workingState, {
      oneShotApprovedIds: oneShot,
    });

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
          partialReasoningText: null,
          activityLabel: "Waiting for approval…",
          liveTools: [],
        }),
        assistantContent,
        toolResults,
        pause: {
          approvalId: outcome.approvalId,
          messages: [...messages],
          assistantContent,
          assistantReasoning,
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
      // Same as the unattended path: pixels stay out of SessionState, and an
      // approved screenshot is worthless if the model never sees it.
      ...(outcome.images?.length ? { images: outcome.images } : {}),
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
    let roundReasoning = "";
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string; started: boolean }
    >();
    let streamedThisRound = false;

    workingState = await prepareMessagesForProvider(messages, workingState, {
      provider: deps.provider,
      workspaceRoot,
      lastInputTokens,
      emit,
      ...(typeof deps.contextWindowTokens === "number"
        ? { contextWindowTokens: deps.contextWindowTokens }
        : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    let overflowRetryUsed = false;
    let retryForOverflow = false;
    do {
      if (retryForOverflow) {
        emit({
          type: "activity",
          label: "Prompt exceeds model context — compacting…",
          status: "thinking",
        });
        workingState = await prepareMessagesForProvider(messages, workingState, {
          provider: deps.provider,
          workspaceRoot,
          lastInputTokens,
          emit,
          force: true,
          ...(typeof deps.contextWindowTokens === "number"
            ? { contextWindowTokens: deps.contextWindowTokens }
            : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
        roundContent = "";
        roundReasoning = "";
        pendingToolCalls.clear();
        streamedThisRound = false;
        overflowRetryUsed = true;
        retryForOverflow = false;
      }
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
      if (chunk.type === "reasoning") {
        roundReasoning += chunk.delta;
        // Rounds are an implementation detail of the tool loop, so the reader
        // gets one continuous train of thought for the whole turn.
        assistantReasoning += chunk.delta;
        emit({ type: "reasoning", text: assistantReasoning });
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
        if (!overflowRetryUsed && looksLikeContextOverflow(chunk.error)) {
          retryForOverflow = true;
          break;
        }
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
        if (chunk.usage.inputTokens > 0) {
          lastInputTokens = chunk.usage.inputTokens;
        }
        emit({
          type: "usage",
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          ...(chunk.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: chunk.usage.cachedInputTokens }
            : {}),
        });
      }
    }
    } while (retryForOverflow);

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
      if (roundContent.trim() || roundReasoning.trim()) {
        messages.push({
          role: "assistant",
          content: roundContent || null,
          ...(roundReasoning
            ? { reasoning_content: roundReasoning }
            : {}),
        });
      }
      if (isTankMode(workingState)) {
        const thrash = noteGateFixRound(workingState, gateFixBudget, null);
        gateFixBudget = thrash.budget;
        workingState = thrash.state;
        if (thrash.stop) {
          if (thrash.state.testGateCircuitOpen) {
            emit({
              type: "session_patch",
              patch: {
                testGateCircuitOpen: true,
                testGateCircuitReason: "stalled",
              },
            });
          }
          machine.complete();
          break;
        }
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
      ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
    });

    stop = false;
    const batchStart = toolResults.length;
    for (const call of toolCalls) {
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

      const ctx = buildToolExecutionContext(baseCtx, workingState, {
        oneShotApprovedIds: oneShot,
      });
      const outcome = await gateway.executeTool(call, ctx);
      if (outcome.status === "approval_required") {
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
            partialReasoningText: null,
            activityLabel: "Waiting for approval…",
            liveTools: [],
          }),
          assistantContent,
          toolResults,
          pause: {
            approvalId: outcome.approvalId,
            messages: [...messages],
            assistantContent,
            assistantReasoning,
            toolResults: [...toolResults],
            allToolCalls: [...allToolCalls],
            remainingCalls: [call],
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
        ...(outcome.images?.length ? { images: outcome.images } : {}),
      });
      if (!machine.recordToolResult(call.name, outcome.result.success, isTankMode(workingState))) {
        stop = true;
        break;
      }
    }

    if (declaredBlockingHumanSetup(toolCalls, toolResults.slice(batchStart))) {
      if (!assistantContent.trim()) {
        assistantContent = HUMAN_SETUP_WAIT_NOTICE;
      }
      machine.complete();
      break;
    }
    if (declaredBlockingNotice(toolCalls, toolResults.slice(batchStart))) {
      if (!assistantContent.trim()) {
        assistantContent = NOTICE_WAIT_LINE;
      }
      machine.complete();
      break;
    }

    if (isTankMode(workingState)) {
      const thrash = noteGateFixRound(workingState, gateFixBudget, {
        toolCalls,
        results: toolResults.slice(batchStart),
      });
      gateFixBudget = thrash.budget;
      workingState = thrash.state;
      if (thrash.stop) {
        if (thrash.state.testGateCircuitOpen) {
          emit({
            type: "session_patch",
            patch: {
              testGateCircuitOpen: true,
              testGateCircuitReason: "stalled",
            },
          });
        }
        machine.complete();
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
    ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
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
      partialReasoningText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
      pendingApprovals: [],
    }),
    assistantContent,
    toolResults,
  };
}
