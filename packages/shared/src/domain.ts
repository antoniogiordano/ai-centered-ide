import { z } from "zod";
import { ProviderHudSchema } from "./providers.js";

export const AgentModeSchema = z.enum(["ask", "plan", "agent", "autonomous"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

/** delivery = plan/build chats; architecture = stack profile chat */
/** delivery chats follow plan→build. Legacy "architecture" chats coerce to delivery. */
export const SessionKindSchema = z.enum(["delivery", "architecture"]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const RiskLevelSchema = z.enum([
  "safe",
  "reversible",
  "sensitive",
  "destructive",
]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const WorkspaceRefSchema = z.object({
  projectId: z.string().min(1),
  rootPath: z.string().min(1),
  resolvedRootPath: z.string().min(1),
  name: z.string().min(1),
});
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "skipped", "failed"]),
  order: z.number().int().nonnegative(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanChecklistItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean(),
});
export type PlanChecklistItem = z.infer<typeof PlanChecklistItemSchema>;

export const PlanPhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed", "skipped", "failed"]),
  checklist: z.array(PlanChecklistItemSchema),
});
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;

export const PlanStatusSchema = z.enum(["drafting", "finalized", "executing"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

/** Agent proposes the plan is ready; user confirms in UI before Build mode. */
export const PlanReadyProposalSchema = z.object({
  suggestedBranch: z.string().min(1),
  summary: z.string().max(500).optional(),
  proposedAt: z.string().datetime(),
});
export type PlanReadyProposal = z.infer<typeof PlanReadyProposalSchema>;

/** Offer a local commit after the build checklist is fully done. */
export const BuildCommitOfferSchema = z.object({
  offeredAt: z.string().datetime(),
  branch: z.string().nullable(),
  /** Branch the feat work started from (Start Build base). */
  baseBranch: z.string().nullable().default(null),
  files: z.array(z.string()).default([]),
});
export type BuildCommitOffer = z.infer<typeof BuildCommitOfferSchema>;

/** After tests (+ optional commit): open a remote PR or merge locally into the start base. */
export const BuildIntegrateOfferSchema = z.object({
  offeredAt: z.string().datetime(),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
});
export type BuildIntegrateOffer = z.infer<typeof BuildIntegrateOfferSchema>;

export const TestSuiteKindSchema = z.enum([
  "lint",
  "typecheck",
  "unit",
  "e2e",
  "other",
]);
export type TestSuiteKind = z.infer<typeof TestSuiteKindSchema>;

/** Frozen command the IDE will run for the post-build test gate. */
export const TestRunSpecSchema = z.object({
  id: z.string().min(1),
  kind: TestSuiteKindSchema,
  command: z.string().min(1),
  /** Relative to workspace root; omit = root. */
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Detected runner/platform label (vitest, jest, eslint, tsc, cypress…). */
  platform: z.string().min(1).optional(),
});
export type TestRunSpec = z.infer<typeof TestRunSpecSchema>;

export const TestSuiteCountsSchema = z.object({
  passed: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
  /** Suite-file level counts when available (Jest "Test Suites:"). */
  suiteFilesPassed: z.number().int().nonnegative().optional(),
  suiteFilesFailed: z.number().int().nonnegative().optional(),
  suiteFilesTotal: z.number().int().nonnegative().optional(),
});
export type TestSuiteCounts = z.infer<typeof TestSuiteCountsSchema>;

export const TestSuiteResultSchema = z.object({
  id: z.string().min(1),
  kind: TestSuiteKindSchema,
  command: z.string().min(1),
  status: z.enum(["passed", "failed", "cancelled", "timed_out", "skipped"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  /** Short model-facing summary (not the full log). */
  summary: z.string(),
  logChars: z.number().int().nonnegative().default(0),
  logChunkSize: z.number().int().positive().default(8000),
  logChunks: z.number().int().nonnegative().default(0),
  /** Runner/platform when known (from architecture profile or log heuristics). */
  platform: z.string().min(1).optional(),
  /** Parsed pass/fail counts when the runner prints a summary. */
  counts: TestSuiteCountsSchema.optional(),
  /** Individual failed test titles (capped). */
  failedTests: z.array(z.string().min(1)).default([]),
});
export type TestSuiteResult = z.infer<typeof TestSuiteResultSchema>;

/** IDE-owned verification gate after build checklist completion. */
export const TestRunReportSchema = z.object({
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  status: z.enum(["running", "passed", "failed", "skipped"]),
  specs: z.array(TestRunSpecSchema).default([]),
  suites: z.array(TestSuiteResultSchema).default([]),
  digest: z.string().optional(),
});
export type TestRunReport = z.infer<typeof TestRunReportSchema>;

export const PlanQuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type PlanQuestionOption = z.infer<typeof PlanQuestionOptionSchema>;

export const PlanQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["open", "answered"]),
  /** single = A–Z keys; multiple = 1–9 keys + Enter. */
  selection: z.enum(["single", "multiple"]).default("single"),
  options: z.array(PlanQuestionOptionSchema).default([]),
  answer: z.string().optional(),
  selectedOptionIds: z.array(z.string()).optional(),
});
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()),
  riskLevel: RiskLevelSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  callId: z.string().min(1),
  success: z.boolean(),
  summary: z.string(),
  artifactRef: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ApprovalGrantSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;

/** Metadata shown in transcript / composer (no heavy payloads). */
export const AttachmentMetaSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["image", "file"]),
  name: z.string().min(1),
  path: z.string().optional(),
  mime: z.string().optional(),
  /** Small data URL for image thumbnails in the UI. */
  previewDataUrl: z.string().optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export const TurnSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolResults: z.array(ToolResultSchema).optional(),
  attachments: z.array(AttachmentMetaSchema).optional(),
  createdAt: z.string().datetime(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const LiveTerminalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["running", "exited"]),
  pid: z.number().int().nullable(),
  cwd: z.string().min(1),
  /** Tail of output for UI preview (full stream via terminal:subscribe). */
  lastOutput: z.string().default(""),
  exitCode: z.number().int().nullable().default(null),
});
export type LiveTerminal = z.infer<typeof LiveTerminalSchema>;

export const PendingTerminalConfirmSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string().min(1),
  /** Exact text that will be written if approved (may still append newline). */
  text: z.string(),
  appendNewline: z.boolean().default(true),
  deadlineAt: z.string().datetime(),
  durationMs: z.number().int().positive().default(3000),
});
export type PendingTerminalConfirm = z.infer<typeof PendingTerminalConfirmSchema>;

export const PendingTerminalAskSchema = z.object({
  id: z.string().min(1),
  terminalId: z.string().min(1),
  prompt: z.string().min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(2)
    .max(8),
  suggestedText: z.string().default(""),
  writeToTerminal: z.boolean().default(true),
  appendNewline: z.boolean().default(true),
});
export type PendingTerminalAsk = z.infer<typeof PendingTerminalAskSchema>;

export const SessionStateSchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  workspace: WorkspaceRefSchema.nullable(),
  mode: AgentModeSchema,
  /** delivery chats follow plan→build; architecture is a dedicated stack chat. */
  sessionKind: SessionKindSchema.default("delivery"),
  turns: z.array(TurnSchema),
  /** @deprecated Prefer planPhases — kept for older persisted sessions. */
  planSteps: z.array(PlanStepSchema).default([]),
  planPhases: z.array(PlanPhaseSchema).default([]),
  planStatus: PlanStatusSchema.default("drafting"),
  planQuestions: z.array(PlanQuestionSchema).default([]),
  /** Set when the agent calls propose_plan_ready; cleared on start build. */
  planReadyProposal: PlanReadyProposalSchema.nullable().default(null),
  /** Set when build checklist is complete; cleared on commit or dismiss. */
  buildCommitOffer: BuildCommitOfferSchema.nullable().default(null),
  /** After tests: offer remote PR or local merge into buildBaseBranch. */
  buildIntegrateOffer: BuildIntegrateOfferSchema.nullable().default(null),
  /**
   * Branch Start Build started from (feat fork base, or current if no new branch).
   * Used as default merge/PR target after the test gate.
   */
  buildBaseBranch: z.string().nullable().default(null),
  /** Last / in-flight post-build test gate (IDE-run). Full logs live in-process. */
  testRun: TestRunReportSchema.nullable().default(null),
  /**
   * Set when the agent calls propose_testing_ready after the checklist is done.
   * Cleared on Start Build / new build. Required before the IDE runs the test gate.
   */
  testingConfirmedAt: z.string().datetime().nullable().default(null),
  /** Set when the gate passed or was skipped; cleared when starting a new build. */
  testGatePassedAt: z.string().datetime().nullable().default(null),
  /**
   * Consecutive paid-provider auto-fix turns kicked by a failed test gate.
   * Reset on pass, Start Build, or manual Resume.
   */
  testGateAutoFixAttempts: z.number().int().nonnegative().default(0),
  /**
   * When true (paid provider only), the IDE stops auto-injecting test-gate
   * continue prompts until the user hits Resume.
   */
  testGateCircuitOpen: z.boolean().default(false),
  /** Fingerprint of the last failed gate (suite ids + error signal). */
  testGateFailureFingerprint: z.string().nullable().default(null),
  /** Consecutive gate failures with the same fingerprint. */
  testGateSameFailureStreak: z.number().int().nonnegative().default(0),
  /**
   * 0 = none, 1 = escalate strategy, 2 = strong (rewrite tests / oscillation).
   * Injected into the system prompt on the next fix turn.
   */
  testGateEscalationLevel: z.number().int().nonnegative().default(0),
  /** Recent failed-suite keys (e.g. "unit", "typecheck") for oscillation detection. */
  testGateRecentSuiteKeys: z.array(z.string()).default([]),
  pendingApprovals: z.array(
    z.object({
      id: z.string().min(1),
      toolCall: ToolCallSchema,
      description: z.string(),
      riskLevel: RiskLevelSchema,
    }),
  ),
  approvalGrants: z.array(ApprovalGrantSchema),
  activeToolCallId: z.string().nullable(),
  status: z.enum([
    "idle",
    "thinking",
    "streaming",
    "tool",
    "running",
    "awaiting_approval",
    "error",
  ]),
  /** Live assistant text while streaming (Cursor-style). */
  partialAssistantText: z.string().nullable(),
  /** Human-readable activity: "Thinking…", "Reading README.md…". */
  activityLabel: z.string().nullable(),
  /** In-flight / just-finished tools for the current turn (transcript rows). */
  liveTools: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      label: z.string().min(1),
      status: z.enum(["running", "done", "failed"]),
      summary: z.string().optional(),
      /** Tool arguments when known (for expandable log; may be partial while streaming). */
      arguments: z.record(z.unknown()).optional(),
      /** Full tool output for the IDE log (not compacted for the model). */
      output: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ),
  /** Interactive PTY sessions owned by the app (not persisted). */
  liveTerminals: z.array(LiveTerminalSchema).default([]),
  /** Soft-confirm for agent→terminal stdin (3s auto-approve). */
  pendingTerminalConfirm: PendingTerminalConfirmSchema.nullable().default(null),
  /** Exclusive Q&A when the agent needs a human decision for the terminal. */
  pendingTerminalAsk: PendingTerminalAskSchema.nullable().default(null),
  /** Active provider + token/cost counters for the chrome HUD. */
  providerHud: ProviderHudSchema.nullable().default(null),
  error: z.string().nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Product phase for a chat session.
 * planning | building | testing (post-build verification gate)
 */
export const ProductPhaseSchema = z.enum(["planning", "building", "testing"]);
export type ProductPhase = z.infer<typeof ProductPhaseSchema>;

export function deriveProductPhase(state: {
  mode?: string | null;
  planStatus?: string | null;
  sessionKind?: string | null;
  testRun?: { status?: string | null } | null;
  planPhases?: Array<{
    status: string;
    checklist: Array<{ done: boolean }>;
  }>;
  buildCommitOffer?: unknown | null;
  buildIntegrateOffer?: unknown | null;
}): ProductPhase {
  void state.sessionKind;
  if (state.mode === "plan" || state.planStatus === "drafting") {
    return "planning";
  }
  if (state.testRun?.status === "running") {
    return "testing";
  }
  // Checklist complete → Testing (await confirm, gate, or fix loop) until commit/PR offer.
  if (
    state.planStatus === "executing" &&
    Array.isArray(state.planPhases) &&
    state.planPhases.length > 0 &&
    !planHasOpenWork({ planPhases: state.planPhases }) &&
    !state.buildCommitOffer &&
    !state.buildIntegrateOffer
  ) {
    return "testing";
  }
  return "building";
}

/** Checklist done, agent has not confirmed testing yet — prompt for propose_testing_ready. */
export function awaitsTestingConfirm(state: {
  planStatus: string;
  planPhases: Array<{
    status: string;
    checklist: Array<{ done: boolean }>;
  }>;
  testingConfirmedAt?: string | null;
  testGatePassedAt?: string | null;
  buildCommitOffer?: unknown | null;
  buildIntegrateOffer?: unknown | null;
}): boolean {
  if (!planBuildComplete(state)) return false;
  if (state.testingConfirmedAt) return false;
  if (state.testGatePassedAt) return false;
  if (state.buildCommitOffer || state.buildIntegrateOffer) return false;
  return true;
}

/** IDE may start the post-build test gate. */
export function canStartTestGate(state: {
  planStatus: string;
  planPhases: Array<{
    status: string;
    checklist: Array<{ done: boolean }>;
  }>;
  testingConfirmedAt?: string | null;
  testGatePassedAt?: string | null;
  buildCommitOffer?: unknown | null;
}): boolean {
  if (!planBuildComplete(state)) return false;
  if (!state.testingConfirmedAt) return false;
  if (state.testGatePassedAt) return false;
  if (state.buildCommitOffer) return false;
  return true;
}

export function planHasOpenWork(state: {
  planPhases: Array<{
    status: string;
    checklist: Array<{ done: boolean }>;
  }>;
}): boolean {
  if (!state.planPhases.length) return false;
  return state.planPhases.some(
    (phase) =>
      phase.status === "pending" ||
      phase.status === "in_progress" ||
      phase.status === "failed" ||
      phase.checklist.some((item) => !item.done),
  );
}

/** True when an executing build plan has no remaining open work. */
export function planBuildComplete(state: {
  planStatus: string;
  planPhases: Array<{
    status: string;
    checklist: Array<{ done: boolean }>;
  }>;
}): boolean {
  if (state.planStatus !== "executing") return false;
  if (!state.planPhases.length) return false;
  return !planHasOpenWork(state);
}

export function planChecklistProgress(state: {
  planPhases: Array<{ checklist: Array<{ done: boolean }> }>;
}): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const phase of state.planPhases) {
    for (const item of phase.checklist) {
      total += 1;
      if (item.done) done += 1;
    }
  }
  return { done, total };
}

/** Composer / Continue button message when build stalls with open checklist. */
export const CHECKLIST_CONTINUE_USER_MESSAGE =
  "Continue: keep existing done checklist items as done=true (do not uncheck or redo from scratch). Prefer Focus → Next open item; if several items are already finished, upsert_plan may mark multiple done=true. Spot-check only if needed; do not only narrate.";

/** Resume planning when the agent stalled without a ready proposal or open Q&A. */
export const PLAN_CONTINUE_USER_MESSAGE =
  "Continue planning: use read_plan / add_phase / add_check / set_questions (prefer micro CRUD; upsert_plan only for a full rewrite). When the plan is solid and questions are cleared, call propose_plan_ready. Do not only narrate.";

/** Checklist complete — agent must confirm before the IDE Test gate runs. */
export const TESTING_READY_CONTINUE_USER_MESSAGE =
  "Testing phase: the build checklist is complete. Verify the work is finished (spot-check if needed), then call propose_testing_ready. Do not narrate only — the IDE will run lint/typecheck/unit after that tool. Do not run those suites yourself.";

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string().datetime(),
  workspaceName: z.string().nullable(),
  /** Plan / Build / Test (per chat). */
  phase: ProductPhaseSchema.default("planning"),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const AppErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "WORKSPACE_OUTSIDE",
  "PROVIDER_ERROR",
  "PROVIDER_TIMEOUT",
  "TOOL_DENIED",
  "TOOL_FAILED",
  "STORAGE_ERROR",
  "KEYCHAIN_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly technicalDetail: string;

  constructor(params: {
    code: AppErrorCode;
    userMessage: string;
    technicalDetail: string;
    cause?: unknown;
  }) {
    super(params.userMessage);
    this.name = "AppError";
    this.code = params.code;
    this.userMessage = params.userMessage;
    this.technicalDetail = params.technicalDetail;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}

/** Session / UI string: user message plus technical detail when useful. */
export function formatAppErrorDisplay(error: {
  userMessage: string;
  technicalDetail?: string | null;
}): string {
  const user = error.userMessage.trim();
  const detail = (error.technicalDetail ?? "").trim();
  if (!detail || detail === user) return user || "Unknown error.";
  if (user.includes(detail)) return user;
  const capped = detail.length > 1200 ? `${detail.slice(0, 1197)}…` : detail;
  return `${user}\n${capped}`;
}

export const AppErrorPayloadSchema = z.object({
  code: AppErrorCodeSchema,
  userMessage: z.string(),
  technicalDetail: z.string(),
});

export function createEmptySessionState(sessionId: string): SessionState {
  return {
    sessionId,
    sequence: 0,
    workspace: null,
    mode: "plan",
    sessionKind: "delivery",
    turns: [],
    planSteps: [],
    planPhases: [],
    planStatus: "drafting",
    planQuestions: [],
    planReadyProposal: null,
    buildCommitOffer: null,
    buildIntegrateOffer: null,
    buildBaseBranch: null,
    testRun: null,
    testingConfirmedAt: null,
    testGatePassedAt: null,
    testGateAutoFixAttempts: 0,
    testGateCircuitOpen: false,
    testGateFailureFingerprint: null,
    testGateSameFailureStreak: 0,
    testGateEscalationLevel: 0,
    testGateRecentSuiteKeys: [],
    pendingApprovals: [],
    approvalGrants: [],
    activeToolCallId: null,
    status: "idle",
    partialAssistantText: null,
    activityLabel: null,
    liveTools: [],
    liveTerminals: [],
    pendingTerminalConfirm: null,
    pendingTerminalAsk: null,
    providerHud: null,
    error: null,
  };
}
