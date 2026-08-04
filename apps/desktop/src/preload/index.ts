import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type GithubStatusResponse,
  type GithubLogoutResponse,
  type GithubLoginWebResponse,
  type GithubLoginTokenResponse,
  type GithubLoginCancelResponse,
  type ProviderGetConfigResponse,
  type ProviderListModelsResponse,
  type ProviderSaveConfigResponse,
  type ProviderVerifyResponse,
  type SessionCloseResponse,
  type SessionCreateResponse,
  type SessionGetResponse,
  type SessionListResponse,
  type SessionSendMessageResponse,
  type SessionConfirmPlanResponse,
  type SessionDraftBuildCommitResponse,
  type SessionCommitBuildResponse,
  type SessionDismissBuildCommitResponse,
  type SessionSetModeResponse,
  type SessionSwitchResponse,
  type SessionUpdateEvent,
  type TerminalDataEvent,
  type TerminalListResponse,
  type EngineStatus,
  type WorkspaceCreateProjectRequest,
  type WorkspaceCreateProjectResponse,
  type WorkspaceGitStatusResponse,
  type WorkspaceListBranchesResponse,
  type WorkspaceListDirResponse,
  type WorkspaceArchitectureGetResponse,
  type WorkspaceArchitectureDetectResponse,
  type WorkspaceArchitectureSaveResponse,
  type WorkspaceListRecentResponse,
  type WorkspaceOpenResponse,
  type WorkspacePickDirectoryResponse,
  type WorkspaceReadFileResponse,
  type WorkspaceDiffFilesResponse,
  type WorkspaceDiffFileResponse,
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
    draftBuildCommit: () => Promise<SessionDraftBuildCommitResponse>;
    commitBuild: (message: string) => Promise<SessionCommitBuildResponse>;
    dismissBuildCommit: () => Promise<SessionDismissBuildCommitResponse>;
    approve: (approvalId: string, grantCategory?: boolean) => Promise<void>;
    reject: (approvalId: string, reason?: string) => Promise<void>;
    terminalConfirm: (
      confirmId: string,
      action: "approve" | "cancel",
      text?: string,
    ) => Promise<void>;
    terminalConfirmEdit: (confirmId: string, text: string) => Promise<void>;
    terminalAsk: (input: {
      askId: string;
      selectedOptionId?: string | null;
      text: string;
      cancelled?: boolean;
    }) => Promise<void>;
    cancel: () => Promise<void>;
    exportDiagnostics: () => Promise<unknown>;
  };
  terminal: {
    list: () => Promise<TerminalListResponse>;
    subscribe: (cb: (event: TerminalDataEvent) => void) => () => void;
    writeUser: (terminalId: string, text: string) => Promise<void>;
    resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  };
  engine: {
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
  ui: {
    onFocusComposer: (cb: () => void) => () => void;
    onTogglePalette: (cb: () => void) => () => void;
    onOpenWorkspace: (cb: () => void) => () => void;
    onNewProject: (cb: () => void) => () => void;
    onNewSession: (cb: () => void) => () => void;
    onOpenProvider: (cb: () => void) => () => void;
    onToggleArchitecture: (cb: () => void) => () => void;
  };
};

const UI_FOCUS_COMPOSER = "ui:focus-composer";
const UI_TOGGLE_PALETTE = "ui:toggle-palette";
const UI_OPEN_WORKSPACE = "ui:open-workspace";
const UI_NEW_PROJECT = "ui:new-project";
const UI_NEW_SESSION = "ui:new-session";
const UI_OPEN_PROVIDER = "ui:open-provider";
const UI_TOGGLE_ARCHITECTURE = "ui:toggle-architecture";

function onUiEvent(channel: string, cb: () => void): () => void {
  const handler = () => cb();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  session: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST, {}),
    create: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, {}),
    switch: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SWITCH, { sessionId }),
    close: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CLOSE, { sessionId }),
    subscribe: (cb) => {
      const channel = `${IPC_CHANNELS.SESSION_SUBSCRIBE}:update`;
      const handler = (_: unknown, event: SessionUpdateEvent) => cb(event);
      ipcRenderer.on(channel, handler);
      ipcRenderer.send(IPC_CHANNELS.SESSION_SUBSCRIBE);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    sendMessage: (content, options) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SEND_MESSAGE, {
        content,
        ...(options?.planAnswers
          ? { planAnswers: options.planAnswers }
          : {}),
      }),
    setMode: (mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_MODE, { mode }),
    confirmPlan: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CONFIRM_PLAN, input),
    draftBuildCommit: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DRAFT_BUILD_COMMIT, {}),
    commitBuild: (message) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMMIT_BUILD, { message }),
    dismissBuildCommit: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DISMISS_BUILD_COMMIT, {}),
    approve: (approvalId, grantCategory = false) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_APPROVE, {
        approvalId,
        grantCategory,
      }),
    reject: (approvalId, reason) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_REJECT, { approvalId, reason }),
    terminalConfirm: (confirmId, action, text) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_TERMINAL_CONFIRM, {
        confirmId,
        action,
        ...(text !== undefined ? { text } : {}),
      }),
    terminalConfirmEdit: (confirmId, text) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_TERMINAL_CONFIRM_EDIT, {
        confirmId,
        text,
      }),
    terminalAsk: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_TERMINAL_ASK, {
        askId: input.askId,
        selectedOptionId: input.selectedOptionId ?? null,
        text: input.text,
        cancelled: Boolean(input.cancelled),
      }),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CANCEL, {}),
    exportDiagnostics: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT_DIAGNOSTICS, {}),
  },
  terminal: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST, {}),
    subscribe: (cb) => {
      const channel = `${IPC_CHANNELS.TERMINAL_SUBSCRIBE}:data`;
      const handler = (_: unknown, event: TerminalDataEvent) => cb(event);
      ipcRenderer.on(channel, handler);
      ipcRenderer.send(IPC_CHANNELS.TERMINAL_SUBSCRIBE);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    writeUser: (terminalId, text) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE_USER, { terminalId, text }),
    resize: (terminalId, cols, rows) =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, {
        terminalId,
        cols,
        rows,
      }),
  },
  engine: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.ENGINE_STATUS, {}),
    subscribe: (cb) => {
      const channel = `${IPC_CHANNELS.ENGINE_SUBSCRIBE}:update`;
      const handler = (_: unknown, status: EngineStatus) => cb(status);
      ipcRenderer.on(channel, handler);
      ipcRenderer.send(IPC_CHANNELS.ENGINE_SUBSCRIBE);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    ensure: () => ipcRenderer.invoke(IPC_CHANNELS.ENGINE_ENSURE, {}),
    index: (mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.ENGINE_INDEX, mode ? { mode } : {}),
    indexCancel: () =>
      ipcRenderer.invoke(IPC_CHANNELS.ENGINE_INDEX_CANCEL, {}),
    indexRefresh: () =>
      ipcRenderer.invoke(IPC_CHANNELS.ENGINE_INDEX_REFRESH, {}),
    stderr: () => ipcRenderer.invoke(IPC_CHANNELS.ENGINE_STDERR, {}),
  },
  workspace: {
    open: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN, path ? { path } : {}),
    pickDirectory: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PICK_DIRECTORY, {}),
    createProject: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE_PROJECT, input),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_RECENT),
    gitStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GIT_STATUS, {}),
    listBranches: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_BRANCHES, {}),
    listDir: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_DIR, {
        path: path ?? ".",
      }),
    readFile: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_FILE, { path }),
    diffFiles: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DIFF_FILES, {}),
    diffFile: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DIFF_FILE, { path }),
    architectureGet: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_GET, {}),
    architectureDetect: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_DETECT, {}),
    architectureSave: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_SAVE, input),
  },
  github: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_STATUS, {}),
    logout: (user) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.GITHUB_LOGOUT,
        user ? { user } : {},
      ),
    loginWeb: () => ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LOGIN_WEB, {}),
    loginToken: (token) =>
      ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LOGIN_TOKEN, { token }),
    loginCancel: () =>
      ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LOGIN_CANCEL, {}),
  },
  provider: {
    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_GET_CONFIG, {}),
    verify: (input) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_VERIFY, input),
    listModels: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST_MODELS, input),
    saveConfig: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE_CONFIG, input),
  },
  ui: {
    onFocusComposer: (cb) => onUiEvent(UI_FOCUS_COMPOSER, cb),
    onTogglePalette: (cb) => onUiEvent(UI_TOGGLE_PALETTE, cb),
    onOpenWorkspace: (cb) => onUiEvent(UI_OPEN_WORKSPACE, cb),
    onNewProject: (cb) => onUiEvent(UI_NEW_PROJECT, cb),
    onNewSession: (cb) => onUiEvent(UI_NEW_SESSION, cb),
    onOpenProvider: (cb) => onUiEvent(UI_OPEN_PROVIDER, cb),
    onToggleArchitecture: (cb) => onUiEvent(UI_TOGGLE_ARCHITECTURE, cb),
  },
};

contextBridge.exposeInMainWorld("aiIde", bridge);

declare global {
  interface Window {
    aiIde: DesktopBridge;
  }
}
