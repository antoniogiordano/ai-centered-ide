import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  AgentMode,
  SessionState,
  SessionSummary,
  WorkspaceRef,
} from "@ai-ide/shared";
import { createEmptySessionState, deriveProductPhase } from "@ai-ide/shared";
import type { ProjectStorage } from "@ai-ide/storage";
import { MockProvider, OpenAiCompatibleProvider } from "@ai-ide/provider";
import {
  applyPlanAnswers,
  applyStartBuilding,
  normalizeFeatBranchName,
  normalizePlanQuestions,
  runAgentTurn,
  resumeAgentTurn,
  tryParsePartialJson,
  type AgentProgressEvent,
  type PlanAnswerInput,
  type PausedAgentTurn,
} from "@ai-ide/agent";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import type { TerminalHost } from "@ai-ide/tools";
import { app } from "electron";
import type { CredentialStore } from "@ai-ide/storage";
import { CREDENTIAL_SERVICE } from "@ai-ide/storage";
import { TerminalManager } from "./terminals.js";
import { CbmEngine } from "./engine/cbm-engine.js";
import type { CbmHost } from "@ai-ide/tools";

const TERMINAL_CONFIRM_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withNewline(text: string, appendNewline: boolean): string {
  if (!appendNewline) return text;
  if (text.endsWith("\n") || text.endsWith("\r")) return text;
  return `${text}\n`;
}

type RecentWorkspace = {
  projectId: string;
  rootPath: string;
  name: string;
  lastOpenedAt: string;
};

type ProviderConfig = {
  baseUrl: string;
  defaultModel: string;
};

type SessionListener = (event: {
  state: SessionState;
  fullSync: boolean;
  sessions: SessionSummary[];
  activeSessionId: string;
}) => void;

const ACTIVE_SESSION_KEY = "activeSessionId";

function titleFromTurns(turns: SessionState["turns"]): string {
  const firstUser = turns.find((t) => t.role === "user");
  if (!firstUser?.content.trim()) return "New chat";
  const compact = firstUser.content.trim().replace(/\s+/g, " ");
  return compact.length > 40 ? `${compact.slice(0, 37)}…` : compact;
}

function isBusy(status: SessionState["status"]): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running"
  );
}

function summarizeStreamingToolArgs(
  name: string,
  argumentsJson: string,
): string | null {
  const parsed = tryParsePartialJson(argumentsJson);
  if (!parsed || typeof parsed !== "object") {
    const chars = argumentsJson.trim().length;
    return chars > 0 ? `Streaming arguments… ${chars} chars` : null;
  }
  const args = parsed as Record<string, unknown>;
  if (name === "upsert_plan") {
    const phases = Array.isArray(args.phases) ? args.phases : [];
    const questions = Array.isArray(args.questions) ? args.questions : [];
    const phaseTitles = phases
      .map((p) => {
        const row = (p ?? {}) as Record<string, unknown>;
        return typeof row.title === "string" ? row.title.trim() : "";
      })
      .filter(Boolean);
    const bits = [
      `${phases.length} phase${phases.length === 1 ? "" : "s"}`,
      `${questions.length} question${questions.length === 1 ? "" : "s"}`,
    ];
    if (phaseTitles[0]) bits.push(`latest: ${phaseTitles[phaseTitles.length - 1]}`);
    return bits.join(" · ");
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "Streaming arguments…";
  return `args: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""}`;
}

export class SessionManager {
  private state: SessionState;
  private createdAt: string;
  private listeners = new Set<SessionListener>();
  private abort: AbortController | null = null;
  private credentials: CredentialStore | null = null;
  private tokenFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly terminals = new TerminalManager();
  private terminalHost: TerminalHost;
  private readonly engine = new CbmEngine();
  private cbmHost: CbmHost;
  private confirmWaiters = new Map<
    string,
    {
      resolve: (value: { approved: boolean; text: string }) => void;
      timer: ReturnType<typeof setTimeout>;
      onAbort: () => void;
    }
  >();
  private askWaiters = new Map<
    string,
    {
      resolve: (value: {
        selectedOptionId: string | null;
        text: string;
        cancelled: boolean;
      }) => void;
    }
  >();
  private terminalChunkListeners = new Set<
    (event: { terminalId: string; data: string; sequence: number }) => void
  >();
  private liveSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedTurn: PausedAgentTurn | null = null;

  constructor(private readonly storage: ProjectStorage) {
    const boot = this.bootstrap();
    this.state = boot.state;
    this.createdAt = boot.createdAt;
    this.terminalHost = this.createTerminalHost();
    this.cbmHost = this.createCbmHost();
    this.terminals.onChange(() => this.scheduleLiveTerminalSync());
    this.terminals.onChunk((event) => {
      for (const listener of this.terminalChunkListeners) listener(event);
    });
    void this.engine.refreshBinaryFlag();
    const bootRoot = this.state.workspace?.resolvedRootPath;
    if (bootRoot) {
      void this.engine.attachWorkspace(bootRoot);
    }
  }

  getEngine(): CbmEngine {
    return this.engine;
  }

  private createCbmHost(): CbmHost {
    return {
      isIndexed: () => this.engine.isIndexed(),
      callTool: (name, args) => this.engine.callModelTool(name, args),
      architecturePreseed: () => this.engine.architecturePreseed(),
    };
  }

  private scheduleLiveTerminalSync(): void {
    if (this.liveSyncTimer) return;
    this.liveSyncTimer = setTimeout(() => {
      this.liveSyncTimer = null;
      const next = this.terminals.list();
      const prev = this.state.liveTerminals;
      if (JSON.stringify(prev) === JSON.stringify(next)) return;
      this.state = { ...this.state, liveTerminals: next };
      this.push();
    }, 80);
  }

  private syncLiveTerminals(): void {
    this.state = { ...this.state, liveTerminals: this.terminals.list() };
  }

  subscribeTerminalChunks(
    listener: (event: {
      terminalId: string;
      data: string;
      sequence: number;
    }) => void,
  ): () => void {
    this.terminalChunkListeners.add(listener);
    return () => this.terminalChunkListeners.delete(listener);
  }

  listLiveTerminals() {
    return this.terminals.list();
  }

  writeUserTerminal(terminalId: string, text: string): void {
    this.terminals.writeRaw(terminalId, text);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.terminals.resize(terminalId, cols, rows);
  }

  private clearTerminalWaiters(reason: "cancel" | "dispose"): void {
    for (const [id, waiter] of this.confirmWaiters) {
      clearTimeout(waiter.timer);
      this.abort?.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve({ approved: false, text: "" });
      this.confirmWaiters.delete(id);
    }
    for (const [id, waiter] of this.askWaiters) {
      waiter.resolve({ selectedOptionId: null, text: "", cancelled: true });
      this.askWaiters.delete(id);
    }
    if (
      this.state.pendingTerminalConfirm ||
      this.state.pendingTerminalAsk ||
      reason === "dispose"
    ) {
      this.state = {
        ...this.state,
        pendingTerminalConfirm: null,
        pendingTerminalAsk: null,
      };
    }
  }

  private waitTerminalConfirm(
    terminalId: string,
    text: string,
    appendNewline: boolean,
  ): Promise<{ approved: boolean; text: string }> {
    const id = randomUUID();
    const durationMs = TERMINAL_CONFIRM_MS;
    const deadlineAt = new Date(Date.now() + durationMs).toISOString();
    this.state = {
      ...this.state,
      pendingTerminalConfirm: {
        id,
        terminalId,
        text,
        appendNewline,
        deadlineAt,
        durationMs,
      },
      activityLabel: "Confirm terminal input…",
    };
    this.push();

    return new Promise((resolve) => {
      const finish = (approved: boolean, finalText: string) => {
        const waiter = this.confirmWaiters.get(id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.abort?.signal.removeEventListener("abort", waiter.onAbort);
        this.confirmWaiters.delete(id);
        if (this.state.pendingTerminalConfirm?.id === id) {
          this.state = {
            ...this.state,
            pendingTerminalConfirm: null,
          };
          this.push();
        }
        resolve({ approved, text: finalText });
      };
      const onAbort = () => finish(false, text);
      const timer = setTimeout(() => {
        const pending = this.state.pendingTerminalConfirm;
        const finalText = pending?.id === id ? pending.text : text;
        finish(true, finalText);
      }, durationMs);
      this.confirmWaiters.set(id, { resolve, timer, onAbort });
      if (this.abort?.signal.aborted) {
        finish(false, text);
        return;
      }
      this.abort?.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  resolveTerminalConfirm(
    confirmId: string,
    action: "approve" | "cancel",
    text?: string,
  ): void {
    const pending = this.state.pendingTerminalConfirm;
    if (!pending || pending.id !== confirmId) return;
    const waiter = this.confirmWaiters.get(confirmId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.abort?.signal.removeEventListener("abort", waiter.onAbort);
    this.confirmWaiters.delete(confirmId);
    const finalText = text !== undefined ? text : pending.text;
    this.state = {
      ...this.state,
      pendingTerminalConfirm: null,
    };
    this.push();
    waiter.resolve({ approved: action === "approve", text: finalText });
  }

  editTerminalConfirm(confirmId: string, text: string): void {
    const pending = this.state.pendingTerminalConfirm;
    if (!pending || pending.id !== confirmId) return;
    this.state = {
      ...this.state,
      pendingTerminalConfirm: { ...pending, text },
    };
    this.push();
  }

  private waitTerminalAsk(params: {
    terminalId: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    suggestedText: string;
    writeToTerminal: boolean;
    appendNewline: boolean;
  }): Promise<{
    selectedOptionId: string | null;
    text: string;
    cancelled: boolean;
  }> {
    const id = randomUUID();
    this.state = {
      ...this.state,
      pendingTerminalAsk: {
        id,
        terminalId: params.terminalId,
        prompt: params.prompt,
        options: params.options,
        suggestedText: params.suggestedText,
        writeToTerminal: params.writeToTerminal,
        appendNewline: params.appendNewline,
      },
      activityLabel: "Waiting for terminal decision…",
    };
    this.push();
    return new Promise((resolve) => {
      this.askWaiters.set(id, { resolve });
    });
  }

  resolveTerminalAsk(input: {
    askId: string;
    selectedOptionId?: string | null;
    text: string;
    cancelled?: boolean;
  }): void {
    const pending = this.state.pendingTerminalAsk;
    if (!pending || pending.id !== input.askId) return;
    const waiter = this.askWaiters.get(input.askId);
    if (!waiter) return;
    this.askWaiters.delete(input.askId);
    this.state = {
      ...this.state,
      pendingTerminalAsk: null,
    };
    this.push();
    waiter.resolve({
      selectedOptionId: input.selectedOptionId ?? null,
      text: input.text,
      cancelled: Boolean(input.cancelled),
    });
  }

  private createTerminalHost(): TerminalHost {
    return {
      open: async (opts) => {
        const root = this.state.workspace?.resolvedRootPath;
        if (!root) throw new Error("Open a workspace first.");
        const cwd = this.terminals.resolveCwd(root, opts?.cwd);
        const live = this.terminals.open({
          cwd,
          ...(opts?.title ? { title: opts.title } : {}),
        });
        this.syncLiveTerminals();
        this.push();
        return {
          id: live.id,
          title: live.title,
          status: live.status,
          pid: live.pid,
          cwd: live.cwd,
          exitCode: live.exitCode,
        };
      },
      list: () =>
        this.terminals.list().map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          pid: t.pid,
          cwd: t.cwd,
          exitCode: t.exitCode,
        })),
      read: (id, opts) => this.terminals.read(id, opts?.maxChars),
      write: async (id, text, opts) => {
        const appendNewline = opts?.appendNewline !== false;
        const decision = await this.waitTerminalConfirm(id, text, appendNewline);
        const snapshot = this.terminals.read(id);
        if (!decision.approved) {
          return {
            written: false,
            cancelled: true,
            text: withNewline(decision.text || text, appendNewline),
            output: snapshot.output,
            status: snapshot.status,
            exitCode: snapshot.exitCode,
          };
        }
        const payload = withNewline(decision.text, appendNewline);
        this.terminals.writeRaw(id, payload);
        await sleep(opts?.settleMs ?? 500);
        const after = this.terminals.read(id);
        this.syncLiveTerminals();
        this.push();
        return {
          written: true,
          cancelled: false,
          text: payload,
          output: after.output,
          status: after.status,
          exitCode: after.exitCode,
        };
      },
      ask: async (params) => {
        const decision = await this.waitTerminalAsk({
          terminalId: params.terminalId,
          prompt: params.prompt,
          options: params.options,
          suggestedText: params.suggestedText ?? "",
          writeToTerminal: params.writeToTerminal !== false,
          appendNewline: params.appendNewline !== false,
        });
        const appendNewline = params.appendNewline !== false;
        const writeToTerminal = params.writeToTerminal !== false;
        if (decision.cancelled) {
          const snap = this.terminals.read(params.terminalId);
          return {
            selectedOptionId: null,
            text: decision.text,
            written: false,
            cancelled: true,
            output: snap.output,
          };
        }
        let written = false;
        let payload = decision.text;
        if (writeToTerminal && payload.length > 0) {
          payload = withNewline(payload, appendNewline);
          this.terminals.writeRaw(params.terminalId, payload);
          written = true;
          await sleep(400);
        }
        const after = this.terminals.read(params.terminalId);
        this.syncLiveTerminals();
        this.push();
        return {
          selectedOptionId: decision.selectedOptionId,
          text: payload,
          written,
          cancelled: false,
          output: after.output,
        };
      },
      close: async (id) => {
        const closed = this.terminals.close(id);
        this.syncLiveTerminals();
        this.push();
        return { closed };
      },
    };
  }

  private bootstrap(): { state: SessionState; createdAt: string } {
    const existing = this.storage.listConversations();
    const preferred = this.storage.getPreference<string>(ACTIVE_SESSION_KEY);
    if (existing.length === 0) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const state = createEmptySessionState(id);
      this.storage.upsertConversation({
        id,
        projectId: "global",
        title: "New chat",
        mode: state.mode,
        workspace: null,
        planSteps: [],
        planPhases: [],
        planStatus: "drafting",
        planQuestions: [],
        planReadyProposal: null,
        sessionKind: "delivery",
        approvalGrants: [],
        createdAt: now,
        updatedAt: now,
      });
      this.storage.setPreference(ACTIVE_SESSION_KEY, id);
      return { state, createdAt: now };
    }

    const target =
      existing.find((c) => c.id === preferred) ?? existing[0]!;
    return this.hydrateFromRow(target);
  }

  private hydrateFromRow(row: {
    id: string;
    mode: AgentMode;
    workspace: WorkspaceRef | null;
    planSteps: SessionState["planSteps"];
    planPhases: SessionState["planPhases"];
    planStatus: SessionState["planStatus"];
    planQuestions: SessionState["planQuestions"];
    planReadyProposal: SessionState["planReadyProposal"];
    sessionKind?: SessionState["sessionKind"];
    approvalGrants: SessionState["approvalGrants"];
    createdAt: string;
  }): { state: SessionState; createdAt: string } {
    const turns = this.storage.loadTurns(row.id);
    const mode = row.mode === "ask" ? "plan" : row.mode;
    const sessionKindRaw = row.sessionKind ?? "delivery";
    const sessionKind =
      sessionKindRaw === "architecture" ? "delivery" : sessionKindRaw;
    const state: SessionState = {
      ...createEmptySessionState(row.id),
      mode,
      sessionKind,
      workspace: row.workspace,
      planSteps: row.planSteps,
      planPhases: row.planPhases,
      planStatus: row.planStatus,
      planQuestions: normalizePlanQuestions(row.planQuestions),
      planReadyProposal: row.planReadyProposal ?? null,
      approvalGrants: row.approvalGrants,
      turns,
      status: "idle",
    };
    this.storage.setPreference(ACTIVE_SESSION_KEY, row.id);
    return { state, createdAt: row.createdAt };
  }

  setCredentials(store: CredentialStore): void {
    this.credentials = store;
  }

  getState(): SessionState {
    return this.state;
  }

  getActiveSessionId(): string {
    return this.state.sessionId;
  }

  listSessionSummaries(): SessionSummary[] {
    const root = this.state.workspace?.resolvedRootPath ?? null;
    return this.conversationsForWorkspace(root).map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      workspaceName: c.workspace?.name ?? null,
      phase: deriveProductPhase({
        mode: c.mode,
        planStatus: c.planStatus,
        sessionKind: c.sessionKind,
      }),
    }));
  }

  private conversationsForWorkspace(root: string | null) {
    return this.storage.listConversations().filter((c) => {
      const path = c.workspace?.resolvedRootPath ?? null;
      return path === root;
    });
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener({
      state: this.state,
      fullSync: true,
      sessions: this.listSessionSummaries(),
      activeSessionId: this.state.sessionId,
    });
    return () => this.listeners.delete(listener);
  }

  private push(fullSync = false): void {
    this.state = { ...this.state, sequence: this.state.sequence + 1 };
    for (const listener of this.listeners) {
      listener({
        state: this.state,
        fullSync,
        sessions: this.listSessionSummaries(),
        activeSessionId: this.state.sessionId,
      });
    }
  }

  private persist(): void {
    const now = new Date().toISOString();
    const title = titleFromTurns(this.state.turns);
    this.storage.upsertConversation({
      id: this.state.sessionId,
      projectId: this.state.workspace?.projectId ?? "global",
      title,
      mode: this.state.mode,
      workspace: this.state.workspace,
      planSteps: this.state.planSteps,
      planPhases: this.state.planPhases,
      planStatus: this.state.planStatus,
      planQuestions: this.state.planQuestions,
      planReadyProposal: this.state.planReadyProposal,
      sessionKind: this.state.sessionKind,
      approvalGrants: this.state.approvalGrants,
      createdAt: this.createdAt,
      updatedAt: now,
    });
    this.storage.replaceTurns(this.state.sessionId, this.state.turns);
    this.storage.setPreference(ACTIVE_SESSION_KEY, this.state.sessionId);
  }

  private clearTokenFlush(): void {
    if (this.tokenFlushTimer) {
      clearTimeout(this.tokenFlushTimer);
      this.tokenFlushTimer = null;
    }
  }

  private handleProgress(event: AgentProgressEvent): void {
    if (event.type === "activity") {
      this.clearTokenFlush();
      this.state = {
        ...this.state,
        status: event.status,
        activityLabel: event.label,
      };
      this.push();
      return;
    }

    if (event.type === "token") {
      this.state = {
        ...this.state,
        status: "streaming",
        activityLabel: null,
        partialAssistantText: event.text,
      };
      if (!this.tokenFlushTimer) {
        this.tokenFlushTimer = setTimeout(() => {
          this.tokenFlushTimer = null;
          this.push();
        }, 40);
      }
      return;
    }

    if (event.type === "tool_start") {
      this.clearTokenFlush();
      const existing = this.state.liveTools.find((t) => t.id === event.call.id);
      const liveTools = [
        ...this.state.liveTools.filter((t) => t.id !== event.call.id),
        {
          id: event.call.id,
          name: event.call.name,
          label: event.label,
          status: "running" as const,
          ...(existing?.summary ? { summary: existing.summary } : {}),
        },
      ];
      this.state = {
        ...this.state,
        status: "tool",
        activityLabel: event.label,
        activeToolCallId: event.call.id,
        liveTools,
      };
      this.push();
      return;
    }

    if (event.type === "tool_args") {
      const summary = summarizeStreamingToolArgs(
        event.name,
        event.argumentsJson,
      );
      const liveTools = this.state.liveTools.some((t) => t.id === event.callId)
        ? this.state.liveTools.map((t) =>
            t.id === event.callId
              ? {
                  ...t,
                  label: event.label,
                  status: "running" as const,
                  ...(summary ? { summary } : {}),
                }
              : t,
          )
        : [
            ...this.state.liveTools,
            {
              id: event.callId,
              name: event.name,
              label: event.label,
              status: "running" as const,
              ...(summary ? { summary } : {}),
            },
          ];
      this.state = {
        ...this.state,
        status: "tool",
        activityLabel: event.label,
        activeToolCallId: event.callId,
        liveTools,
      };
      if (!this.tokenFlushTimer) {
        this.tokenFlushTimer = setTimeout(() => {
          this.tokenFlushTimer = null;
          this.push();
        }, 50);
      }
      return;
    }

    if (event.type === "tool_end") {
      this.clearTokenFlush();
      const liveTools = this.state.liveTools.map((t) =>
        t.id === event.result.callId
          ? {
              ...t,
              status: event.result.success
                ? ("done" as const)
                : ("failed" as const),
              summary: event.result.summary,
              label: event.label,
            }
          : t,
      );
      this.state = {
        ...this.state,
        activityLabel: event.label,
        activeToolCallId: null,
        liveTools,
      };
      this.push();
      return;
    }

    if (event.type === "session_patch") {
      this.clearTokenFlush();
      this.state = {
        ...this.state,
        ...event.patch,
      };
      if (!event.provisional) {
        this.persist();
      }
      this.push(true);
    }
  }

  createSession(): SessionState {
    if (isBusy(this.state.status)) {
      this.cancel();
    }
    this.persist();

    const id = randomUUID();
    const now = new Date().toISOString();
    const workspace = this.state.workspace;
    this.state = {
      ...createEmptySessionState(id),
      workspace,
      mode: "plan",
      sessionKind: "delivery",
      planStatus: "drafting",
      planPhases: [],
      planQuestions: [],
      planSteps: [],
    };
    this.createdAt = now;
    this.persist();
    this.push(true);
    return this.state;
  }

  switchSession(sessionId: string): SessionState {
    if (sessionId === this.state.sessionId) return this.state;
    const row = this.storage.getConversation(sessionId);
    if (!row) return this.state;

    if (isBusy(this.state.status)) {
      this.abort?.abort();
      this.abort = null;
      this.clearTokenFlush();
      this.state = {
        ...this.state,
        status: "idle",
        partialAssistantText: null,
        activityLabel: null,
        activeToolCallId: null,
        liveTools: [],
        error: null,
      };
    }

    this.persist();
    const hydrated = this.hydrateFromRow(row);
    this.state = hydrated.state;
    this.createdAt = hydrated.createdAt;
    this.push(true);
    return this.state;
  }

  closeSession(sessionId: string): SessionState {
    const root = this.state.workspace?.resolvedRootPath ?? null;
    const scoped = this.conversationsForWorkspace(root);
    if (scoped.length <= 1 && scoped[0]?.id === sessionId) {
      // Always keep one session in this workspace — reset it instead of deleting.
      if (sessionId === this.state.sessionId && isBusy(this.state.status)) {
        this.cancel();
      }
      const workspace = this.state.workspace;
      const id = randomUUID();
      const now = new Date().toISOString();
      this.storage.deleteConversation(sessionId);
      this.state = {
        ...createEmptySessionState(id),
        workspace,
      };
      this.createdAt = now;
      this.persist();
      this.push(true);
      return this.state;
    }

    const closingActive = sessionId === this.state.sessionId;
    if (closingActive && isBusy(this.state.status)) {
      this.abort?.abort();
      this.abort = null;
      this.clearTokenFlush();
    }

    if (!closingActive) {
      this.persist();
      this.storage.deleteConversation(sessionId);
      this.push(true);
      return this.state;
    }

    // Closing active: pick another in the same workspace, then delete.
    this.persist();
    const remaining = scoped.filter((c) => c.id !== sessionId);
    const next = remaining[0]!;
    this.storage.deleteConversation(sessionId);
    const hydrated = this.hydrateFromRow(next);
    this.state = hydrated.state;
    this.createdAt = hydrated.createdAt;
    this.push(true);
    return this.state;
  }

  setMode(mode: AgentMode): void {
    this.state = { ...this.state, mode };
    this.persist();
    this.push();
  }

  /**
   * User confirmed the draft plan in the UI. Optionally create/checkout a feat/* branch,
   * then switch this chat to Build mode.
   */
  async confirmPlan(input: {
    createBranch: boolean;
    branchName?: string;
  }): Promise<{
    ok: boolean;
    state?: SessionState;
    branch?: string | null;
    error?: { code: "VALIDATION_ERROR"; userMessage: string; technicalDetail: string };
  }> {
    if (isBusy(this.state.status)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Wait for the current turn to finish before starting build.",
          technicalDetail: `status=${this.state.status}`,
        },
      };
    }

    let createdBranch: string | null = null;
    if (input.createBranch) {
      const normalized = normalizeFeatBranchName(input.branchName ?? "");
      if (!normalized) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Enter a valid feat/kebab-case branch name.",
            technicalDetail: "empty or invalid branch",
          },
        };
      }
      const root = this.state.workspace?.resolvedRootPath;
      if (!root) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Open a workspace before creating a branch.",
            technicalDetail: "no workspace",
          },
        };
      }
      const git = new GitService(root);
      const info = await git.branchInfo();
      if (!info.isRepo) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Workspace is not a git repository.",
            technicalDetail: root,
          },
        };
      }
      if (await git.branchNameTaken(normalized)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: `Branch "${normalized}" already exists. Choose another name.`,
            technicalDetail: "branch collision",
          },
        };
      }
      try {
        await git.createAndCheckoutBranch(normalized);
        createdBranch = normalized;
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Could not create the branch.",
            technicalDetail:
              error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    const started = applyStartBuilding(this.state);
    if (started.error) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: started.error,
          technicalDetail: started.error,
        },
      };
    }

    const notice = {
      id: randomUUID(),
      role: "assistant" as const,
      content: createdBranch
        ? `Plan confirmed. Switched to **Build** on \`${createdBranch}\`.`
        : "Plan confirmed. Switched to **Build** (current branch).",
      createdAt: new Date().toISOString(),
    };

    this.state = {
      ...started.state,
      turns: [...started.state.turns, notice],
      status: "idle",
      error: null,
    };
    this.persist();
    this.push(true);

    // Start Build used to leave the session idle until the user typed again —
    // kick off execution immediately (fire-and-forget; do not block confirmPlan).
    void this.sendMessage(
      [
        "Build mode is active. Begin executing the plan now.",
        "Start with the first incomplete checklist item(s) using tools.",
        "For short setup commands (e.g. npm init -y), use run_command immediately.",
        "Do not wait for another instruction before taking the first action.",
      ].join(" "),
    );

    return { ok: true, state: this.state, branch: createdBranch };
  }

  openWorkspace(rootPath: string): WorkspaceRef {
    if (isBusy(this.state.status)) {
      this.cancel();
    }
    // Persist the current chat under its existing workspace — do not retarget it.
    this.persist();
    this.clearTerminalWaiters("dispose");
    this.terminals.disposeAll();
    void this.engine.detachWorkspace();

    const resolved = realpathSync(rootPath);
    const recentMatch = this.listRecent().find((w) => {
      try {
        return realpathSync(w.rootPath) === resolved;
      } catch {
        return w.rootPath === rootPath || w.rootPath === resolved;
      }
    });
    const workspace: WorkspaceRef = {
      projectId: recentMatch?.projectId ?? randomUUID(),
      rootPath,
      resolvedRootPath: resolved,
      name: basename(resolved),
    };

    const sameWorkspace = this.storage
      .listConversations()
      .filter((c) => c.workspace?.resolvedRootPath === resolved)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const delivery =
      sameWorkspace.find((c) => (c.sessionKind ?? "delivery") !== "architecture") ??
      null;

    if (delivery) {
      const hydrated = this.hydrateFromRow(delivery);
      this.state = {
        ...hydrated.state,
        workspace,
        status: "idle",
        error: null,
        liveTerminals: [],
        pendingTerminalConfirm: null,
        pendingTerminalAsk: null,
      };
      this.createdAt = hydrated.createdAt;
    } else {
      const id = randomUUID();
      const now = new Date().toISOString();
      const notice = {
        id: randomUUID(),
        role: "assistant" as const,
        content: `Workspace opened: **${workspace.name}**\n\`${workspace.resolvedRootPath}\`\n\nYou can describe a goal in the composer. Mode is currently **plan**.`,
        createdAt: now,
      };
      this.state = {
        ...createEmptySessionState(id),
        workspace,
        mode: "plan",
        sessionKind: "delivery",
        turns: [notice],
        liveTerminals: [],
        pendingTerminalConfirm: null,
        pendingTerminalAsk: null,
      };
      this.createdAt = now;
    }

    this.recordRecent(workspace);
    this.persist();
    this.push(true);
    void this.engine.attachWorkspace(workspace.resolvedRootPath);
    return workspace;
  }

  listRecent(): RecentWorkspace[] {
    return (
      this.storage.getPreference<RecentWorkspace[]>("recentWorkspaces") ?? []
    );
  }

  private recordRecent(workspace: WorkspaceRef): void {
    const recent = this.listRecent().filter(
      (w) => w.rootPath !== workspace.rootPath,
    );
    recent.unshift({
      projectId: workspace.projectId,
      rootPath: workspace.rootPath,
      name: workspace.name,
      lastOpenedAt: new Date().toISOString(),
    });
    this.storage.setPreference("recentWorkspaces", recent.slice(0, 10));
  }

  cancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.clearTokenFlush();
    this.clearTerminalWaiters("cancel");
    this.pausedTurn = null;
    this.state = {
      ...this.state,
      status: "idle",
      error: "Interrupted by user.",
      partialAssistantText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
      pendingTerminalConfirm: null,
      pendingTerminalAsk: null,
    };
    this.persist();
    this.push();
  }

  async sendMessage(
    content: string,
    options?: { planAnswers?: PlanAnswerInput[] },
  ): Promise<void> {
    this.abort?.abort();
    this.abort = new AbortController();
    this.clearTokenFlush();
    this.pausedTurn = null;

    const withAnswers = options?.planAnswers?.length
      ? applyPlanAnswers(this.state, options.planAnswers)
      : this.state;

    const userTurn = {
      id: randomUUID(),
      role: "user" as const,
      content,
      createdAt: new Date().toISOString(),
    };

    this.state = {
      ...withAnswers,
      status: "thinking",
      error: null,
      partialAssistantText: null,
      activityLabel: "Thinking…",
      activeToolCallId: null,
      liveTools: [],
      turns: [...withAnswers.turns, userTurn],
    };
    this.persist();
    this.push();

    try {
      const provider = await this.createProvider();
      const root = this.state.workspace?.resolvedRootPath;
      const checkpointRoot = join(
        app.getPath("userData"),
        "checkpoints",
        this.state.workspace?.projectId ?? "none",
      );

      const result = await runAgentTurn(this.state, content, {
        provider,
        signal: this.abort.signal,
        onProgress: (event) => this.handleProgress(event),
        ...(root
          ? {
              toolCtx: {
                workspaceRoot: root,
                fs: new FilesystemService(root),
                git: new GitService(root),
                checkpoint: new CheckpointService(root, checkpointRoot),
                terminals: this.terminalHost,
                cbm: this.cbmHost,
                audit: (entry: {
                  toolName: string;
                  action: string;
                  payload?: unknown;
                }) => {
                  this.storage.insertAudit({
                    id: randomUUID(),
                    projectId: this.state.workspace?.projectId ?? "global",
                    toolName: entry.toolName,
                    action: entry.action,
                    payload: entry.payload,
                    createdAt: new Date().toISOString(),
                  });
                },
              },
            }
          : {}),
      });

      this.clearTokenFlush();
      if (result.pause) {
        this.pausedTurn = result.pause;
      } else {
        this.pausedTurn = null;
      }
      this.state = {
        ...result.state,
        sequence: Math.max(this.state.sequence, result.state.sequence),
        liveTools: [],
        partialAssistantText: null,
        activityLabel:
          result.state.status === "awaiting_approval"
            ? result.state.activityLabel
            : null,
      };
      this.persist();
      this.push();
    } catch (error) {
      this.clearTokenFlush();
      this.pausedTurn = null;
      this.state = {
        ...this.state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        partialAssistantText: null,
        activityLabel: null,
        activeToolCallId: null,
        liveTools: [],
      };
      this.persist();
      this.push();
    }
  }

  private async createProvider() {
    const cfg =
      this.storage.getPreference<ProviderConfig>("providerConfig") ?? null;
    const apiKey = this.credentials
      ? await this.credentials.get(CREDENTIAL_SERVICE, "default")
      : null;

    if (cfg?.baseUrl) {
      return new OpenAiCompatibleProvider({
        baseUrl: cfg.baseUrl,
        apiKey: apiKey ?? "",
        defaultModel: cfg.defaultModel || "gpt-4o-mini",
      });
    }

    return new MockProvider({
      name: "local-mock",
      models: [{ id: "mock-model" }],
      steps: [
        {
          type: "content",
          text: "I am running in mock mode. Configure a provider in onboarding for live models.",
        },
      ],
    });
  }

  async approve(approvalId: string, grantCategory: boolean): Promise<void> {
    const pending = this.state.pendingApprovals.find((a) => a.id === approvalId);
    if (!pending) return;
    const grants = [...this.state.approvalGrants];
    if (grantCategory) {
      const name = pending.toolCall.name;
      const category =
        name === "git_commit"
          ? "git_commit"
          : name === "write_file"
            ? "env_write"
            : "command";
      grants.push({
        id: randomUUID(),
        category,
        grantedAt: new Date().toISOString(),
      });
    }

    const pause =
      this.pausedTurn && this.pausedTurn.approvalId === approvalId
        ? this.pausedTurn
        : null;
    this.pausedTurn = null;

    this.state = {
      ...this.state,
      pendingApprovals: this.state.pendingApprovals.filter((a) => a.id !== approvalId),
      approvalGrants: grants,
      status: pause ? "tool" : "idle",
      activityLabel: pause ? "Running approved tool…" : null,
    };
    this.persist();
    this.push();

    if (!pause) return;

    this.abort?.abort();
    this.abort = new AbortController();
    try {
      const provider = await this.createProvider();
      const root = this.state.workspace?.resolvedRootPath;
      const checkpointRoot = join(
        app.getPath("userData"),
        "checkpoints",
        this.state.workspace?.projectId ?? "none",
      );
      const result = await resumeAgentTurn(this.state, pause, {
        provider,
        signal: this.abort.signal,
        onProgress: (event) => this.handleProgress(event),
        approvedCallId: pending.toolCall.id,
        ...(root
          ? {
              toolCtx: {
                workspaceRoot: root,
                fs: new FilesystemService(root),
                git: new GitService(root),
                checkpoint: new CheckpointService(root, checkpointRoot),
                terminals: this.terminalHost,
                cbm: this.cbmHost,
                audit: (entry: {
                  toolName: string;
                  action: string;
                  payload?: unknown;
                }) => {
                  this.storage.insertAudit({
                    id: randomUUID(),
                    projectId: this.state.workspace?.projectId ?? "global",
                    toolName: entry.toolName,
                    action: entry.action,
                    payload: entry.payload,
                    createdAt: new Date().toISOString(),
                  });
                },
              },
            }
          : {}),
      });

      this.clearTokenFlush();
      if (result.pause) {
        this.pausedTurn = result.pause;
      } else {
        this.pausedTurn = null;
      }
      this.state = {
        ...result.state,
        sequence: Math.max(this.state.sequence, result.state.sequence),
        liveTools: [],
        partialAssistantText: null,
        activityLabel:
          result.state.status === "awaiting_approval"
            ? result.state.activityLabel
            : null,
      };
      this.persist();
      this.push();
    } catch (error) {
      this.clearTokenFlush();
      this.pausedTurn = null;
      this.state = {
        ...this.state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        partialAssistantText: null,
        activityLabel: null,
        activeToolCallId: null,
        liveTools: [],
      };
      this.persist();
      this.push();
    }
  }

  reject(approvalId: string): void {
    if (this.pausedTurn?.approvalId === approvalId) {
      this.pausedTurn = null;
    }
    this.state = {
      ...this.state,
      pendingApprovals: this.state.pendingApprovals.filter((a) => a.id !== approvalId),
      status: "idle",
      activityLabel: null,
    };
    this.persist();
    this.push();
  }

  exportDiagnostics(): {
    exportedAt: string;
    session: SessionState;
    audit: unknown[];
    note: string;
  } {
    const projectId = this.state.workspace?.projectId ?? "global";
    const audit = this.storage.listAudit(projectId).map((row) => ({
      ...row,
      payloadJson: row.payloadJson.replace(
        /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
        "[REDACTED]",
      ),
    }));
    return {
      exportedAt: new Date().toISOString(),
      session: this.state,
      audit,
      note: "Secrets redacted. Share only with trusted support.",
    };
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    this.clearTerminalWaiters("dispose");
    this.terminals.disposeAll();
    await this.engine.detachWorkspace();
  }
}
