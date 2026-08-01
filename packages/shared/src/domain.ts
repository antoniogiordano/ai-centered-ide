import { z } from "zod";

export const AgentModeSchema = z.enum(["ask", "plan", "agent", "autonomous"]);
export type AgentMode = z.infer<typeof AgentModeSchema>;

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

export const TurnSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolResults: z.array(ToolResultSchema).optional(),
  createdAt: z.string().datetime(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionStateSchema = z.object({
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  workspace: WorkspaceRefSchema.nullable(),
  mode: AgentModeSchema,
  turns: z.array(TurnSchema),
  /** @deprecated Prefer planPhases — kept for older persisted sessions. */
  planSteps: z.array(PlanStepSchema).default([]),
  planPhases: z.array(PlanPhaseSchema).default([]),
  planStatus: PlanStatusSchema.default("drafting"),
  planQuestions: z.array(PlanQuestionSchema).default([]),
  /** Set when the agent calls propose_plan_ready; cleared on start build. */
  planReadyProposal: PlanReadyProposalSchema.nullable().default(null),
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
    }),
  ),
  error: z.string().nullable(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * Product phase for a chat session.
 * Today: planning | building. Later: unit_test | qa | e2e, …
 */
export const ProductPhaseSchema = z.enum(["planning", "building"]);
export type ProductPhase = z.infer<typeof ProductPhaseSchema>;

export function deriveProductPhase(state: {
  mode?: string | null;
  planStatus?: string | null;
}): ProductPhase {
  if (state.mode === "plan" || state.planStatus === "drafting") {
    return "planning";
  }
  return "building";
}

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string().datetime(),
  workspaceName: z.string().nullable(),
  /** Plan / Build (per chat). Future phases will extend ProductPhase. */
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
    turns: [],
    planSteps: [],
    planPhases: [],
    planStatus: "drafting",
    planQuestions: [],
    planReadyProposal: null,
    pendingApprovals: [],
    approvalGrants: [],
    activeToolCallId: null,
    status: "idle",
    partialAssistantText: null,
    activityLabel: null,
    liveTools: [],
    error: null,
  };
}
