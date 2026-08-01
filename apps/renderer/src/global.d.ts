import type {
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
  WorkspaceGitStatusResponse,
  WorkspaceListBranchesResponse,
  WorkspaceListRecentResponse,
  WorkspaceOpenResponse,
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
    }) => Promise<SessionConfirmPlanResponse>;
    approve: (approvalId: string, grantCategory?: boolean) => Promise<void>;
    reject: (approvalId: string, reason?: string) => Promise<void>;
    cancel?: () => Promise<void>;
    exportDiagnostics?: () => Promise<unknown>;
  };
  workspace: {
    open: (path?: string) => Promise<WorkspaceOpenResponse>;
    listRecent: () => Promise<WorkspaceListRecentResponse>;
    gitStatus: () => Promise<WorkspaceGitStatusResponse>;
    listBranches: () => Promise<WorkspaceListBranchesResponse>;
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
    onNewSession: (cb: () => void) => () => void;
    onOpenProvider: (cb: () => void) => () => void;
  };
};

declare global {
  interface Window {
    aiIde: DesktopBridge;
  }
}

export {};
