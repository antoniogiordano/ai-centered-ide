import { z } from "zod";
import {
  AgentModeSchema,
  AppErrorPayloadSchema,
  SessionStateSchema,
  SessionSummarySchema,
  WorkspaceRefSchema,
} from "./domain.js";

export const IPC_CHANNELS = {
  SESSION_GET: "session:get",
  SESSION_SUBSCRIBE: "session:subscribe",
  SESSION_SEND_MESSAGE: "session:send-message",
  SESSION_SET_MODE: "session:set-mode",
  SESSION_APPROVE: "session:approve",
  SESSION_REJECT: "session:reject",
  SESSION_CANCEL: "session:cancel",
  SESSION_EXPORT_DIAGNOSTICS: "session:export-diagnostics",
  SESSION_LIST: "session:list",
  SESSION_CREATE: "session:create",
  SESSION_SWITCH: "session:switch",
  SESSION_CLOSE: "session:close",
  WORKSPACE_OPEN: "workspace:open",
  WORKSPACE_LIST_RECENT: "workspace:list-recent",
  WORKSPACE_GIT_STATUS: "workspace:git-status",
  WORKSPACE_LIST_BRANCHES: "workspace:list-branches",
  SESSION_CONFIRM_PLAN: "session:confirm-plan",
  PROVIDER_VERIFY: "provider:verify",
  PROVIDER_LIST_MODELS: "provider:list-models",
  PROVIDER_SAVE_CONFIG: "provider:save-config",
  PROVIDER_GET_CONFIG: "provider:get-config",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const SessionGetRequestSchema = z.object({});
export type SessionGetRequest = z.infer<typeof SessionGetRequestSchema>;

export const SessionGetResponseSchema = z.object({
  state: SessionStateSchema,
  sessions: z.array(SessionSummarySchema),
  activeSessionId: z.string(),
});
export type SessionGetResponse = z.infer<typeof SessionGetResponseSchema>;

export const SessionSubscribeRequestSchema = z.object({});
export type SessionSubscribeRequest = z.infer<
  typeof SessionSubscribeRequestSchema
>;

export const SessionUpdateEventSchema = z.object({
  state: SessionStateSchema,
  fullSync: z.boolean().default(false),
  sessions: z.array(SessionSummarySchema),
  activeSessionId: z.string(),
});
export type SessionUpdateEvent = z.infer<typeof SessionUpdateEventSchema>;

export const PlanAnswerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(20_000),
  selectedOptionIds: z.array(z.string()).optional(),
});
export type PlanAnswer = z.infer<typeof PlanAnswerSchema>;

export const SessionSendMessageRequestSchema = z.object({
  content: z.string().min(1).max(100_000),
  planAnswers: z.array(PlanAnswerSchema).optional(),
});
export type SessionSendMessageRequest = z.infer<
  typeof SessionSendMessageRequestSchema
>;

export const SessionSendMessageResponseSchema = z.object({
  accepted: z.boolean(),
  error: AppErrorPayloadSchema.optional(),
});
export type SessionSendMessageResponse = z.infer<
  typeof SessionSendMessageResponseSchema
>;

export const SessionSetModeRequestSchema = z.object({
  mode: AgentModeSchema,
});
export type SessionSetModeRequest = z.infer<typeof SessionSetModeRequestSchema>;

export const SessionSetModeResponseSchema = z.object({
  state: SessionStateSchema,
});
export type SessionSetModeResponse = z.infer<
  typeof SessionSetModeResponseSchema
>;

export const SessionApproveRequestSchema = z.object({
  approvalId: z.string().min(1),
  grantCategory: z.boolean().default(false),
});
export type SessionApproveRequest = z.infer<typeof SessionApproveRequestSchema>;

export const SessionRejectRequestSchema = z.object({
  approvalId: z.string().min(1),
  reason: z.string().optional(),
});
export type SessionRejectRequest = z.infer<typeof SessionRejectRequestSchema>;

export const SessionCancelRequestSchema = z.object({});
export type SessionCancelRequest = z.infer<typeof SessionCancelRequestSchema>;

export const SessionExportDiagnosticsRequestSchema = z.object({});
export type SessionExportDiagnosticsRequest = z.infer<
  typeof SessionExportDiagnosticsRequestSchema
>;

export const SessionListRequestSchema = z.object({});
export type SessionListRequest = z.infer<typeof SessionListRequestSchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema),
  activeSessionId: z.string(),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export const SessionCreateRequestSchema = z.object({});
export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

export const SessionCreateResponseSchema = z.object({
  state: SessionStateSchema,
  sessions: z.array(SessionSummarySchema),
  activeSessionId: z.string(),
});
export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>;

export const SessionSwitchRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionSwitchRequest = z.infer<typeof SessionSwitchRequestSchema>;

export const SessionSwitchResponseSchema = z.object({
  state: SessionStateSchema,
  sessions: z.array(SessionSummarySchema),
  activeSessionId: z.string(),
});
export type SessionSwitchResponse = z.infer<typeof SessionSwitchResponseSchema>;

export const SessionCloseRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type SessionCloseRequest = z.infer<typeof SessionCloseRequestSchema>;

export const SessionCloseResponseSchema = z.object({
  state: SessionStateSchema,
  sessions: z.array(SessionSummarySchema),
  activeSessionId: z.string(),
});
export type SessionCloseResponse = z.infer<typeof SessionCloseResponseSchema>;

export const WorkspaceOpenRequestSchema = z.object({
  path: z.string().min(1),
});
export type WorkspaceOpenRequest = z.infer<typeof WorkspaceOpenRequestSchema>;

export const WorkspaceOpenResponseSchema = z.object({
  workspace: WorkspaceRefSchema.nullable(),
  canceled: z.boolean().optional(),
});
export type WorkspaceOpenResponse = z.infer<typeof WorkspaceOpenResponseSchema>;

export const WorkspaceListRecentResponseSchema = z.object({
  workspaces: z.array(
    z.object({
      projectId: z.string(),
      rootPath: z.string(),
      name: z.string(),
      lastOpenedAt: z.string().datetime(),
    }),
  ),
});
export type WorkspaceListRecentResponse = z.infer<
  typeof WorkspaceListRecentResponseSchema
>;

export const WorkspaceGitStatusRequestSchema = z.object({});
export type WorkspaceGitStatusRequest = z.infer<
  typeof WorkspaceGitStatusRequestSchema
>;

export const WorkspaceGitStatusResponseSchema = z.object({
  isRepo: z.boolean(),
  localBranch: z.string().nullable(),
  remoteBranch: z.string().nullable(),
});
export type WorkspaceGitStatusResponse = z.infer<
  typeof WorkspaceGitStatusResponseSchema
>;

export const WorkspaceListBranchesRequestSchema = z.object({});
export type WorkspaceListBranchesRequest = z.infer<
  typeof WorkspaceListBranchesRequestSchema
>;

export const WorkspaceListBranchesResponseSchema = z.object({
  isRepo: z.boolean(),
  branches: z.array(z.string()),
  current: z.string().nullable(),
});
export type WorkspaceListBranchesResponse = z.infer<
  typeof WorkspaceListBranchesResponseSchema
>;

export const SessionConfirmPlanRequestSchema = z.object({
  createBranch: z.boolean(),
  branchName: z.string().min(1).max(80).optional(),
});
export type SessionConfirmPlanRequest = z.infer<
  typeof SessionConfirmPlanRequestSchema
>;

export const SessionConfirmPlanResponseSchema = z.object({
  ok: z.boolean(),
  state: SessionStateSchema.optional(),
  error: AppErrorPayloadSchema.optional(),
  branch: z.string().nullable().optional(),
});
export type SessionConfirmPlanResponse = z.infer<
  typeof SessionConfirmPlanResponseSchema
>;

export const ProviderVerifyRequestSchema = z.object({
  baseUrl: z.string().url(),
  /** Optional for local OpenAI-compatible servers (e.g. Ollama). */
  apiKey: z.string().default(""),
  model: z.string().min(1).optional(),
});
export type ProviderVerifyRequest = z.infer<typeof ProviderVerifyRequestSchema>;

export const ProviderVerifyResponseSchema = z.object({
  ok: z.boolean(),
  models: z.array(z.string()).optional(),
  error: AppErrorPayloadSchema.optional(),
});
export type ProviderVerifyResponse = z.infer<
  typeof ProviderVerifyResponseSchema
>;

export const ProviderListModelsRequestSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
});
export type ProviderListModelsRequest = z.infer<
  typeof ProviderListModelsRequestSchema
>;

export const ProviderListModelsResponseSchema = z.object({
  models: z.array(z.string()),
});
export type ProviderListModelsResponse = z.infer<
  typeof ProviderListModelsResponseSchema
>;

export const ProviderSaveConfigRequestSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
  defaultModel: z.string().min(1),
});
export type ProviderSaveConfigRequest = z.infer<
  typeof ProviderSaveConfigRequestSchema
>;

export const ProviderSaveConfigResponseSchema = z.object({
  saved: z.boolean(),
});
export type ProviderSaveConfigResponse = z.infer<
  typeof ProviderSaveConfigResponseSchema
>;

export const ProviderGetConfigRequestSchema = z.object({});
export type ProviderGetConfigRequest = z.infer<
  typeof ProviderGetConfigRequestSchema
>;

export const ProviderGetConfigResponseSchema = z.object({
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  apiKey: z.string().nullable(),
});
export type ProviderGetConfigResponse = z.infer<
  typeof ProviderGetConfigResponseSchema
>;

export const IpcRequestSchemas = {
  [IPC_CHANNELS.SESSION_GET]: SessionGetRequestSchema,
  [IPC_CHANNELS.SESSION_SUBSCRIBE]: SessionSubscribeRequestSchema,
  [IPC_CHANNELS.SESSION_SEND_MESSAGE]: SessionSendMessageRequestSchema,
  [IPC_CHANNELS.SESSION_SET_MODE]: SessionSetModeRequestSchema,
  [IPC_CHANNELS.SESSION_APPROVE]: SessionApproveRequestSchema,
  [IPC_CHANNELS.SESSION_REJECT]: SessionRejectRequestSchema,
  [IPC_CHANNELS.SESSION_CANCEL]: SessionCancelRequestSchema,
  [IPC_CHANNELS.SESSION_EXPORT_DIAGNOSTICS]: SessionExportDiagnosticsRequestSchema,
  [IPC_CHANNELS.SESSION_LIST]: SessionListRequestSchema,
  [IPC_CHANNELS.SESSION_CREATE]: SessionCreateRequestSchema,
  [IPC_CHANNELS.SESSION_SWITCH]: SessionSwitchRequestSchema,
  [IPC_CHANNELS.SESSION_CLOSE]: SessionCloseRequestSchema,
  [IPC_CHANNELS.WORKSPACE_OPEN]: WorkspaceOpenRequestSchema,
  [IPC_CHANNELS.WORKSPACE_GIT_STATUS]: WorkspaceGitStatusRequestSchema,
  [IPC_CHANNELS.WORKSPACE_LIST_BRANCHES]: WorkspaceListBranchesRequestSchema,
  [IPC_CHANNELS.SESSION_CONFIRM_PLAN]: SessionConfirmPlanRequestSchema,
  [IPC_CHANNELS.PROVIDER_VERIFY]: ProviderVerifyRequestSchema,
  [IPC_CHANNELS.PROVIDER_LIST_MODELS]: ProviderListModelsRequestSchema,
  [IPC_CHANNELS.PROVIDER_SAVE_CONFIG]: ProviderSaveConfigRequestSchema,
  [IPC_CHANNELS.PROVIDER_GET_CONFIG]: ProviderGetConfigRequestSchema,
} as const;

export type IpcRequestChannel = keyof typeof IpcRequestSchemas;

export function validateIpcRequest<T extends keyof typeof IpcRequestSchemas>(
  channel: T,
  payload: unknown,
): z.infer<(typeof IpcRequestSchemas)[T]> {
  return IpcRequestSchemas[channel].parse(payload) as z.infer<
    (typeof IpcRequestSchemas)[T]
  >;
}
