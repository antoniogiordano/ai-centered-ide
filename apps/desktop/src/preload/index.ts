import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type GithubStatusResponse,
  type GithubLogoutResponse,
  type GithubLoginWebResponse,
  type GithubLoginTokenResponse,
  type GithubLoginCancelResponse,
  type ProviderGetConfigResponse,
  type ProviderListModelsRequest,
  type ProviderListModelsResponse,
  type ProviderListResponse,
  type ProviderSetActiveResponse,
  type ProviderSetModelResponse,
  type ProviderDeleteResponse,
  type ProviderSaveConfigRequest,
  type ProviderSaveConfigResponse,
  type ProviderFetchPricingRequest,
  type ProviderFetchPricingProgress,
  type ProviderFetchPricingResponse,
  type ProviderVerifyRequest,
  type ProviderVerifyResponse,
  type SessionCloseResponse,
  type SessionCreateResponse,
  type SessionDiscardResponse,
  type SessionGetLogResponse,
  type SessionListLogsResponse,
  type SessionGetResponse,
  type SessionListResponse,
  type SessionSendMessageResponse,
  type SessionConfirmPlanResponse,
  type SessionDraftBuildCommitResponse,
  type SessionDraftGitMessageResponse,
  type WorkspaceGitStashListResponse,
  type SessionCommitBuildResponse,
  type SessionDismissBuildCommitResponse,
  type SessionIntegrateBuildResponse,
  type SessionDismissBuildIntegrateResponse,
  type SessionSetModeResponse,
  type SessionSwitchResponse,
  type SessionUpdateEvent,
  type TerminalDataEvent,
  type TerminalListResponse,
  type EngineStatus,
  type PreviewCaptureResponse,
  type PreviewCommandResponse,
  type PreviewElementSelection,
  type PreviewStatus,
  type PreviewRect,
  type PreviewViewportId,
  type WorkspaceCreateProjectRequest,
  type WorkspaceCreateProjectResponse,
  type WorkspaceGitCommandResponse,
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
  type SessionState,
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
    rejectPlanReady: () => Promise<{ ok: boolean; state?: SessionState }>;
    draftBuildCommit: () => Promise<SessionDraftBuildCommitResponse>;
    draftGitMessage: (
      kind: "commit" | "stash",
    ) => Promise<SessionDraftGitMessageResponse>;
    commitBuild: (message: string) => Promise<SessionCommitBuildResponse>;
    dismissBuildCommit: () => Promise<SessionDismissBuildCommitResponse>;
    integrateBuild: (action: "pr" | "merge") => Promise<SessionIntegrateBuildResponse>;
    dismissBuildIntegrate: () => Promise<SessionDismissBuildIntegrateResponse>;
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
    agentAsk: (input: {
      askId: string;
      selectedOptionIds?: string[];
      text: string;
      cancelled?: boolean;
    }) => Promise<void>;
    humanSetup: (input: {
      action: "recheck" | "toggle" | "resume" | "skip";
      itemId?: string;
      done?: boolean;
    }) => Promise<void>;
    dismissNotice: (input: { noticeId: string }) => Promise<void>;
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
  preview: {
    status: () => Promise<PreviewCommandResponse>;
    subscribe: (cb: (status: PreviewStatus) => void) => () => void;
    start: () => Promise<PreviewCommandResponse>;
    stop: () => Promise<PreviewCommandResponse>;
    setBounds: (rect: PreviewRect | null) => void;
    setVisible: (visible: boolean) => void;
    setViewport: (viewport: PreviewViewportId) => Promise<PreviewCommandResponse>;
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
    gitStash: (message: string) => Promise<WorkspaceGitCommandResponse>;
    gitStashList: () => Promise<WorkspaceGitStashListResponse>;
    gitStashPop: (index?: number) => Promise<WorkspaceGitCommandResponse>;
    gitCommit: (message: string) => Promise<WorkspaceGitCommandResponse>;
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
    setActive: (id: string) => Promise<ProviderSetActiveResponse>;
    setModel: (model: string, providerId?: string) => Promise<ProviderSetModelResponse>;
    delete: (id: string) => Promise<ProviderDeleteResponse>;
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
  ui: {
    onFocusComposer: (cb: () => void) => () => void;
    onTogglePalette: (cb: () => void) => () => void;
    onOpenWorkspace: (cb: () => void) => () => void;
    onNewProject: (cb: () => void) => () => void;
    onNewSession: (cb: () => void) => () => void;
    onOpenProvider: (cb: () => void) => () => void;
    onToggleArchitecture: (cb: () => void) => () => void;
    onTogglePreview: (cb: () => void) => () => void;
    onTogglePlan: (cb: () => void) => () => void;
    onToggleModel: (cb: () => void) => () => void;
  };
};

const UI_FOCUS_COMPOSER = "ui:focus-composer";
const UI_TOGGLE_PALETTE = "ui:toggle-palette";
const UI_OPEN_WORKSPACE = "ui:open-workspace";
const UI_NEW_PROJECT = "ui:new-project";
const UI_NEW_SESSION = "ui:new-session";
const UI_OPEN_PROVIDER = "ui:open-provider";
const UI_TOGGLE_ARCHITECTURE = "ui:toggle-architecture";
const UI_TOGGLE_PREVIEW = "ui:toggle-preview";
const UI_TOGGLE_PLAN = "ui:toggle-plan";
const UI_TOGGLE_MODEL = "ui:toggle-model";

function onUiEvent(channel: string, cb: () => void): () => void {
  const handler = () => cb();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: DesktopBridge = {
  session: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST, {}),
    create: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, input ?? {}),
    switch: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SWITCH, { sessionId }),
    close: (sessionId, outcome) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CLOSE, {
        sessionId,
        ...(outcome ? { outcome } : {}),
      }),
    discard: (sessionId, deleteBranch) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DISCARD, {
        sessionId,
        deleteBranch,
      }),
    listLogs: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_LOGS, {}),
    getLog: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_LOG, {
        ...(sessionId ? { sessionId } : {}),
      }),
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
        ...(options?.attachments ? { attachments: options.attachments } : {}),
      }),
    setMode: (mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_MODE, { mode }),
    confirmPlan: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CONFIRM_PLAN, input),
    rejectPlanReady: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_REJECT_PLAN_READY, {}),
    draftBuildCommit: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DRAFT_BUILD_COMMIT, {}),
    draftGitMessage: (kind) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DRAFT_GIT_MESSAGE, { kind }),
    commitBuild: (message) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMMIT_BUILD, { message }),
    dismissBuildCommit: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DISMISS_BUILD_COMMIT, {}),
    integrateBuild: (action) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_INTEGRATE_BUILD, { action }),
    dismissBuildIntegrate: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DISMISS_BUILD_INTEGRATE, {}),
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
    agentAsk: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_AGENT_ASK, {
        askId: input.askId,
        selectedOptionIds: input.selectedOptionIds ?? [],
        text: input.text,
        cancelled: Boolean(input.cancelled),
      }),
    humanSetup: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_HUMAN_SETUP, {
        action: input.action,
        ...(input.itemId ? { itemId: input.itemId } : {}),
        ...(typeof input.done === "boolean" ? { done: input.done } : {}),
      }),
    dismissNotice: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DISMISS_NOTICE, {
        noticeId: input.noticeId,
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
  preview: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_STATUS, {}),
    subscribe: (cb) => {
      const channel = `${IPC_CHANNELS.PREVIEW_SUBSCRIBE}:update`;
      const handler = (_: unknown, status: PreviewStatus) => cb(status);
      ipcRenderer.on(channel, handler);
      ipcRenderer.send(IPC_CHANNELS.PREVIEW_SUBSCRIBE);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    start: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_START, {}),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_STOP, {}),
    setBounds: (rect) =>
      ipcRenderer.send(IPC_CHANNELS.PREVIEW_SET_BOUNDS, { rect }),
    setVisible: (visible) =>
      ipcRenderer.send(IPC_CHANNELS.PREVIEW_SET_VISIBLE, { visible }),
    setViewport: (viewport) =>
      ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_SET_VIEWPORT, { viewport }),
    navigate: (url) =>
      ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_NAVIGATE, { url }),
    act: (action) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_ACT, { action }),
    clearData: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CLEAR_DATA, {}),
    toggleDevTools: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_TOGGLE_DEVTOOLS, {}),
    capture: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CAPTURE, {}),
    refreshSetup: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_REFRESH_SETUP, {}),
    confirmSetup: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CONFIRM_SETUP, {}),
    pickElement: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_PICK_ELEMENT, {}),
    cancelPick: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CANCEL_PICK, {}),
    onElement: (cb) => {
      const channel = `${IPC_CHANNELS.PREVIEW_ELEMENT_SUBSCRIBE}:update`;
      const handler = (_: unknown, hit: PreviewElementSelection) => cb(hit);
      ipcRenderer.on(channel, handler);
      ipcRenderer.send(IPC_CHANNELS.PREVIEW_ELEMENT_SUBSCRIBE);
      return () => ipcRenderer.removeListener(channel, handler);
    },
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
    gitCheckout: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GIT_CHECKOUT, input),
    gitPull: (remote) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.WORKSPACE_GIT_PULL,
        remote ? { remote } : {},
      ),
    gitPush: (remote) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.WORKSPACE_GIT_PUSH,
        remote ? { remote } : {},
      ),
    gitSetRemote: (remote) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GIT_SET_REMOTE, { remote }),
    gitStash: (message) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GIT_STASH, { message }),
    gitStashList: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GIT_STASH_LIST, {}),
    gitStashPop: (index) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.WORKSPACE_GIT_STASH_POP,
        typeof index === "number" ? { index } : {},
      ),
    gitCommit: (message) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GIT_COMMIT, { message }),
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
    list: () => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST, {}),
    setActive: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SET_ACTIVE, { id }),
    setModel: (model, providerId) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SET_MODEL, {
        model,
        ...(providerId ? { providerId } : {}),
      }),
    delete: (id: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE, { id }),
    verify: (input) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_VERIFY, input),
    listModels: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST_MODELS, input),
    saveConfig: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE_CONFIG, input),
    fetchPricing: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_FETCH_PRICING, input),
    cancelFetchPricing: () =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_CANCEL_FETCH_PRICING, {}),
    onFetchPricingProgress: (cb) => {
      const channel = IPC_CHANNELS.PROVIDER_FETCH_PRICING_PROGRESS;
      const handler = (
        _: unknown,
        event: { message: string; at: string },
      ) => cb(event);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  ui: {
    onFocusComposer: (cb) => onUiEvent(UI_FOCUS_COMPOSER, cb),
    onTogglePalette: (cb) => onUiEvent(UI_TOGGLE_PALETTE, cb),
    onOpenWorkspace: (cb) => onUiEvent(UI_OPEN_WORKSPACE, cb),
    onNewProject: (cb) => onUiEvent(UI_NEW_PROJECT, cb),
    onNewSession: (cb) => onUiEvent(UI_NEW_SESSION, cb),
    onOpenProvider: (cb) => onUiEvent(UI_OPEN_PROVIDER, cb),
    onToggleArchitecture: (cb) => onUiEvent(UI_TOGGLE_ARCHITECTURE, cb),
    onTogglePreview: (cb) => onUiEvent(UI_TOGGLE_PREVIEW, cb),
    onTogglePlan: (cb) => onUiEvent(UI_TOGGLE_PLAN, cb),
    onToggleModel: (cb) => onUiEvent(UI_TOGGLE_MODEL, cb),
  },
};

contextBridge.exposeInMainWorld("aiIde", bridge);

declare global {
  interface Window {
    aiIde: DesktopBridge;
  }
}
