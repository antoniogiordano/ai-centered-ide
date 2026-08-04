import { z } from "zod";
import {
  AgentModeSchema,
  AppErrorPayloadSchema,
  LiveTerminalSchema,
  SessionStateSchema,
  SessionSummarySchema,
  WorkspaceRefSchema,
} from "./domain.js";
import {
  ArchitectureProfilePatchSchema,
  ArchitectureProfileSchema,
} from "./architecture.js";

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
  SESSION_TERMINAL_CONFIRM: "session:terminal-confirm",
  SESSION_TERMINAL_CONFIRM_EDIT: "session:terminal-confirm-edit",
  SESSION_TERMINAL_ASK: "session:terminal-ask",
  TERMINAL_SUBSCRIBE: "terminal:subscribe",
  TERMINAL_LIST: "terminal:list",
  TERMINAL_WRITE_USER: "terminal:write-user",
  TERMINAL_RESIZE: "terminal:resize",
  ENGINE_STATUS: "engine:status",
  ENGINE_SUBSCRIBE: "engine:subscribe",
  ENGINE_ENSURE: "engine:ensure",
  ENGINE_INDEX: "engine:index",
  ENGINE_INDEX_CANCEL: "engine:index-cancel",
  ENGINE_INDEX_REFRESH: "engine:index-refresh",
  ENGINE_STDERR: "engine:stderr",
  WORKSPACE_OPEN: "workspace:open",
  WORKSPACE_PICK_DIRECTORY: "workspace:pick-directory",
  WORKSPACE_CREATE_PROJECT: "workspace:create-project",
  WORKSPACE_LIST_RECENT: "workspace:list-recent",
  WORKSPACE_GIT_STATUS: "workspace:git-status",
  WORKSPACE_LIST_BRANCHES: "workspace:list-branches",
  WORKSPACE_ARCHITECTURE_GET: "workspace:architecture-get",
  WORKSPACE_ARCHITECTURE_SAVE: "workspace:architecture-save",
  WORKSPACE_ARCHITECTURE_DETECT: "workspace:architecture-detect",
  SESSION_CONFIRM_PLAN: "session:confirm-plan",
  PROVIDER_VERIFY: "provider:verify",
  PROVIDER_LIST_MODELS: "provider:list-models",
  PROVIDER_SAVE_CONFIG: "provider:save-config",
  PROVIDER_GET_CONFIG: "provider:get-config",
  GITHUB_STATUS: "github:status",
  GITHUB_LOGOUT: "github:logout",
  GITHUB_LOGIN_WEB: "github:login-web",
  GITHUB_LOGIN_TOKEN: "github:login-token",
  GITHUB_LOGIN_CANCEL: "github:login-cancel",
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

export const SessionTerminalConfirmRequestSchema = z.object({
  confirmId: z.string().min(1),
  action: z.enum(["approve", "cancel"]),
  /** Exact text to send when approving (defaults to pending text). */
  text: z.string().optional(),
});
export type SessionTerminalConfirmRequest = z.infer<
  typeof SessionTerminalConfirmRequestSchema
>;

export const SessionTerminalConfirmEditRequestSchema = z.object({
  confirmId: z.string().min(1),
  text: z.string(),
});
export type SessionTerminalConfirmEditRequest = z.infer<
  typeof SessionTerminalConfirmEditRequestSchema
>;

export const SessionTerminalAskRequestSchema = z.object({
  askId: z.string().min(1),
  selectedOptionId: z.string().nullable().optional(),
  text: z.string(),
  cancelled: z.boolean().default(false),
});
export type SessionTerminalAskRequest = z.infer<
  typeof SessionTerminalAskRequestSchema
>;

export const TerminalDataEventSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
  sequence: z.number().int().nonnegative(),
});
export type TerminalDataEvent = z.infer<typeof TerminalDataEventSchema>;

export const TerminalSubscribeRequestSchema = z.object({});
export type TerminalSubscribeRequest = z.infer<
  typeof TerminalSubscribeRequestSchema
>;

export const TerminalListRequestSchema = z.object({});
export type TerminalListRequest = z.infer<typeof TerminalListRequestSchema>;

export const TerminalListResponseSchema = z.object({
  terminals: z.array(LiveTerminalSchema),
});
export type TerminalListResponse = z.infer<typeof TerminalListResponseSchema>;

export const TerminalWriteUserRequestSchema = z.object({
  terminalId: z.string().min(1),
  text: z.string(),
});
export type TerminalWriteUserRequest = z.infer<
  typeof TerminalWriteUserRequestSchema
>;

export const TerminalResizeRequestSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;

export const EnginePhaseSchema = z.enum([
  "unsupported",
  "missing",
  "downloading",
  "ready",
  "starting",
  "indexing",
  "indexed",
  "error",
]);
export type EnginePhase = z.infer<typeof EnginePhaseSchema>;

export const EngineStatusSchema = z.object({
  version: z.string(),
  platformSupported: z.boolean(),
  phase: EnginePhaseSchema,
  binaryReady: z.boolean(),
  indexed: z.boolean(),
  projectName: z.string().nullable(),
  workspaceRoot: z.string().nullable(),
  downloadReceived: z.number().nonnegative(),
  downloadTotal: z.number().nullable(),
  indexMessage: z.string().nullable(),
  error: z.string().nullable(),
  architectureSummary: z.string().nullable(),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const EngineStatusRequestSchema = z.object({});
export type EngineStatusRequest = z.infer<typeof EngineStatusRequestSchema>;

export const EngineSubscribeRequestSchema = z.object({});
export type EngineSubscribeRequest = z.infer<typeof EngineSubscribeRequestSchema>;

export const EngineEnsureRequestSchema = z.object({});
export type EngineEnsureRequest = z.infer<typeof EngineEnsureRequestSchema>;

export const EngineIndexRequestSchema = z.object({
  mode: z.string().optional(),
});
export type EngineIndexRequest = z.infer<typeof EngineIndexRequestSchema>;

export const EngineIndexCancelRequestSchema = z.object({});
export type EngineIndexCancelRequest = z.infer<
  typeof EngineIndexCancelRequestSchema
>;

export const EngineIndexRefreshRequestSchema = z.object({});
export type EngineIndexRefreshRequest = z.infer<
  typeof EngineIndexRefreshRequestSchema
>;

export const EngineStderrRequestSchema = z.object({});
export type EngineStderrRequest = z.infer<typeof EngineStderrRequestSchema>;

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

export const WorkspacePickDirectoryRequestSchema = z.object({});
export type WorkspacePickDirectoryRequest = z.infer<
  typeof WorkspacePickDirectoryRequestSchema
>;

export const WorkspacePickDirectoryResponseSchema = z.object({
  path: z.string().nullable(),
  canceled: z.boolean(),
});
export type WorkspacePickDirectoryResponse = z.infer<
  typeof WorkspacePickDirectoryResponseSchema
>;

export const GithubProjectModeSchema = z.enum(["skip", "remote_url", "create"]);
export type GithubProjectMode = z.infer<typeof GithubProjectModeSchema>;

export const WorkspaceCreateProjectRequestSchema = z.object({
  parentPath: z.string().min(1),
  name: z.string().min(1).max(100),
  github: z
    .object({
      mode: GithubProjectModeSchema,
      remoteUrl: z.string().min(1).max(500).optional(),
      repoName: z.string().min(1).max(100).optional(),
      private: z.boolean().optional(),
      /** User or org login for `gh repo create OWNER/NAME`. */
      owner: z.string().min(1).max(100).optional(),
    })
    .optional(),
});
export type WorkspaceCreateProjectRequest = z.infer<
  typeof WorkspaceCreateProjectRequestSchema
>;

export const WorkspaceCreateProjectResponseSchema = z.object({
  ok: z.boolean(),
  workspace: WorkspaceRefSchema.optional(),
  githubRepoUrl: z.string().optional(),
  error: AppErrorPayloadSchema.optional(),
});
export type WorkspaceCreateProjectResponse = z.infer<
  typeof WorkspaceCreateProjectResponseSchema
>;

export const GithubStatusRequestSchema = z.object({});
export type GithubStatusRequest = z.infer<typeof GithubStatusRequestSchema>;

export const GithubOwnerSchema = z.object({
  login: z.string(),
  type: z.enum(["user", "org"]),
});
export type GithubOwner = z.infer<typeof GithubOwnerSchema>;

export const GithubStatusResponseSchema = z.object({
  installed: z.boolean(),
  authenticated: z.boolean(),
  login: z.string().nullable(),
  owners: z.array(GithubOwnerSchema),
  detail: z.string().nullable(),
});
export type GithubStatusResponse = z.infer<typeof GithubStatusResponseSchema>;

export const GithubLogoutRequestSchema = z.object({
  user: z.string().min(1).optional(),
});
export type GithubLogoutRequest = z.infer<typeof GithubLogoutRequestSchema>;

export const GithubLogoutResponseSchema = z.object({
  ok: z.boolean(),
  status: GithubStatusResponseSchema.optional(),
  error: AppErrorPayloadSchema.optional(),
});
export type GithubLogoutResponse = z.infer<typeof GithubLogoutResponseSchema>;

export const GithubLoginWebRequestSchema = z.object({});
export type GithubLoginWebRequest = z.infer<typeof GithubLoginWebRequestSchema>;

export const GithubLoginWebResponseSchema = z.object({
  ok: z.boolean(),
  status: GithubStatusResponseSchema.optional(),
  error: AppErrorPayloadSchema.optional(),
});
export type GithubLoginWebResponse = z.infer<typeof GithubLoginWebResponseSchema>;

export const GithubLoginTokenRequestSchema = z.object({
  token: z.string().min(1).max(5000),
});
export type GithubLoginTokenRequest = z.infer<
  typeof GithubLoginTokenRequestSchema
>;

export const GithubLoginTokenResponseSchema = z.object({
  ok: z.boolean(),
  status: GithubStatusResponseSchema.optional(),
  error: AppErrorPayloadSchema.optional(),
});
export type GithubLoginTokenResponse = z.infer<
  typeof GithubLoginTokenResponseSchema
>;

export const GithubLoginCancelRequestSchema = z.object({});
export type GithubLoginCancelRequest = z.infer<
  typeof GithubLoginCancelRequestSchema
>;

export const GithubLoginCancelResponseSchema = z.object({
  canceled: z.boolean(),
});
export type GithubLoginCancelResponse = z.infer<
  typeof GithubLoginCancelResponseSchema
>;

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
  hasRemote: z.boolean(),
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

export const WorkspaceArchitectureGetRequestSchema = z.object({});
export type WorkspaceArchitectureGetRequest = z.infer<
  typeof WorkspaceArchitectureGetRequestSchema
>;

export const WorkspaceArchitectureGetResponseSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  fromFile: z.boolean(),
  profile: ArchitectureProfileSchema.nullable(),
  derived: ArchitectureProfileSchema.optional(),
  overrides: ArchitectureProfilePatchSchema.optional(),
  intent: z.string().optional(),
  drift: z
    .array(
      z.object({
        path: z.string(),
        derived: z.unknown(),
        override: z.unknown(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});
export type WorkspaceArchitectureGetResponse = z.infer<
  typeof WorkspaceArchitectureGetResponseSchema
>;

export const WorkspaceArchitectureDetectRequestSchema = z.object({});
export type WorkspaceArchitectureDetectRequest = z.infer<
  typeof WorkspaceArchitectureDetectRequestSchema
>;

export const WorkspaceArchitectureDetectResponseSchema = z.object({
  path: z.string(),
  profile: ArchitectureProfileSchema,
  fromFile: z.boolean(),
  intent: z.string().optional(),
  drift: z
    .array(
      z.object({
        path: z.string(),
        derived: z.unknown(),
        override: z.unknown(),
      }),
    )
    .optional(),
});
export type WorkspaceArchitectureDetectResponse = z.infer<
  typeof WorkspaceArchitectureDetectResponseSchema
>;

export const WorkspaceArchitectureSaveRequestSchema = z.object({
  profile: ArchitectureProfileSchema.optional(),
  patch: ArchitectureProfilePatchSchema.optional(),
  intent: z.string().optional(),
  confirm: z.boolean().default(true),
});
export type WorkspaceArchitectureSaveRequest = z.infer<
  typeof WorkspaceArchitectureSaveRequestSchema
>;

export const WorkspaceArchitectureSaveResponseSchema = z.object({
  ok: z.boolean(),
  profile: ArchitectureProfileSchema.optional(),
  intent: z.string().optional(),
  drift: z
    .array(
      z.object({
        path: z.string(),
        derived: z.unknown(),
        override: z.unknown(),
      }),
    )
    .optional(),
  error: AppErrorPayloadSchema.optional(),
});
export type WorkspaceArchitectureSaveResponse = z.infer<
  typeof WorkspaceArchitectureSaveResponseSchema
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
  [IPC_CHANNELS.SESSION_TERMINAL_CONFIRM]: SessionTerminalConfirmRequestSchema,
  [IPC_CHANNELS.SESSION_TERMINAL_CONFIRM_EDIT]:
    SessionTerminalConfirmEditRequestSchema,
  [IPC_CHANNELS.SESSION_TERMINAL_ASK]: SessionTerminalAskRequestSchema,
  [IPC_CHANNELS.TERMINAL_SUBSCRIBE]: TerminalSubscribeRequestSchema,
  [IPC_CHANNELS.TERMINAL_LIST]: TerminalListRequestSchema,
  [IPC_CHANNELS.TERMINAL_WRITE_USER]: TerminalWriteUserRequestSchema,
  [IPC_CHANNELS.TERMINAL_RESIZE]: TerminalResizeRequestSchema,
  [IPC_CHANNELS.ENGINE_STATUS]: EngineStatusRequestSchema,
  [IPC_CHANNELS.ENGINE_SUBSCRIBE]: EngineSubscribeRequestSchema,
  [IPC_CHANNELS.ENGINE_ENSURE]: EngineEnsureRequestSchema,
  [IPC_CHANNELS.ENGINE_INDEX]: EngineIndexRequestSchema,
  [IPC_CHANNELS.ENGINE_INDEX_CANCEL]: EngineIndexCancelRequestSchema,
  [IPC_CHANNELS.ENGINE_INDEX_REFRESH]: EngineIndexRefreshRequestSchema,
  [IPC_CHANNELS.ENGINE_STDERR]: EngineStderrRequestSchema,
  [IPC_CHANNELS.SESSION_CANCEL]: SessionCancelRequestSchema,
  [IPC_CHANNELS.SESSION_EXPORT_DIAGNOSTICS]: SessionExportDiagnosticsRequestSchema,
  [IPC_CHANNELS.SESSION_LIST]: SessionListRequestSchema,
  [IPC_CHANNELS.SESSION_CREATE]: SessionCreateRequestSchema,
  [IPC_CHANNELS.SESSION_SWITCH]: SessionSwitchRequestSchema,
  [IPC_CHANNELS.SESSION_CLOSE]: SessionCloseRequestSchema,
  [IPC_CHANNELS.WORKSPACE_OPEN]: WorkspaceOpenRequestSchema,
  [IPC_CHANNELS.WORKSPACE_PICK_DIRECTORY]: WorkspacePickDirectoryRequestSchema,
  [IPC_CHANNELS.WORKSPACE_CREATE_PROJECT]: WorkspaceCreateProjectRequestSchema,
  [IPC_CHANNELS.WORKSPACE_GIT_STATUS]: WorkspaceGitStatusRequestSchema,
  [IPC_CHANNELS.WORKSPACE_LIST_BRANCHES]: WorkspaceListBranchesRequestSchema,
  [IPC_CHANNELS.WORKSPACE_ARCHITECTURE_GET]: WorkspaceArchitectureGetRequestSchema,
  [IPC_CHANNELS.WORKSPACE_ARCHITECTURE_DETECT]:
    WorkspaceArchitectureDetectRequestSchema,
  [IPC_CHANNELS.WORKSPACE_ARCHITECTURE_SAVE]:
    WorkspaceArchitectureSaveRequestSchema,
  [IPC_CHANNELS.SESSION_CONFIRM_PLAN]: SessionConfirmPlanRequestSchema,
  [IPC_CHANNELS.PROVIDER_VERIFY]: ProviderVerifyRequestSchema,
  [IPC_CHANNELS.PROVIDER_LIST_MODELS]: ProviderListModelsRequestSchema,
  [IPC_CHANNELS.PROVIDER_SAVE_CONFIG]: ProviderSaveConfigRequestSchema,
  [IPC_CHANNELS.PROVIDER_GET_CONFIG]: ProviderGetConfigRequestSchema,
  [IPC_CHANNELS.GITHUB_STATUS]: GithubStatusRequestSchema,
  [IPC_CHANNELS.GITHUB_LOGOUT]: GithubLogoutRequestSchema,
  [IPC_CHANNELS.GITHUB_LOGIN_WEB]: GithubLoginWebRequestSchema,
  [IPC_CHANNELS.GITHUB_LOGIN_TOKEN]: GithubLoginTokenRequestSchema,
  [IPC_CHANNELS.GITHUB_LOGIN_CANCEL]: GithubLoginCancelRequestSchema,
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
