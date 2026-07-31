import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type ProviderListModelsResponse,
  type ProviderSaveConfigResponse,
  type ProviderVerifyResponse,
  type SessionCloseResponse,
  type SessionCreateResponse,
  type SessionGetResponse,
  type SessionListResponse,
  type SessionSendMessageResponse,
  type SessionSetModeResponse,
  type SessionSwitchResponse,
  type SessionUpdateEvent,
  type WorkspaceListRecentResponse,
  type WorkspaceOpenResponse,
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
    approve: (approvalId: string, grantCategory?: boolean) => Promise<void>;
    reject: (approvalId: string, reason?: string) => Promise<void>;
    cancel: () => Promise<void>;
    exportDiagnostics: () => Promise<unknown>;
  };
  workspace: {
    open: (path?: string) => Promise<WorkspaceOpenResponse>;
    listRecent: () => Promise<WorkspaceListRecentResponse>;
  };
  provider: {
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
  };
};

const UI_FOCUS_COMPOSER = "ui:focus-composer";
const UI_TOGGLE_PALETTE = "ui:toggle-palette";

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
    approve: (approvalId, grantCategory = false) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_APPROVE, {
        approvalId,
        grantCategory,
      }),
    reject: (approvalId, reason) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_REJECT, { approvalId, reason }),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CANCEL, {}),
    exportDiagnostics: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT_DIAGNOSTICS, {}),
  },
  workspace: {
    open: (path) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN, path ? { path } : {}),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_RECENT),
  },
  provider: {
    verify: (input) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_VERIFY, input),
    listModels: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST_MODELS, input),
    saveConfig: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE_CONFIG, input),
  },
  ui: {
    onFocusComposer: (cb) => {
      const handler = () => cb();
      ipcRenderer.on(UI_FOCUS_COMPOSER, handler);
      return () => ipcRenderer.removeListener(UI_FOCUS_COMPOSER, handler);
    },
    onTogglePalette: (cb) => {
      const handler = () => cb();
      ipcRenderer.on(UI_TOGGLE_PALETTE, handler);
      return () => ipcRenderer.removeListener(UI_TOGGLE_PALETTE, handler);
    },
  },
};

contextBridge.exposeInMainWorld("aiIde", bridge);

declare global {
  interface Window {
    aiIde: DesktopBridge;
  }
}
