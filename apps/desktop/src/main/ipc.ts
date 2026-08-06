import { ipcMain, dialog, shell } from "electron";
import {
  AppError,
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
import {
  GitService,
  ArchitectureStore,
  createEmptyProject,
  GhCli,
  validateProjectName,
  FilesystemService,
} from "@ai-ide/workspace";
import { ARCHITECTURE_FILE_PATH } from "@ai-ide/shared";
import type { SessionManager } from "./session.js";

let invalidMessageCount = 0;

function errorPayload(error: unknown): {
  code:
    | "VALIDATION_ERROR"
    | "NOT_FOUND"
    | "PERMISSION_DENIED"
    | "PROVIDER_ERROR"
    | "PROVIDER_TIMEOUT"
    | "INTERNAL_ERROR"
    | "KEYCHAIN_UNAVAILABLE";
  userMessage: string;
  technicalDetail: string;
} {
  if (error instanceof AppError) {
    return {
      code: error.code as
        | "VALIDATION_ERROR"
        | "NOT_FOUND"
        | "PERMISSION_DENIED"
        | "PROVIDER_ERROR"
        | "PROVIDER_TIMEOUT"
        | "INTERNAL_ERROR"
        | "KEYCHAIN_UNAVAILABLE",
      userMessage: error.userMessage,
      technicalDetail: error.technicalDetail,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    userMessage: "Something went wrong.",
    technicalDetail: error instanceof Error ? error.message : String(error),
  };
}

export function registerIpcHandlers(
  session: SessionManager,
  credentials: CredentialStore,
  storage: ProjectStorage,
): void {
  const gh = new GhCli({
    openUrl: (url) => shell.openExternal(url),
  });
  let githubLoginAbort: AbortController | null = null;

  function githubStatusPayload() {
    return gh.status().then((status) => ({
      installed: status.installed,
      authenticated: status.authenticated,
      login: status.login,
      owners: status.owners,
      detail: status.detail,
    }));
  }
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
      ...(req.baseBranch !== undefined ? { baseBranch: req.baseBranch } : {}),
      ...(req.dirtyStrategy !== undefined
        ? { dirtyStrategy: req.dirtyStrategy }
        : {}),
      ...(req.baseCommitMessage !== undefined
        ? { baseCommitMessage: req.baseCommitMessage }
        : {}),
    });
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_REJECT_PLAN_READY, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_REJECT_PLAN_READY, payload ?? {});
    return session.rejectPlanReady();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DRAFT_BUILD_COMMIT, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_DRAFT_BUILD_COMMIT, payload ?? {});
    return session.draftBuildCommitMessage();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_COMMIT_BUILD, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_COMMIT_BUILD, payload);
    return session.commitBuild(req.message);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DISMISS_BUILD_COMMIT, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_DISMISS_BUILD_COMMIT, payload ?? {});
    return session.dismissBuildCommit();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_INTEGRATE_BUILD, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_INTEGRATE_BUILD, payload);
    return session.integrateBuild(req.action);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DISMISS_BUILD_INTEGRATE, (_event, payload) => {
    safeValidate(IPC_CHANNELS.SESSION_DISMISS_BUILD_INTEGRATE, payload ?? {});
    return session.dismissBuildIntegrate();
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

  ipcMain.handle(IPC_CHANNELS.SESSION_APPROVE, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_APPROVE, payload);
    await session.approve(req.approvalId, req.grantCategory);
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_REJECT, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_REJECT, payload);
    session.reject(req.approvalId);
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_TERMINAL_CONFIRM, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_TERMINAL_CONFIRM, payload);
    session.resolveTerminalConfirm(
      req.confirmId,
      req.action,
      req.text,
    );
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_TERMINAL_CONFIRM_EDIT, (_event, payload) => {
    const req = safeValidate(
      IPC_CHANNELS.SESSION_TERMINAL_CONFIRM_EDIT,
      payload,
    );
    session.editTerminalConfirm(req.confirmId, req.text);
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_TERMINAL_ASK, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.SESSION_TERMINAL_ASK, payload);
    session.resolveTerminalAsk({
      askId: req.askId,
      selectedOptionId: req.selectedOptionId ?? null,
      text: req.text,
      cancelled: req.cancelled,
    });
    return { state: session.getState() };
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_LIST, (_event, payload) => {
    safeValidate(IPC_CHANNELS.TERMINAL_LIST, payload ?? {});
    return { terminals: session.listLiveTerminals() };
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE_USER, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.TERMINAL_WRITE_USER, payload);
    session.writeUserTerminal(req.terminalId, req.text);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.TERMINAL_RESIZE, payload);
    session.resizeTerminal(req.terminalId, req.cols, req.rows);
    return { ok: true };
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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK_DIRECTORY, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_PICK_DIRECTORY, payload ?? {});
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { path: null, canceled: true };
    }
    return { path: result.filePaths[0], canceled: false };
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE_PROJECT, async (_event, payload) => {
    try {
      const req = safeValidate(IPC_CHANNELS.WORKSPACE_CREATE_PROJECT, payload);
      validateProjectName(req.name);
      const projectPath = await createEmptyProject(req.parentPath, req.name);
      const git = new GitService(projectPath);
      const mode = req.github?.mode ?? "skip";
      let githubRepoUrl: string | undefined;

      if (mode === "remote_url") {
        const url = req.github?.remoteUrl?.trim();
        if (!url) {
          throw new AppError({
            code: "VALIDATION_ERROR",
            userMessage: "Remote URL is required.",
            technicalDetail: "missing remoteUrl",
          });
        }
        await git.addRemote("origin", url);
        githubRepoUrl = url;
      } else if (mode === "create") {
        const repoName = validateProjectName(
          req.github?.repoName?.trim() || req.name,
        );
        const owner = req.github?.owner?.trim();
        if (!owner) {
          throw new AppError({
            code: "VALIDATION_ERROR",
            userMessage: "Choose a GitHub account or organization.",
            technicalDetail: "missing owner",
          });
        }
        const repo = await gh.createRepo({
          cwd: projectPath,
          name: repoName,
          owner,
          private: req.github?.private ?? true,
        });
        githubRepoUrl = repo.htmlUrl || repo.cloneUrl;
      }

      const workspace = session.openWorkspace(projectPath);
      return {
        ok: true,
        workspace,
        ...(githubRepoUrl ? { githubRepoUrl } : {}),
      };
    } catch (error) {
      return { ok: false, error: errorPayload(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_RECENT, () => ({
    workspaces: session.listRecent(),
  }));

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GIT_STATUS, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_GIT_STATUS, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        isRepo: false,
        localBranch: null,
        remoteBranch: null,
        hasRemote: false,
      };
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
      return {
        isRepo: false,
        branches: [],
        current: null,
        localBranches: [],
        dirty: false,
        dirtyFileCount: 0,
      };
    }
    const git = new GitService(root);
    const info = await git.branchInfo();
    if (!info.isRepo) {
      return {
        isRepo: false,
        branches: [],
        current: null,
        localBranches: [],
        dirty: false,
        dirtyFileCount: 0,
      };
    }
    const branches = await git.listTakenBranchNames();
    const localBranches = await git.listLocalBranchesDetailed();
    const dirty = await git.isDirty();
    const dirtyFileCount = dirty ? await git.dirtyFileCount() : 0;
    return {
      isRepo: true,
      branches,
      current: info.localBranch,
      localBranches,
      dirty,
      dirtyFileCount,
    };
  });

  const HIDDEN_DIR_NAMES = new Set([
    "node_modules",
    ".git",
    "dist",
    "out",
    "release",
    ".DS_Store",
  ]);

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_DIR, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.WORKSPACE_LIST_DIR, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        path: req.path,
        entries: [],
        error: {
          code: "VALIDATION_ERROR" as const,
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }
    try {
      const fs = new FilesystemService(root);
      const entries = fs
        .listDetailed(req.path)
        .filter((e) => !HIDDEN_DIR_NAMES.has(e.name) && !e.name.startsWith(".env"))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { path: req.path, entries };
    } catch (error) {
      return {
        path: req.path,
        entries: [],
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.WORKSPACE_READ_FILE, payload);
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        path: req.path,
        error: {
          code: "VALIDATION_ERROR" as const,
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }
    try {
      const fs = new FilesystemService(root);
      const content = fs.read(req.path);
      return { path: req.path, content, truncated: false };
    } catch (error) {
      return {
        path: req.path,
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DIFF_FILES, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_DIFF_FILES, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        base: null,
        files: [],
        error: {
          code: "VALIDATION_ERROR" as const,
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }
    try {
      const git = new GitService(root);
      const info = await git.branchInfo();
      if (!info.isRepo) {
        return { base: null, files: [] };
      }
      const base = await git.resolveBranchDiffBase();
      const files = await git.listBranchChangedFiles();
      return { base, files };
    } catch (error) {
      return {
        base: null,
        files: [],
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DIFF_FILE, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.WORKSPACE_DIFF_FILE, payload);
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        path: req.path,
        base: null,
        patch: "",
        untracked: false,
        error: {
          code: "VALIDATION_ERROR" as const,
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }
    try {
      const git = new GitService(root);
      const result = await git.fileDiffAgainstBase(req.path);
      return {
        path: req.path,
        base: result.base,
        patch: result.patch,
        untracked: result.untracked,
      };
    } catch (error) {
      return {
        path: req.path,
        base: null,
        patch: "",
        untracked: false,
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_GET, (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_GET, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        path: ARCHITECTURE_FILE_PATH,
        exists: false,
        fromFile: false,
        profile: null,
      };
    }
    const store = new ArchitectureStore(root);
    const view = store.loadEffective();
    if (view.error) {
      return {
        path: view.path,
        exists: view.exists,
        fromFile: false,
        profile: null,
        error: view.error,
      };
    }
    return {
      path: view.path,
      exists: view.exists,
      fromFile: view.fromFile,
      profile: view.effective,
      derived: view.derived,
      overrides: view.overrides,
      intent: view.intent,
      drift: view.drift,
    };
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_DETECT, (_event, payload) => {
    safeValidate(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_DETECT, payload ?? {});
    const root = session.getState().workspace?.resolvedRootPath;
    if (!root) {
      return {
        path: ARCHITECTURE_FILE_PATH,
        fromFile: false,
        profile: {
          version: 1 as const,
          runtimes: [],
          meta: { updatedAt: new Date().toISOString(), sources: {} },
        },
      };
    }
    const store = new ArchitectureStore(root);
    const view = store.loadEffective();
    return {
      path: view.path,
      fromFile: view.fromFile,
      profile: view.derived,
      intent: view.intent,
      drift: view.drift,
    };
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_SAVE, (_event, payload) => {
    try {
      const req = safeValidate(IPC_CHANNELS.WORKSPACE_ARCHITECTURE_SAVE, payload);
      const root = session.getState().workspace?.resolvedRootPath;
      if (!root) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR" as const,
            userMessage: "Open a workspace before saving architecture.",
            technicalDetail: "no workspace",
          },
        };
      }
      const store = new ArchitectureStore(root);
      const source = req.confirm ? "user_confirmed" : "agent_proposed";
      let profile;
      if (req.profile) {
        profile = store.save(req.profile, source, req.intent);
      } else if (req.patch) {
        profile = store.savePatch(req.patch, source, req.intent);
      } else if (req.intent !== undefined) {
        profile = store.saveIntent(req.intent, source);
      } else {
        const draft = store.loadOrDetect().profile;
        profile = store.save(draft, source);
      }
      const view = store.loadEffective();
      return {
        ok: true,
        profile,
        intent: view.intent,
        drift: view.drift,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR" as const,
          userMessage: "Could not save architecture profile.",
          technicalDetail:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
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
      const detail =
        error instanceof AppError
          ? error.technicalDetail || error.userMessage
          : error instanceof Error
            ? error.message
            : String(error);
      const userMessage =
        error instanceof AppError
          ? error.userMessage
          : "Could not list models from provider.";
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR" as const,
          userMessage,
          technicalDetail: detail,
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
    const store = session.getProviderStore();
    if (!store) {
      // Fallback legacy write
      storage.setPreference("providerConfig", {
        baseUrl: req.baseUrl,
        defaultModel: req.defaultModel,
      });
      if (req.apiKey.trim()) {
        await credentials.set(CREDENTIAL_SERVICE, "default", req.apiKey);
      }
      return { saved: true };
    }
    const paid =
      req.paid ??
      !["localhost", "127.0.0.1", "::1"].some((h) =>
        req.baseUrl.includes(h),
      );
    const saved = store.upsertProvider({
      ...(req.id ? { id: req.id } : {}),
      name: req.name?.trim() || (paid ? "Cloud provider" : "Local provider"),
      baseUrl: req.baseUrl,
      defaultModel: req.defaultModel,
      paid,
      ...(req.pricing ? { pricing: req.pricing } : {}),
      ...(req.apiKey.trim() ? { apiKey: req.apiKey } : {}),
      makeActive: req.makeActive !== false,
    });
    // Keep legacy preference in sync for older code paths.
    storage.setPreference("providerConfig", {
      baseUrl: saved.baseUrl,
      defaultModel: saved.defaultModel,
    });
    session.syncProviderHud();
    return { saved: true, id: saved.id };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_GET_CONFIG, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.PROVIDER_GET_CONFIG, payload ?? {});
    const store = session.getProviderStore();
    if (store) {
      const active = store.getActive();
      if (active) {
        const apiKey = await store.getApiKey(active.id);
        return {
          id: active.id,
          name: active.name,
          baseUrl: active.baseUrl,
          defaultModel: active.defaultModel,
          apiKey: apiKey || null,
          paid: active.paid,
          pricing: active.pricing ?? null,
        };
      }
    }
    const cfg = storage.getPreference<{
      baseUrl?: string;
      defaultModel?: string;
    }>("providerConfig");
    const apiKey = await credentials.get(CREDENTIAL_SERVICE, "default");
    return {
      id: null,
      name: null,
      baseUrl: cfg?.baseUrl ?? null,
      defaultModel: cfg?.defaultModel ?? null,
      apiKey: apiKey ?? null,
      paid: undefined,
      pricing: null,
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_LIST, (_event, payload) => {
    safeValidate(IPC_CHANNELS.PROVIDER_LIST, payload ?? {});
    const store = session.getProviderStore();
    const registry = store?.loadRegistry() ?? {
      providers: [],
      activeId: null,
      usageByProviderId: {},
    };
    return {
      activeId: registry.activeId,
      providers: registry.providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        paid: p.paid,
        ...(p.pricing ? { pricing: p.pricing } : {}),
      })),
    };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_SET_ACTIVE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.PROVIDER_SET_ACTIVE, payload);
    const store = session.getProviderStore();
    if (!store?.setActive(req.id)) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND" as const,
          userMessage: "Provider not found.",
          technicalDetail: req.id,
        },
      };
    }
    const active = store.getActive();
    if (active) {
      storage.setPreference("providerConfig", {
        baseUrl: active.baseUrl,
        defaultModel: active.defaultModel,
      });
    }
    session.syncProviderHud();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.PROVIDER_DELETE, (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.PROVIDER_DELETE, payload);
    const store = session.getProviderStore();
    if (!store?.deleteProvider(req.id)) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND" as const,
          userMessage: "Provider not found.",
          technicalDetail: req.id,
        },
      };
    }
    session.syncProviderHud();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_STATUS, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.GITHUB_STATUS, payload ?? {});
    return githubStatusPayload();
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_LOGOUT, async (_event, payload) => {
    try {
      const req = safeValidate(IPC_CHANNELS.GITHUB_LOGOUT, payload ?? {});
      await gh.logout(req.user ?? null);
      return {
        ok: true,
        status: await githubStatusPayload(),
      };
    } catch (error) {
      return { ok: false, error: errorPayload(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_LOGIN_WEB, async (_event, payload) => {
    try {
      safeValidate(IPC_CHANNELS.GITHUB_LOGIN_WEB, payload ?? {});
      if (githubLoginAbort) {
        githubLoginAbort.abort();
        githubLoginAbort = null;
      }
      githubLoginAbort = new AbortController();
      const signal = githubLoginAbort.signal;
      await gh.loginWeb(signal);
      githubLoginAbort = null;
      return {
        ok: true,
        status: await githubStatusPayload(),
      };
    } catch (error) {
      githubLoginAbort = null;
      return { ok: false, error: errorPayload(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_LOGIN_TOKEN, async (_event, payload) => {
    try {
      const req = safeValidate(IPC_CHANNELS.GITHUB_LOGIN_TOKEN, payload);
      if (githubLoginAbort) {
        githubLoginAbort.abort();
        githubLoginAbort = null;
      }
      githubLoginAbort = new AbortController();
      await gh.loginWithToken(req.token, githubLoginAbort.signal);
      githubLoginAbort = null;
      return {
        ok: true,
        status: await githubStatusPayload(),
      };
    } catch (error) {
      githubLoginAbort = null;
      return { ok: false, error: errorPayload(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GITHUB_LOGIN_CANCEL, (_event, payload) => {
    safeValidate(IPC_CHANNELS.GITHUB_LOGIN_CANCEL, payload ?? {});
    if (githubLoginAbort) {
      githubLoginAbort.abort();
      githubLoginAbort = null;
    }
    return { canceled: true };
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

  ipcMain.on(IPC_CHANNELS.TERMINAL_SUBSCRIBE, (event) => {
    const unsubscribe = session.subscribeTerminalChunks((chunk) => {
      event.sender.send(`${IPC_CHANNELS.TERMINAL_SUBSCRIBE}:data`, chunk);
    });
    event.sender.once("destroyed", unsubscribe);
  });

  const engine = session.getEngine();

  ipcMain.handle(IPC_CHANNELS.ENGINE_STATUS, (_event, payload) => {
    safeValidate(IPC_CHANNELS.ENGINE_STATUS, payload ?? {});
    return engine.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_ENSURE, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.ENGINE_ENSURE, payload ?? {});
    try {
      await engine.ensureInstalled();
      return { ok: true, status: engine.getStatus() };
    } catch (error) {
      return {
        ok: false,
        status: engine.getStatus(),
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_INDEX, async (_event, payload) => {
    const req = safeValidate(IPC_CHANNELS.ENGINE_INDEX, payload ?? {});
    try {
      await engine.startIndexing({
        ...(req.mode ? { mode: req.mode } : {}),
      });
      return { ok: true, status: engine.getStatus() };
    } catch (error) {
      return {
        ok: false,
        status: engine.getStatus(),
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_INDEX_CANCEL, (_event, payload) => {
    safeValidate(IPC_CHANNELS.ENGINE_INDEX_CANCEL, payload ?? {});
    engine.cancelIndexing();
    return { status: engine.getStatus() };
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_INDEX_REFRESH, async (_event, payload) => {
    safeValidate(IPC_CHANNELS.ENGINE_INDEX_REFRESH, payload ?? {});
    try {
      await engine.refreshIndexState();
      return { ok: true, status: engine.getStatus() };
    } catch (error) {
      return {
        ok: false,
        status: engine.getStatus(),
        error: errorPayload(error),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_STDERR, (_event, payload) => {
    safeValidate(IPC_CHANNELS.ENGINE_STDERR, payload ?? {});
    return { stderr: engine.getStderrTail() };
  });

  ipcMain.on(IPC_CHANNELS.ENGINE_SUBSCRIBE, (event) => {
    const unsubscribe = engine.subscribe((status) => {
      event.sender.send(`${IPC_CHANNELS.ENGINE_SUBSCRIBE}:update`, status);
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
