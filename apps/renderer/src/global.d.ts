import type {
  GithubStatusResponse,
  GithubLogoutResponse,
  GithubLoginWebResponse,
  GithubLoginTokenResponse,
  GithubLoginCancelResponse,
  ProviderGetConfigResponse,
  ProviderListModelsRequest,
  ProviderListModelsResponse,
  ProviderSaveConfigRequest,
  ProviderSaveConfigResponse,
  ProviderVerifyRequest,
  ProviderVerifyResponse,
  ProviderDeleteResponse,
  ProviderFetchPricingRequest,
  ProviderFetchPricingProgress,
  ProviderFetchPricingResponse,
  ProviderListResponse,
  ProviderSetActiveResponse,
  ProviderSetModelResponse,
  SessionState,
  SessionCloseResponse,
  SessionDiscardResponse,
  SessionGetLogResponse,
  SessionListLogsResponse,
  SessionConfirmPlanResponse,
  SessionCreateResponse,
  SessionGetResponse,
  SessionListResponse,
  SessionSendMessageResponse,
  SessionSetModeResponse,
  SessionSwitchResponse,
  SessionUpdateEvent,
  TerminalDataEvent,
  TerminalListResponse,
  EngineStatus,
  PreviewCaptureResponse,
  PreviewCommandResponse,
  PreviewElementSelection,
  PreviewRect,
  PreviewStatus,
  PreviewViewportId,
  WorkspaceArchitectureDetectResponse,
  WorkspaceArchitectureGetResponse,
  WorkspaceArchitectureSaveResponse,
  WorkspaceCreateProjectRequest,
  WorkspaceCreateProjectResponse,
  WorkspaceGitCommandResponse,
  WorkspaceGitStatusResponse,
  WorkspaceListBranchesResponse,
  WorkspaceListDirResponse,
  WorkspaceListRecentResponse,
  WorkspaceOpenResponse,
  WorkspacePickDirectoryResponse,
  WorkspaceReadFileResponse,
  WorkspaceDiffFilesResponse,
  WorkspaceDiffFileResponse,
} from "@ai-ide/shared";

export type DesktopBridge = {
  session: {
    get: () => Promise<SessionGetResponse>;
    list: () => Promise<SessionListResponse>;
    create: (input?: {
      branch?: string;
      dirtyStrategy?: "stash" | "force";
    }) => Promise<SessionCreateResponse>;
    switch: (sessionId: string) => Promise<SessionSwitchResponse>;
    close: (
      sessionId: string,
      outcome?: "archived" | "discarded",
    ) => Promise<SessionCloseResponse>;
    discard: (
      sessionId: string,
      deleteBranch: boolean,
    ) => Promise<SessionDiscardResponse>;
    listLogs: () => Promise<SessionListLogsResponse>;
    getLog: (sessionId?: string) => Promise<SessionGetLogResponse>;
    subscribe: (cb: (event: SessionUpdateEvent) => void) => () => void;
    sendMessage: (
      content: string,
      options?: {
        planAnswers?: Array<{
          questionId: string;
          answer: string;
          selectedOptionIds?: string[];
        }>;
        attachments?: Array<{
          id: string;
          kind: "image" | "file";
          name: string;
          path?: string;
          mime?: string;
          dataBase64?: string;
          textPreview?: string;
          previewDataUrl?: string;
        }>;
      },
    ) => Promise<SessionSendMessageResponse>;
    setMode: (mode: string) => Promise<SessionSetModeResponse>;
    confirmPlan: (input: {
      createBranch: boolean;
      branchName?: string;
      baseBranch?: string;
      dirtyStrategy?: "stash" | "commit_base";
      baseCommitMessage?: string;
    }) => Promise<SessionConfirmPlanResponse>;
    rejectPlanReady: () => Promise<{
      ok: boolean;
      state?: SessionState;
    }>;
    draftBuildCommit: () => Promise<{
      ok: boolean;
      message?: string;
      branch?: string | null;
      files?: string[];
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    draftGitMessage?: (kind: "commit" | "stash") => Promise<{
      ok: boolean;
      message?: string;
      files?: string[];
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    commitBuild: (message: string) => Promise<{
      ok: boolean;
      commit?: string;
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    dismissBuildCommit: () => Promise<{ ok: boolean }>;
    integrateBuild: (action: "pr" | "merge") => Promise<{
      ok: boolean;
      url?: string;
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    dismissBuildIntegrate: () => Promise<{ ok: boolean }>;
    approve: (approvalId: string, grantCategory?: boolean) => Promise<void>;
    reject: (approvalId: string, reason?: string) => Promise<void>;
    terminalConfirm?: (
      confirmId: string,
      action: "approve" | "cancel",
      text?: string,
    ) => Promise<void>;
    terminalConfirmEdit?: (confirmId: string, text: string) => Promise<void>;
    terminalAsk?: (input: {
      askId: string;
      selectedOptionId?: string | null;
      text: string;
      cancelled?: boolean;
    }) => Promise<void>;
    agentAsk?: (input: {
      askId: string;
      selectedOptionIds?: string[];
      text: string;
      cancelled?: boolean;
    }) => Promise<void>;
    humanSetup?: (input: {
      action: "recheck" | "toggle" | "resume" | "skip";
      itemId?: string;
      done?: boolean;
    }) => Promise<void>;
    dismissNotice?: (input: { noticeId: string }) => Promise<void>;
    cancel?: () => Promise<void>;
    exportDiagnostics?: () => Promise<unknown>;
  };
  terminal?: {
    list: () => Promise<TerminalListResponse>;
    subscribe: (cb: (event: TerminalDataEvent) => void) => () => void;
    writeUser: (terminalId: string, text: string) => Promise<void>;
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  };
  engine?: {
    status: () => Promise<EngineStatus>;
    subscribe: (cb: (status: EngineStatus) => void) => () => void;
    ensure: () => Promise<{ ok: boolean; status: EngineStatus }>;
    index: (mode?: string) => Promise<{ ok: boolean; status: EngineStatus }>;
    indexCancel: () => Promise<{ status: EngineStatus }>;
    indexRefresh: () => Promise<{ ok: boolean; status: EngineStatus }>;
    stderr: () => Promise<{ stderr: string }>;
  };
  /** Optional: an outdated preload has no preview surface at all. */
  preview?: {
    status: () => Promise<PreviewCommandResponse>;
    subscribe: (cb: (status: PreviewStatus) => void) => () => void;
    start: () => Promise<PreviewCommandResponse>;
    stop: () => Promise<PreviewCommandResponse>;
    setBounds: (rect: PreviewRect | null) => void;
    setVisible: (visible: boolean) => void;
    setViewport: (
      viewport: PreviewViewportId,
    ) => Promise<PreviewCommandResponse>;
    navigate: (url: string) => Promise<PreviewCommandResponse>;
    act: (
      action: "back" | "forward" | "reload" | "stop",
    ) => Promise<PreviewCommandResponse>;
    clearData: () => Promise<PreviewCommandResponse>;
    toggleDevTools: () => Promise<PreviewCommandResponse>;
    capture: () => Promise<PreviewCaptureResponse>;
    refreshSetup: () => Promise<PreviewCommandResponse>;
    confirmSetup: () => Promise<PreviewCommandResponse>;
    pickElement: () => Promise<PreviewCommandResponse>;
    cancelPick: () => Promise<PreviewCommandResponse>;
    onElement: (cb: (hit: PreviewElementSelection) => void) => () => void;
  };
  workspace: {
    open: (path?: string) => Promise<WorkspaceOpenResponse>;
    pickDirectory: () => Promise<WorkspacePickDirectoryResponse>;
    createProject: (
      input: WorkspaceCreateProjectRequest,
    ) => Promise<WorkspaceCreateProjectResponse>;
    listRecent: () => Promise<WorkspaceListRecentResponse>;
    gitStatus: () => Promise<WorkspaceGitStatusResponse>;
    gitCheckout: (input: {
      branch: string;
      dirtyStrategy?: "stash" | "force";
    }) => Promise<WorkspaceGitCommandResponse>;
    gitPull: (remote?: string) => Promise<WorkspaceGitCommandResponse>;
    gitPush: (remote?: string) => Promise<WorkspaceGitCommandResponse>;
    gitSetRemote: (remote: string) => Promise<WorkspaceGitCommandResponse>;
    gitStash?: (message: string) => Promise<WorkspaceGitCommandResponse>;
    gitStashList?: () => Promise<{
      ok: boolean;
      stashes: Array<{ index: number; ref: string; message: string }>;
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    gitStashPop?: (index?: number) => Promise<WorkspaceGitCommandResponse>;
    gitCommit?: (message: string) => Promise<WorkspaceGitCommandResponse>;
    listBranches: () => Promise<WorkspaceListBranchesResponse>;
    listDir: (path?: string) => Promise<WorkspaceListDirResponse>;
    readFile: (path: string) => Promise<WorkspaceReadFileResponse>;
    diffFiles: () => Promise<WorkspaceDiffFilesResponse>;
    diffFile: (path: string) => Promise<WorkspaceDiffFileResponse>;
    architectureGet: () => Promise<WorkspaceArchitectureGetResponse>;
    architectureDetect: () => Promise<WorkspaceArchitectureDetectResponse>;
    architectureSave: (input: {
      profile?: WorkspaceArchitectureGetResponse["profile"];
      patch?: Record<string, unknown>;
      intent?: string;
      confirm?: boolean;
    }) => Promise<WorkspaceArchitectureSaveResponse>;
  };
  github: {
    status: () => Promise<GithubStatusResponse>;
    logout: (user?: string) => Promise<GithubLogoutResponse>;
    loginWeb: () => Promise<GithubLoginWebResponse>;
    loginToken: (token: string) => Promise<GithubLoginTokenResponse>;
    loginCancel: () => Promise<GithubLoginCancelResponse>;
  };
  provider: {
    getConfig: () => Promise<ProviderGetConfigResponse>;
    list: () => Promise<ProviderListResponse>;
    setActive: (
      id: string,
    ) => Promise<ProviderSetActiveResponse>;
    setModel: (
      model: string,
      providerId?: string,
    ) => Promise<ProviderSetModelResponse>;
    delete: (
      id: string,
    ) => Promise<ProviderDeleteResponse>;
    verify: (input: ProviderVerifyRequest) => Promise<ProviderVerifyResponse>;
    listModels: (
      input: ProviderListModelsRequest,
    ) => Promise<ProviderListModelsResponse>;
    saveConfig: (
      input: ProviderSaveConfigRequest,
    ) => Promise<ProviderSaveConfigResponse>;
    fetchPricing: (
      input: ProviderFetchPricingRequest,
    ) => Promise<ProviderFetchPricingResponse>;
    cancelFetchPricing: () => Promise<{ ok: boolean }>;
    onFetchPricingProgress: (
      cb: (event: ProviderFetchPricingProgress) => void,
    ) => () => void;
  };
  ui?: {
    onFocusComposer: (cb: () => void) => () => void;
    onTogglePalette: (cb: () => void) => () => void;
    onOpenWorkspace: (cb: () => void) => () => void;
    onNewProject: (cb: () => void) => () => void;
    onNewSession: (cb: () => void) => () => void;
    onOpenProvider: (cb: () => void) => () => void;
    onToggleArchitecture: (cb: () => void) => () => void;
    onTogglePreview?: (cb: () => void) => () => void;
    onTogglePlan?: (cb: () => void) => () => void;
    onToggleModel?: (cb: () => void) => () => void;
  };
};

declare global {
  interface Window {
    aiIde: DesktopBridge;
  }
}

export {};
