import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  validateIpcRequest,
  type IpcRequestChannel,
  type SessionUpdateEvent,
} from "@ai-ide/shared";
import {
  CREDENTIAL_SERVICE,
  type ProjectStorage,
} from "@ai-ide/storage";
import type { CredentialStore } from "@ai-ide/storage";
import { MockProvider, OpenAiCompatibleProvider } from "@ai-ide/provider";
import { assertHttpsForRemote } from "@ai-ide/provider";
import { GitService } from "@ai-ide/workspace";
import { dialog } from "electron";
import type { SessionManager } from "./session.js";

let invalidMessageCount = 0;

export function registerIpcHandlers(
  session: SessionManager,
  credentials: CredentialStore,
  storage: ProjectStorage,
): void {
  ipcMain.handle(IPC_CHANNELS.SESSION_GET, () => ({
    state: session.getState(),
    sessions: session.listSessionSummaries(),
    activeSessionId: session.getActiveSessionId(),
  }));

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_LIST, payload ?? {});
    return {
      sessions: session.listSessionSummaries(),
      activeSessionId: session.getActiveSessionId(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_CREATE, payload ?? {});
    const state = session.createSession();
    return {
      state,
      sessions: session.listSessionSummaries(),
      activeSessionId: session.getActiveSessionId(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_SWITCH, payload);
    const state = session.switchSession(req.sessionId);
    return {
      state,
      sessions: session.listSessionSummaries(),
      activeSessionId: session.getActiveSessionId(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CLOSE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_CLOSE, payload);
    const state = session.closeSession(req.sessionId);
    return {
      state,
      sessions: session.listSessionSummaries(),
      activeSessionId: session.getActiveSessionId(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SET_MODE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_SET_MODE, payload);
    session.setMode(req.mode);
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CONFIRM_PLAN, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_CONFIRM_PLAN, payload);
    return session.confirmPlan({
      createBranch: req.createBranch,
      ...(req.branchName !== undefined ? { branchName: req.branchName } : {}),
    });
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_SEND_MESSAGE, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_SEND_MESSAGE, payload);
    const planAnswers = req.planAnswers?.map((a) => ({
      questionId: a.questionId,
      answer: a.answer,
      ...(a.selectedOptionIds ? { selectedOptionIds: a.selectedOptionIds } : {}),
    }));
    await session.sendMessage(
      req.content,
      planAnswers ? { planAnswers } : undefined,
    );
    return { accepted: true };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_APPROVE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_APPROVE, payload);
    session.approve(req.approvalId, req.grantCategory);
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_REJECT, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_REJECT, payload);
    session.reject(req.approvalId);
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CANCEL, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_CANCEL, payload ?? {});
    session.cancel();
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT_DIAGNOSTICS, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_EXPORT_DIAGNOSTICS, payload ?? {});
    return session.exportDiagnostics();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_OPEN, async (_event, payload) => {
    let path = payload?.path as string | undefined;
    if (!path) {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths[0]) {
        return { workspace: null, canceled: true };
      }
      path = result.filePaths[0];
    } else {
      safeValidate(IPC_CHANNELS.WORKSPACE_OPEN, payload);
    }
    const workspace = session.openWorkspace(path);
    return { workspace, canceled: false };
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_RECENT, () => ({
    workspaces: session.listRecent(),
  }));

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GIT_STATUS, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_GIT_STATUS, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return { isRepo: false, localBranch: null, remoteBranch: null };
    }
    const info = await new GitService(root).branchInfo();
    if (!info.isRepo) {
      console.warn("[workspace:git-status] not a repo (or git failed) at", root);
    }
    return info;
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_BRANCHES, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_LIST_BRANCHES, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return { isRepo: false, branches: [], current: null };
    }
    const git = new GitService(root);
    const info = await git.branchInfo();
    if (!info.isRepo) {
      return { isRepo: false, branches: [], current: null };
    }
    const branches = await git.listTakenBranchNames();
    return {
      isRepo: true,
      branches,
      current: info.localBranch,
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_VERIFY, async (_event, payload) => {
    try {
      const req = safeValidate(IPC_CHANNELS.PROVIDER_VERIFY, payload);
      assertHttpsForRemote(req.baseUrl);
      const provider = new OpenAiCompatibleProvider({
        baseUrl: req.baseUrl,
        apiKey: req.apiKey,
        ...(req.model ? { defaultModel: req.model } : {}),
      });
      const models = (await provider.listModels()).map((m) => m.id);
      // Persist key only when present; empty is fine for local providers.
      if (req.apiKey.trim()) {
        await credentials.set(CREDENTIAL_SERVICE, "default", req.apiKey);
      }
      return { ok: true, models };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR" as const,
          userMessage: "Could not list models from provider.",
          technicalDetail:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_LIST_MODELS, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.PROVIDER_LIST_MODELS, payload);
    const provider = new MockProvider({ name: "list", steps: [] });
    const models = await provider.listModels();
    return { models: models.map((m) => m.id) };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_SAVE_CONFIG, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.PROVIDER_SAVE_CONFIG, payload);
    storage.setPreference("providerConfig", {
      baseUrl: req.baseUrl,
      defaultModel: req.defaultModel,
    });
    if (req.apiKey.trim()) {
      await credentials.set(CREDENTIAL_SERVICE, "default", req.apiKey);
    }
    return { saved: true };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_GET_CONFIG, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.PROVIDER_GET_CONFIG, payload ?? {});
    const cfg = storage.getPreference<{
      baseUrl?: string;
      defaultModel?: string;
    }>("providerConfig");
    const apiKey = await credentials.get(CREDENTIAL_SERVICE, "default");
    return {
      baseUrl: cfg?.baseUrl ?? null,
      defaultModel: cfg?.defaultModel ?? null,
      apiKey: apiKey ?? null,
    };
  });

  ipcMain.on(IPC_CHANNELS.SESSION_SUBSCRIBE, (event) => {
    const unsubscribe = session.subscribe((payload) => {
      const update: SessionUpdateEvent = {
        state: payload.state,
        fullSync: payload.fullSync,
        sessions: payload.sessions,
        activeSessionId: payload.activeSessionId,
      };
      event.sender.send(`${IPC_CHANNELS.SESSION_SUBSCRIBE}:update`, update);
    });
    event.sender.once("destroyed", unsubscribe);
  });
}

function safeValidate<T extends IpcRequestChannel>(
  channel: T,
  payload: unknown,
): ReturnType<typeof validateIpcRequest<T>> {
  try {
    return validateIpcRequest(channel, payload);
  } catch (error) {
    invalidMessageCount += 1;
    console.warn(`Invalid IPC message on ${channel}:`, error);
    throw error;
  }
}

export function getInvalidMessageCount(): number {
  return invalidMessageCount;
}
