import type {
  GithubStatusResponse,
  GithubLogoutResponse,
  GithubLoginWebResponse,
  GithubLoginTokenResponse,
  GithubLoginCancelResponse,
  ProviderGetConfigResponse,
  ProviderListModelsResponse,
  ProviderSaveConfigResponse,
  ProviderVerifyResponse,
  SessionCloseResponse,
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
  WorkspaceArchitectureDetectResponse,
  WorkspaceArchitectureGetResponse,
  WorkspaceArchitectureSaveResponse,
  WorkspaceCreateProjectRequest,
  WorkspaceCreateProjectResponse,
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
    create: () => Promise<SessionCreateResponse>;
    switch: (sessionId: string) => Promise<SessionSwitchResponse>;
    close: (sessionId: string) => Promise<SessionCloseResponse>;
    subscribe: (cb: (event: SessionUpdateEvent) => void) => () => void;
    sendMessage: (
      content: string,
      options?: {
        planAnswers?: Array<{
          questionId: string;
          answer: string;
          selectedOptionIds?: string[];
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
    draftBuildCommit: () => Promise<{
      ok: boolean;
      message?: string;
      branch?: string | null;
      files?: string[];
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    commitBuild: (message: string) => Promise<{
      ok: boolean;
      commit?: string;
      error?: { code: string; userMessage: string; technicalDetail: string };
    }>;
    dismissBuildCommit: () => Promise<{ ok: boolean }>;
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
  workspace: {
    open: (path?: string) => Promise<WorkspaceOpenResponse>;
    pickDirectory: () => Promise<WorkspacePickDirectoryResponse>;
    createProject: (
      input: WorkspaceCreateProjectRequest,
    ) => Promise<WorkspaceCreateProjectResponse>;
    listRecent: () => Promise<WorkspaceListRecentResponse>;
    gitStatus: () => Promise<WorkspaceGitStatusResponse>;
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
    verify: (input: {
      baseUrl: string;
      apiKey: string;
      model?: string;
    }) => Promise<ProviderVerifyResponse>;
    listModels: (input: {
      baseUrl: string;
      apiKey: string;
    }) => Promise<ProviderListModelsResponse>;
    saveConfig: (input: {
      baseUrl: string;
      apiKey: string;
      defaultModel: string;
    }) => Promise<ProviderSaveConfigResponse>;
  };
  ui?: {
    onFocusComposer: (cb: () => void) => () => void;
    onTogglePalette: (cb: () => void) => () => void;
    onOpenWorkspace: (cb: () => void) => () => void;
    onNewProject: (cb: () => void) => () => void;
    onNewSession: (cb: () => void) => () => void;
    onOpenProvider: (cb: () => void) => () => void;
    onToggleArchitecture: (cb: () => void) => () => void;
  };
};

declare global {
  interface Window {
    aiIde: DesktopBridge;
  }
}

export {};
