import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  AgentMode,
  AttachmentMeta,
  AttachmentPayload,
  SessionState,
  SessionSummary,
  WorkspaceRef,
} from "@ai-ide/shared";
import {
  accumulateSessionModelUsage,
  createEmptySessionState,
  deriveProductPhase,
  planHasOpenWork,
  planBuildComplete,
  awaitsTestingConfirm,
  canStartCheckGate,
  canStartTestGate,
  CHECKLIST_CONTINUE_USER_MESSAGE,
  PLAN_CONTINUE_USER_MESSAGE,
  TESTING_READY_CONTINUE_USER_MESSAGE,
  discoverTestRunSpecs,
  buildTestFailureDigest,
  decideTestGateAutoContinue,
  decideTestGateEscalation,
  fingerprintTestFailure,
  failedSuiteIds,
  TEST_FAILURE_CONTINUE_USER_MESSAGE,
  type ProviderUsage,
  type SessionModelUsage,
} from "@ai-ide/shared";
import type { ProjectStorage } from "@ai-ide/storage";
import { MockProvider, OpenAiCompatibleProvider } from "@ai-ide/provider";
import {
  applyPlanAnswers,
  applyRejectPlanReady,
  applyStartBuilding,
  isSyntheticUserPrompt,
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
  ArchitectureStore,
  CheckpointService,
  FilesystemService,
  GitService,
  GhCli,
} from "@ai-ide/workspace";
import type { TerminalHost } from "@ai-ide/tools";
import { runTestSuites } from "@ai-ide/tools";
import { app, shell } from "electron";
import type { CredentialStore } from "@ai-ide/storage";
import { getAppCredential } from "@ai-ide/storage";
import { TerminalManager } from "./terminals.js";
import { CbmEngine } from "./engine/cbm-engine.js";
import type { CbmHost } from "@ai-ide/tools";
import { ProviderRegistryStore } from "./provider-registry.js";

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

type SessionListener = (event: {
  state: SessionState;
  fullSync: boolean;
  sessions: SessionSummary[];
  activeSessionId: string;
}) => void;

const ACTIVE_SESSION_KEY = "activeSessionId";

type StoredAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  path?: string;
  mime?: string;
  bytes: Buffer;
};

function resolveAttachmentBytes(att: AttachmentPayload): Buffer | null {
  if (att.dataBase64) {
    try {
      return Buffer.from(att.dataBase64, "base64");
    } catch {
      return null;
    }
  }
  if (att.path && existsSync(att.path)) {
    try {
      return readFileSync(att.path);
    } catch {
      return null;
    }
  }
  return null;
}

function enrichMessageWithAttachments(
  content: string,
  attachments: AttachmentPayload[],
): string {
  const parts: string[] = [];
  const trimmed = content.trim();
  if (trimmed) parts.push(trimmed);

  const files = attachments.filter((a) => a.kind === "file");
  const images = attachments.filter((a) => a.kind === "image");

  if (files.length || images.length) {
    const lines = ["[Attachments]"];
    for (const f of files) {
      const loc = f.path ? f.path : f.name;
      lines.push(`- file id=${f.id} name=${f.name} path=${loc}`);
      if (f.textPreview?.trim()) {
        lines.push("```");
        lines.push(f.textPreview.trim());
        lines.push("```");
      } else {
        lines.push(
          "  (large or binary — use import_attachment then read_file to page)",
        );
      }
    }
    for (const img of images) {
      lines.push(
        `- image id=${img.id} name=${img.name}${img.path ? ` path=${img.path}` : ""} (vision when supported; use import_attachment to copy into the workspace)`,
      );
    }
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n") || "(attachments only)";
}

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
  if (typeof args.path === "string" && args.path.trim()) {
    return args.path.trim();
  }
  if (typeof args.command === "string" && args.command.trim()) {
    const cmd = args.command.trim().replace(/\s+/g, " ");
    return cmd.length > 120 ? `${cmd.slice(0, 117)}…` : cmd;
  }
  if (typeof args.query === "string" && args.query.trim()) {
    const q = args.query.trim();
    return q.length > 80 ? `“${q.slice(0, 77)}…”` : `“${q}”`;
  }
  if (typeof args.text === "string" && args.text.trim()) {
    const t = args.text.trim().replace(/\s+/g, " ");
    return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "Streaming arguments…";
  return `args: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? "…" : ""}`;
}

function argsFromStreamingJson(
  argumentsJson: string,
): Record<string, unknown> | undefined {
  const parsed = tryParsePartialJson(argumentsJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
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
  /** After Cancel on Start Build — do not tank-continue until the user chats. */
  private planningPausedUntilUserMessage = false;
  private providerStore: ProviderRegistryStore | null = null;
  /** Full logs from the last IDE test-gate run (suiteId → text). */
  private testLogs = new Map<string, string>();
  /** After a failed gate, only re-run once the agent mutates the workspace. */
  private testDirtySinceLastRun = true;
  private testGateInFlight = false;
  private testAbort: AbortController | null = null;
  /** Session-scoped attachment blobs for vision + import_attachment. */
  private attachmentStore = new Map<string, StoredAttachment>();

  private static readonly TEST_MUTATING_TOOLS = new Set([
    "write_file",
    "replace_in_file",
    "import_attachment",
    "delete_file",
    "run_command",
    "git_commit",
    "terminal_write",
    "apply_patch",
    "upsert_architecture",
  ]);

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
    buildBaseBranch?: string | null;
    buildFlowCompletedAt?: string | null;
    sessionKind?: SessionState["sessionKind"];
    approvalGrants: SessionState["approvalGrants"];
    sessionModelUsage?: SessionModelUsage[];
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
      buildBaseBranch: row.buildBaseBranch ?? null,
      buildFlowCompletedAt: row.buildFlowCompletedAt ?? null,
      approvalGrants: row.approvalGrants,
      sessionModelUsage: row.sessionModelUsage ?? [],
      turns,
      status: "idle",
    };
    this.storage.setPreference(ACTIVE_SESSION_KEY, row.id);
    return { state, createdAt: row.createdAt };
  }

  setCredentials(store: CredentialStore): void {
    this.credentials = store;
    this.providerStore = new ProviderRegistryStore(this.storage, store);
    this.syncProviderHud(false);
  }

  getProviderStore(): ProviderRegistryStore | null {
    return this.providerStore;
  }

  syncProviderHud(push = true): void {
    if (!this.providerStore) return;
    this.state = {
      ...this.state,
      providerHud: this.providerStore.buildHud(),
    };
    if (push) this.push();
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
      // Live state for the active chat (offers/test gate are not persisted);
      // stored plan snapshot for the others so Testing shows as "T" too.
      phase:
        c.id === this.state.sessionId
          ? deriveProductPhase(this.state)
          : deriveProductPhase({
              mode: c.mode,
              planStatus: c.planStatus,
              sessionKind: c.sessionKind,
              planPhases: c.planPhases,
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
    // Keep the provider HUD attached on every push — agent turns / hydrate
    // otherwise drop it and the top bar flickers.
    if (this.providerStore) {
      this.state = {
        ...this.state,
        providerHud: this.providerStore.buildHud(),
      };
    }
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
      buildBaseBranch: this.state.buildBaseBranch,
      buildFlowCompletedAt: this.state.buildFlowCompletedAt,
      sessionKind: this.state.sessionKind,
      approvalGrants: this.state.approvalGrants,
      sessionModelUsage: this.state.sessionModelUsage,
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

  private applyProviderUsage(delta: ProviderUsage): void {
    if (!this.providerStore) return;
    if (delta.inputTokens <= 0 && delta.outputTokens <= 0) return;
    const hud = this.providerStore.recordUsage(delta);
    const active = this.providerStore.getActiveProvider();
    const sessionModelUsage = accumulateSessionModelUsage(
      this.state.sessionModelUsage ?? [],
      delta,
      {
        model: hud.model ?? active?.defaultModel ?? "unknown",
        providerId: hud.id,
        providerName: hud.name,
        paid: hud.paid,
        pricing: active?.pricing ?? null,
      },
    );
    this.state = { ...this.state, providerHud: hud, sessionModelUsage };
    this.persist();
    this.push();
  }

  private handleProgress(event: AgentProgressEvent): void {
    if (event.type === "usage") {
      this.applyProviderUsage({
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
      return;
    }

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
          arguments: event.call.arguments ?? {},
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
      const parsedArgs = argsFromStreamingJson(event.argumentsJson);
      const liveTools = this.state.liveTools.some((t) => t.id === event.callId)
        ? this.state.liveTools.map((t) =>
            t.id === event.callId
              ? {
                  ...t,
                  label: event.label,
                  status: "running" as const,
                  ...(summary ? { summary } : {}),
                  ...(parsedArgs ? { arguments: parsedArgs } : {}),
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
              ...(parsedArgs ? { arguments: parsedArgs } : {}),
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
              ...(event.result.output !== undefined
                ? { output: event.result.output }
                : {}),
              ...(event.result.error ? { error: event.result.error } : {}),
            }
          : t,
      );
      const ended = liveTools.find((t) => t.id === event.result.callId);
      if (
        event.result.success &&
        ended &&
        SessionManager.TEST_MUTATING_TOOLS.has(ended.name)
      ) {
        this.testDirtySinceLastRun = true;
        if (this.state.testGatePassedAt) {
          this.state = { ...this.state, testGatePassedAt: null };
        }
      }
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
    // New chat: refresh codebase graph so search_graph is not stuck on a stale/stub index.
    if (workspace?.resolvedRootPath) {
      void this.engine.ensureFreshIndex("chat");
    }
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
   * User cancelled Start Build — clear readiness and wait for chat revision.
   * Does not tank-continue until the next sendMessage.
   */
  rejectPlanReady(): { ok: boolean; state: SessionState } {
    this.planningPausedUntilUserMessage = true;
    this.state = applyRejectPlanReady(this.state);
    this.persist();
    this.push();
    return { ok: true, state: this.state };
  }

  /**
   * User confirmed the draft plan in the UI. Optionally create/checkout a feat/* branch,
   * then enter Check (pre-build test gate). Build starts automatically when Check passes.
   */
  async confirmPlan(input: {
    createBranch: boolean;
    branchName?: string;
    baseBranch?: string;
    dirtyStrategy?: "stash" | "commit_base";
    baseCommitMessage?: string;
  }): Promise<{
    ok: boolean;
    state?: SessionState;
    branch?: string | null;
    error?: { code: "VALIDATION_ERROR"; userMessage: string; technicalDetail: string };
  }> {
    this.planningPausedUntilUserMessage = false;
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

    if (this.state.planPhases.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Cannot start building with an empty plan.",
          technicalDetail: "empty plan",
        },
      };
    }
    const openQuestions = this.state.planQuestions.filter((q) => q.status === "open");
    if (openQuestions.length > 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: `Cannot start building: ${openQuestions.length} open question(s) remain.`,
          technicalDetail: "open questions",
        },
      };
    }
    if (!this.state.planReadyProposal) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Agent has not proposed plan readiness yet.",
          technicalDetail: "no planReadyProposal",
        },
      };
    }

    let createdBranch: string | null = null;
    let branchNote = "";
    let rememberedBase: string | null = null;
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
      const base = input.baseBranch?.trim() || info.localBranch;
      if (!base) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Select a base branch to start from.",
            technicalDetail: "missing base branch",
          },
        };
      }
      rememberedBase = base;
      if (!(await git.localBranchExists(base))) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: `Base branch "${base}" was not found locally.`,
            technicalDetail: "missing base branch",
          },
        };
      }
      const dirty = await git.isDirty();
      if (dirty && !input.dirtyStrategy) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage:
              "The working tree has uncommitted changes. Choose stash or commit on the base branch.",
            technicalDetail: "DIRTY_STRATEGY_REQUIRED",
          },
        };
      }
      if (
        dirty &&
        input.dirtyStrategy === "commit_base" &&
        !input.baseCommitMessage?.trim()
      ) {
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Enter a commit message for the base branch checkpoint.",
            technicalDetail: "missing base commit message",
          },
        };
      }
      try {
        const result = await git.createFeatBranchHandlingDirty({
          name: normalized,
          base,
          ...(input.dirtyStrategy
            ? { dirtyStrategy: input.dirtyStrategy }
            : {}),
          ...(input.baseCommitMessage
            ? { baseCommitMessage: input.baseCommitMessage }
            : {}),
        });
        createdBranch = normalized;
        if (result.stashed) {
          branchNote = ` Stashed uncommitted work; branched from last commit on \`${base}\`.`;
        } else if (result.committedOnBase) {
          branchNote = ` Committed checkpoint on \`${base}\`, then created \`${normalized}\`.`;
        } else if (base !== info.localBranch) {
          branchNote = ` From \`${base}\`.`;
        }
        branchNote += ` Remembered base \`${base}\` for merge/PR after tests.`;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage:
              detail === "DIRTY_STRATEGY_REQUIRED"
                ? "The working tree has uncommitted changes. Choose stash or commit on the base branch."
                : "Could not create the branch.",
            technicalDetail: detail,
          },
        };
      }
    } else {
      const root = this.state.workspace?.resolvedRootPath;
      if (root) {
        try {
          const info = await new GitService(root).branchInfo();
          rememberedBase = info.localBranch;
        } catch {
          rememberedBase = null;
        }
      }
    }

    const notice = {
      id: randomUUID(),
      role: "assistant" as const,
      content: createdBranch
        ? `Plan confirmed. Entering **Check** on \`${createdBranch}\` before Build.${branchNote}`
        : "Plan confirmed. Entering **Check** (current branch) before Build.",
      createdAt: new Date().toISOString(),
    };

    this.state = {
      ...this.state,
      mode: "agent",
      planStatus: "checking",
      turns: [...this.state.turns, notice],
      status: "idle",
      error: null,
      buildCommitOffer: null,
      buildIntegrateOffer: null,
      buildBaseBranch: rememberedBase,
      buildFlowCompletedAt: null,
      testRun: null,
      testingConfirmedAt: null,
      testGatePassedAt: null,
      testGateAutoFixAttempts: 0,
      testGateCircuitOpen: false,
      testGateFailureFingerprint: null,
      testGateSameFailureStreak: 0,
      testGateEscalationLevel: 0,
      testGateRecentSuiteKeys: [],
    };
    this.testLogs.clear();
    this.testDirtySinceLastRun = true;
    this.persist();
    this.push(true);

    // Pre-build Check gate — Build kicks off automatically when it passes.
    void this.maybeRunCheckGateThenBuild();

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
    this.testAbort?.abort();
    this.testAbort = null;
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
    options?: {
      planAnswers?: PlanAnswerInput[];
      attachments?: AttachmentPayload[];
    },
  ): Promise<void> {
    if (!isSyntheticUserPrompt(content)) {
      this.planningPausedUntilUserMessage = false;
    }
    if (content.trim() === TEST_FAILURE_CONTINUE_USER_MESSAGE) {
      this.testDirtySinceLastRun = true;
      // Manual Resume clears the paid-provider circuit and grants another batch.
      // Keep escalation fingerprint/streak so the next failure stays escalated.
      this.state = {
        ...this.state,
        testGateCircuitOpen: false,
        testGateAutoFixAttempts: 0,
      };
      const digest = this.state.testRun?.digest?.trim();
      if (digest && !content.includes("[IDE · TEST GATE]")) {
        content = `${digest}\n\n${TEST_FAILURE_CONTINUE_USER_MESSAGE}`;
      }
    }
    this.abort?.abort();
    this.abort = new AbortController();
    this.clearTokenFlush();
    this.pausedTurn = null;

    const withAnswers = options?.planAnswers?.length
      ? applyPlanAnswers(this.state, options.planAnswers)
      : this.state;

    const incoming = options?.attachments ?? [];
    const visionImages: Array<{ mime: string; dataBase64: string }> = [];
    const turnMeta: AttachmentMeta[] = [];

    for (const att of incoming) {
      const bytes = resolveAttachmentBytes(att);
      if (!bytes) continue;
      const stored: StoredAttachment = {
        id: att.id,
        kind: att.kind,
        name: att.name,
        bytes,
        ...(att.path ? { path: att.path } : {}),
        ...(att.mime ? { mime: att.mime } : {}),
      };
      this.attachmentStore.set(att.id, stored);
      const meta: AttachmentMeta = {
        id: att.id,
        kind: att.kind,
        name: att.name,
        ...(att.path ? { path: att.path } : {}),
        ...(att.mime ? { mime: att.mime } : {}),
        ...(att.previewDataUrl ? { previewDataUrl: att.previewDataUrl } : {}),
      };
      turnMeta.push(meta);
      if (att.kind === "image") {
        visionImages.push({
          mime: att.mime || "image/png",
          dataBase64: bytes.toString("base64"),
        });
      }
    }

    const enriched =
      incoming.length > 0
        ? enrichMessageWithAttachments(content, incoming)
        : content;

    const userTurn = {
      id: randomUUID(),
      role: "user" as const,
      content: enriched,
      createdAt: new Date().toISOString(),
      ...(turnMeta.length ? { attachments: turnMeta } : {}),
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

      const result = await runAgentTurn(this.state, enriched, {
        provider,
        signal: this.abort.signal,
        onProgress: (event) => this.handleProgress(event),
        ...(visionImages.length ? { visionImages } : {}),
        ...(root
          ? {
              toolCtx: {
                workspaceRoot: root,
                fs: new FilesystemService(root),
                git: new GitService(root),
                checkpoint: new CheckpointService(root, checkpointRoot),
                terminals: this.terminalHost,
                cbm: this.cbmHost,
                testLogs: {
                  get: (suiteId: string) => this.testLogs.get(suiteId),
                },
                testGate: this.testGateToolApi(),
                attachments: {
                  get: (id: string) => this.attachmentStore.get(id),
                  list: () =>
                    [...this.attachmentStore.values()].map((a) => ({
                      id: a.id,
                      kind: a.kind,
                      name: a.name,
                      ...(a.mime ? { mime: a.mime } : {}),
                      ...(a.path ? { path: a.path } : {}),
                    })),
                },
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
      // Never auto-rekick after errors / approvals — user must Resume.
      if (result.state.status === "idle" && !result.state.error) {
        if (!this.maybeTankContinueBuild()) {
          if (this.state.planStatus === "checking") {
            void this.maybeRunCheckGateThenBuild();
          } else if (!this.maybePromptTestingReady()) {
            void this.maybeRunTestGateThenCommit();
          }
        }
      }
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

  /**
   * Safety net: if a turn ends idle while tank work remains (and there is no
   * provider error / Stop), kick the agent again. Waits for the user when Plan
   * Q&A is open or Start Build is pending.
   * @returns true when a continue message was dispatched.
   */
  private maybeTankContinueBuild(): boolean {
    if (this.state.status !== "idle") return false;
    if (this.state.error) return false;
    if (this.state.pendingApprovals.length > 0) return false;
    const phase = deriveProductPhase(this.state);
    if (phase === "building") {
      if (!planHasOpenWork(this.state)) return false;
      // Avoid idle→banner flash: mark thinking before the continue kick.
      this.state = {
        ...this.state,
        status: "thinking",
        activityLabel: "Continuing build…",
        error: null,
      };
      this.push();
      void this.sendMessage(CHECKLIST_CONTINUE_USER_MESSAGE);
      return true;
    }
    if (phase === "planning") {
      if (this.state.mode !== "plan") return false;
      if (this.planningPausedUntilUserMessage) return false;
      if (this.state.planReadyProposal) return false;
      if (this.state.planQuestions.some((q) => q.status === "open")) return false;
      this.state = {
        ...this.state,
        status: "thinking",
        activityLabel: "Continuing planning…",
        error: null,
      };
      this.push();
      void this.sendMessage(PLAN_CONTINUE_USER_MESSAGE);
      return true;
    }
    return false;
  }

  /**
   * Checklist complete but agent has not called propose_testing_ready yet.
   * @returns true when a continue message was dispatched.
   */
  private maybePromptTestingReady(): boolean {
    if (this.state.status !== "idle") return false;
    if (this.state.error) return false;
    if (this.state.pendingApprovals.length > 0) return false;
    if (!awaitsTestingConfirm(this.state)) return false;
    this.state = {
      ...this.state,
      status: "thinking",
      activityLabel: "Confirming testing…",
      error: null,
    };
    this.push();
    void this.sendMessage(TESTING_READY_CONTINUE_USER_MESSAGE);
    return true;
  }

  /**
   * After Start Build confirm: run the pre-build Check gate (same suites as Test).
   * On green → applyStartBuilding and kick development. On fail → agent fix loop.
   */
  private async maybeRunCheckGateThenBuild(): Promise<void> {
    if (this.state.status !== "idle") return;
    if (this.state.error) return;
    if (this.state.planStatus !== "checking") return;
    if (!canStartCheckGate(this.state) && !this.state.testGatePassedAt) {
      return;
    }
    if (this.testGateInFlight) return;
    if (this.state.testGatePassedAt) {
      await this.finishCheckAndStartBuild();
      return;
    }

    const prior = this.state.testRun;
    if (prior?.status === "failed" && !this.testDirtySinceLastRun) {
      return;
    }
    if (prior?.status === "running") return;

    const root = this.state.workspace?.resolvedRootPath;
    if (!root) return;

    this.testGateInFlight = true;
    try {
      const profile = new ArchitectureStore(root).loadOrDetect().profile;
      const specs = discoverTestRunSpecs(profile, { includeE2e: true });
      if (specs.length === 0) {
        const skippedAt = new Date().toISOString();
        this.state = {
          ...this.state,
          testRun: {
            startedAt: skippedAt,
            finishedAt: skippedAt,
            status: "skipped",
            specs: [],
            suites: [],
            digest: "No lint/typecheck/unit/e2e commands in architecture profile.",
          },
          testGatePassedAt: skippedAt,
          testGateAutoFixAttempts: 0,
          testGateCircuitOpen: false,
          testGateFailureFingerprint: null,
          testGateSameFailureStreak: 0,
          testGateEscalationLevel: 0,
          testGateRecentSuiteKeys: [],
        };
        this.testLogs.clear();
        this.testDirtySinceLastRun = false;
        this.push();
        await this.finishCheckAndStartBuild();
        return;
      }

      const startedAt = new Date().toISOString();
      this.testLogs.clear();
      this.testDirtySinceLastRun = false;
      this.testAbort?.abort();
      this.testAbort = new AbortController();
      this.state = {
        ...this.state,
        status: "running",
        activityLabel: "Running check gate…",
        testRun: {
          startedAt,
          status: "running",
          specs,
          suites: [],
        },
        testGatePassedAt: null,
      };
      this.push();

      const outcome = await runTestSuites({
        workspaceRoot: root,
        specs,
        failFast: true,
        signal: this.testAbort.signal,
        onSuiteStart: (spec) => {
          this.state = {
            ...this.state,
            activityLabel: `Check gate · ${spec.id}…`,
          };
          this.push();
        },
        onSuiteEnd: (result) => {
          const prev = this.state.testRun;
          if (!prev || prev.status !== "running") return;
          const suites = [
            ...prev.suites.filter((s) => s.id !== result.id),
            result,
          ];
          this.state = {
            ...this.state,
            testRun: {
              ...prev,
              suites,
            },
          };
          this.push();
        },
      });

      for (const [id, log] of outcome.logs) {
        this.testLogs.set(id, log);
      }

      const finishedAt = new Date().toISOString();
      if (!outcome.failed) {
        this.state = {
          ...this.state,
          status: "idle",
          activityLabel: null,
          testRun: {
            startedAt,
            finishedAt,
            status: "passed",
            specs,
            suites: outcome.suites,
          },
          testGatePassedAt: finishedAt,
          testGateAutoFixAttempts: 0,
          testGateCircuitOpen: false,
          testGateFailureFingerprint: null,
          testGateSameFailureStreak: 0,
          testGateEscalationLevel: 0,
          testGateRecentSuiteKeys: [],
        };
        this.push();
        await this.finishCheckAndStartBuild();
        return;
      }

      const logsRecord = Object.fromEntries(this.testLogs.entries());
      const fingerprint = fingerprintTestFailure(
        { suites: outcome.suites },
        logsRecord,
      );
      const suiteKey = failedSuiteIds(outcome.suites).join("+") || "unknown";
      const escalation = decideTestGateEscalation({
        fingerprint,
        previousFingerprint: this.state.testGateFailureFingerprint,
        previousStreak: this.state.testGateSameFailureStreak,
        previousSuiteKeys: this.state.testGateRecentSuiteKeys,
        currentSuiteKey: suiteKey,
      });
      const digest = buildTestFailureDigest(
        {
          specs,
          suites: outcome.suites,
        },
        { logs: logsRecord, escalation },
      );
      const checkDigest = digest.replace(
        /\[IDE · TEST GATE\]/g,
        "[IDE · CHECK GATE]",
      );
      const decision = decideTestGateAutoContinue({
        paidProvider: this.isPaidActiveProvider(),
        previousAttempts: this.state.testGateAutoFixAttempts,
      });
      this.state = {
        ...this.state,
        status: "idle",
        activityLabel: null,
        testRun: {
          startedAt,
          finishedAt,
          status: "failed",
          specs,
          suites: outcome.suites,
          digest: checkDigest,
        },
        testGatePassedAt: null,
        testGateAutoFixAttempts: decision.attempts,
        testGateCircuitOpen: decision.circuitOpen,
        testGateFailureFingerprint: escalation.fingerprint,
        testGateSameFailureStreak: escalation.sameFailureStreak,
        testGateEscalationLevel: escalation.level,
        testGateRecentSuiteKeys: escalation.recentSuiteKeys,
      };
      this.push();
      if (decision.autoContinue) {
        void this.sendMessage(checkDigest);
      }
    } catch (error) {
      const decision = decideTestGateAutoContinue({
        paidProvider: this.isPaidActiveProvider(),
        previousAttempts: this.state.testGateAutoFixAttempts,
      });
      const errDigest = `Check gate error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      const fingerprint = fingerprintTestFailure(
        {
          suites: [
            {
              id: "gate",
              kind: "unit",
              command: "check-gate",
              status: "failed",
              exitCode: 1,
              durationMs: 0,
              summary: errDigest,
              logChars: 0,
              logChunkSize: 8000,
              logChunks: 0,
              failedTests: [],
            },
          ],
        },
      );
      const escalation = decideTestGateEscalation({
        fingerprint,
        previousFingerprint: this.state.testGateFailureFingerprint,
        previousStreak: this.state.testGateSameFailureStreak,
        previousSuiteKeys: this.state.testGateRecentSuiteKeys,
        currentSuiteKey: "gate",
      });
      this.state = {
        ...this.state,
        status: "idle",
        activityLabel: null,
        testRun: {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "failed",
          specs: this.state.testRun?.specs ?? [],
          suites: this.state.testRun?.suites ?? [],
          digest: errDigest,
        },
        testGatePassedAt: null,
        testGateAutoFixAttempts: decision.attempts,
        testGateCircuitOpen: decision.circuitOpen,
        testGateFailureFingerprint: escalation.fingerprint,
        testGateSameFailureStreak: escalation.sameFailureStreak,
        testGateEscalationLevel: escalation.level,
        testGateRecentSuiteKeys: escalation.recentSuiteKeys,
      };
      this.testDirtySinceLastRun = true;
      this.push();
      if (decision.autoContinue) {
        void this.sendMessage(
          this.state.testRun?.digest ?? TEST_FAILURE_CONTINUE_USER_MESSAGE,
        );
      }
    } finally {
      this.testGateInFlight = false;
    }
  }

  /** Check passed → switch to Build and kick the agent. */
  private async finishCheckAndStartBuild(): Promise<void> {
    if (this.state.planStatus !== "checking") return;
    if (this.state.status !== "idle") return;
    if (!this.state.testGatePassedAt) return;

    const rememberedBase = this.state.buildBaseBranch;
    const started = applyStartBuilding(this.state);
    if (started.error) {
      this.state = {
        ...this.state,
        status: "error",
        error: started.error,
      };
      this.persist();
      this.push();
      return;
    }

    const notice = {
      id: randomUUID(),
      role: "assistant" as const,
      content:
        "Check passed. Switched to **Build** — begin executing the plan.",
      createdAt: new Date().toISOString(),
    };

    this.state = {
      ...started.state,
      turns: [...started.state.turns, notice],
      status: "idle",
      error: null,
      buildBaseBranch: rememberedBase,
    };
    this.testLogs.clear();
    this.testDirtySinceLastRun = true;
    this.persist();
    this.push(true);

    void this.sendMessage(
      [
        "Build mode is active. Begin executing the plan now.",
        "Start with the first incomplete checklist item(s) using tools.",
        "For short setup commands (e.g. npm init -y), use run_command immediately.",
        "Do not wait for another instruction before taking the first action.",
      ].join(" "),
    );
  }

  /**
   * After build checklist completion + propose_testing_ready: discover + run
   * lint/typecheck/unit, then offer commit on green (or skip when no suites).
   * On failure, return to the agent with a digest + read_test_log.
   */
  private async maybeRunTestGateThenCommit(): Promise<void> {
    if (this.state.status !== "idle") return;
    if (this.state.error) return;
    if (this.state.buildCommitOffer) return;
    if (!planBuildComplete(this.state)) return;
    if (!canStartTestGate(this.state) && !this.state.testGatePassedAt) {
      // Missing testingConfirmedAt — maybePromptTestingReady handles the nudge.
      return;
    }
    if (this.testGateInFlight) return;
    if (this.state.testGatePassedAt) {
      await this.maybeOfferBuildCommit();
      return;
    }

    const prior = this.state.testRun;
    if (prior?.status === "failed" && !this.testDirtySinceLastRun) {
      return;
    }
    if (prior?.status === "running") return;

    const root = this.state.workspace?.resolvedRootPath;
    if (!root) return;

    this.testGateInFlight = true;
    try {
      const profile = new ArchitectureStore(root).loadOrDetect().profile;
      const specs = discoverTestRunSpecs(profile, { includeE2e: true });
      if (specs.length === 0) {
        const skippedAt = new Date().toISOString();
        this.state = {
          ...this.state,
          testRun: {
            startedAt: skippedAt,
            finishedAt: skippedAt,
            status: "skipped",
            specs: [],
            suites: [],
            digest: "No lint/typecheck/unit/e2e commands in architecture profile.",
          },
          testGatePassedAt: skippedAt,
          testGateAutoFixAttempts: 0,
          testGateCircuitOpen: false,
          testGateFailureFingerprint: null,
          testGateSameFailureStreak: 0,
          testGateEscalationLevel: 0,
          testGateRecentSuiteKeys: [],
        };
        this.testLogs.clear();
        this.testDirtySinceLastRun = false;
        this.push();
        await this.maybeOfferBuildCommit();
        return;
      }

      const startedAt = new Date().toISOString();
      this.testLogs.clear();
      this.testDirtySinceLastRun = false;
      this.testAbort?.abort();
      this.testAbort = new AbortController();
      this.state = {
        ...this.state,
        status: "running",
        activityLabel: "Running test gate…",
        testRun: {
          startedAt,
          status: "running",
          specs,
          suites: [],
        },
        testGatePassedAt: null,
      };
      this.push();

      const outcome = await runTestSuites({
        workspaceRoot: root,
        specs,
        failFast: true,
        signal: this.testAbort.signal,
        onSuiteStart: (spec) => {
          this.state = {
            ...this.state,
            activityLabel: `Test gate · ${spec.id}…`,
          };
          this.push();
        },
        onSuiteEnd: (result) => {
          const prev = this.state.testRun;
          if (!prev || prev.status !== "running") return;
          const suites = [
            ...prev.suites.filter((s) => s.id !== result.id),
            result,
          ];
          this.state = {
            ...this.state,
            testRun: {
              ...prev,
              suites,
            },
          };
          this.push();
        },
      });

      for (const [id, log] of outcome.logs) {
        this.testLogs.set(id, log);
      }

      const finishedAt = new Date().toISOString();
      if (!outcome.failed) {
        this.state = {
          ...this.state,
          status: "idle",
          activityLabel: null,
          testRun: {
            startedAt,
            finishedAt,
            status: "passed",
            specs,
            suites: outcome.suites,
          },
          testGatePassedAt: finishedAt,
          testGateAutoFixAttempts: 0,
          testGateCircuitOpen: false,
          testGateFailureFingerprint: null,
          testGateSameFailureStreak: 0,
          testGateEscalationLevel: 0,
          testGateRecentSuiteKeys: [],
        };
        this.push();
        await this.maybeOfferBuildCommit();
        return;
      }

      const logsRecord = Object.fromEntries(this.testLogs.entries());
      const fingerprint = fingerprintTestFailure(
        { suites: outcome.suites },
        logsRecord,
      );
      const suiteKey = failedSuiteIds(outcome.suites).join("+") || "unknown";
      const escalation = decideTestGateEscalation({
        fingerprint,
        previousFingerprint: this.state.testGateFailureFingerprint,
        previousStreak: this.state.testGateSameFailureStreak,
        previousSuiteKeys: this.state.testGateRecentSuiteKeys,
        currentSuiteKey: suiteKey,
      });
      const digest = buildTestFailureDigest(
        {
          specs,
          suites: outcome.suites,
        },
        { logs: logsRecord, escalation },
      );
      const decision = decideTestGateAutoContinue({
        paidProvider: this.isPaidActiveProvider(),
        previousAttempts: this.state.testGateAutoFixAttempts,
      });
      this.state = {
        ...this.state,
        status: "idle",
        activityLabel: null,
        testRun: {
          startedAt,
          finishedAt,
          status: "failed",
          specs,
          suites: outcome.suites,
          digest,
        },
        testGatePassedAt: null,
        testGateAutoFixAttempts: decision.attempts,
        testGateCircuitOpen: decision.circuitOpen,
        testGateFailureFingerprint: escalation.fingerprint,
        testGateSameFailureStreak: escalation.sameFailureStreak,
        testGateEscalationLevel: escalation.level,
        testGateRecentSuiteKeys: escalation.recentSuiteKeys,
      };
      this.push();
      if (decision.autoContinue) {
        void this.sendMessage(digest);
      }
    } catch (error) {
      const decision = decideTestGateAutoContinue({
        paidProvider: this.isPaidActiveProvider(),
        previousAttempts: this.state.testGateAutoFixAttempts,
      });
      const errDigest = `Test gate error: ${
        error instanceof Error ? error.message : String(error)
      }`;
      const fingerprint = fingerprintTestFailure(
        {
          suites: [
            {
              id: "gate",
              kind: "unit",
              command: "test-gate",
              status: "failed",
              exitCode: 1,
              durationMs: 0,
              summary: errDigest,
              logChars: 0,
              logChunkSize: 8000,
              logChunks: 0,
              failedTests: [],
            },
          ],
        },
      );
      const escalation = decideTestGateEscalation({
        fingerprint,
        previousFingerprint: this.state.testGateFailureFingerprint,
        previousStreak: this.state.testGateSameFailureStreak,
        previousSuiteKeys: this.state.testGateRecentSuiteKeys,
        currentSuiteKey: "gate",
      });
      this.state = {
        ...this.state,
        status: "idle",
        activityLabel: null,
        testRun: {
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "failed",
          specs: this.state.testRun?.specs ?? [],
          suites: this.state.testRun?.suites ?? [],
          digest: errDigest,
        },
        testGatePassedAt: null,
        testGateAutoFixAttempts: decision.attempts,
        testGateCircuitOpen: decision.circuitOpen,
        testGateFailureFingerprint: escalation.fingerprint,
        testGateSameFailureStreak: escalation.sameFailureStreak,
        testGateEscalationLevel: escalation.level,
        testGateRecentSuiteKeys: escalation.recentSuiteKeys,
      };
      this.testDirtySinceLastRun = true;
      this.push();
      if (decision.autoContinue) {
        void this.sendMessage(
          this.state.testRun?.digest ?? TEST_FAILURE_CONTINUE_USER_MESSAGE,
        );
      }
    } finally {
      this.testGateInFlight = false;
    }
  }

  private isPaidActiveProvider(): boolean {
    if (this.state.providerHud?.paid === true) return true;
    return this.providerStore?.getActive()?.paid === true;
  }

  private testGateToolApi() {
    return {
      getReport: () => this.state.testRun ?? null,
      getMeta: () => ({
        escalationLevel: this.state.testGateEscalationLevel ?? 0,
        circuitOpen: Boolean(this.state.testGateCircuitOpen),
        sameFailureStreak: this.state.testGateSameFailureStreak ?? 0,
      }),
    };
  }

  /** After a finished build + green test gate, offer a local commit when dirty. */
  private async maybeOfferBuildCommit(): Promise<void> {
    if (this.state.status !== "idle") return;
    if (this.state.error) return;
    if (this.state.buildCommitOffer) return;
    if (!planBuildComplete(this.state)) return;
    if (!this.state.testGatePassedAt) return;
    const root = this.state.workspace?.resolvedRootPath;
    if (!root) return;
    try {
      const git = new GitService(root);
      const status = await git.status();
      const files = [
        ...new Set([...status.modified, ...status.not_added]),
      ].filter(Boolean);
      if (files.length === 0) {
        await this.maybeOfferIntegrate();
        return;
      }
      this.state = {
        ...this.state,
        buildCommitOffer: {
          offeredAt: new Date().toISOString(),
          branch: status.current || null,
          baseBranch: this.state.buildBaseBranch,
          files,
        },
      };
      this.push();
    } catch {
      /* ignore git errors */
    }
  }

  /**
   * Commit/integrate flow settled with nothing pending: stamp completion so
   * the renderer can offer Archive chat. No-op while an offer is still open.
   */
  private markBuildFlowCompleteIfSettled(): void {
    if (this.state.buildCommitOffer || this.state.buildIntegrateOffer) return;
    if (this.state.buildFlowCompletedAt) return;
    this.state = {
      ...this.state,
      buildFlowCompletedAt: new Date().toISOString(),
    };
    this.persist();
    this.push();
  }

  /**
   * After tests (and after commit/skip when applicable): offer remote PR or
   * local merge into the Start Build base branch.
   */
  private async maybeOfferIntegrate(): Promise<void> {
    if (this.state.status !== "idle") return;
    if (this.state.error) return;
    if (this.state.buildCommitOffer) return;
    if (this.state.buildIntegrateOffer) return;
    if (!this.state.testGatePassedAt) return;
    const base = this.state.buildBaseBranch?.trim();
    if (!base) return;
    const root = this.state.workspace?.resolvedRootPath;
    if (!root) return;
    try {
      const git = new GitService(root);
      const info = await git.branchInfo();
      const head = info.localBranch;
      if (!head || head === base) return;
      this.state = {
        ...this.state,
        buildIntegrateOffer: {
          offeredAt: new Date().toISOString(),
          headBranch: head,
          baseBranch: base,
        },
      };
      this.push();
    } catch {
      /* ignore */
    }
  }

  async draftBuildCommitMessage(): Promise<{
    ok: boolean;
    message?: string;
    branch?: string | null;
    files?: string[];
    error?: { code: string; userMessage: string; technicalDetail: string };
  }> {
    const offer = this.state.buildCommitOffer;
    if (!offer) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "No completed build commit is pending.",
          technicalDetail: "missing buildCommitOffer",
        },
      };
    }
    const root = this.state.workspace?.resolvedRootPath;
    if (!root) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }

    const phases = this.state.planPhases
      .map(
        (p) =>
          `- ${p.title}: ${p.checklist.map((c) => c.text).join("; ")}`,
      )
      .join("\n");
    const fileList = offer.files.slice(0, 40).join("\n");
    const focusFiles = offer.files.slice(0, 25).join(", ");

    try {
      const provider = await this.createProvider();
      const messages = [
        {
          role: "system" as const,
          content: [
            "You write short git commit messages for a completed feature build.",
            "Reply with ONLY the commit message text — no quotes, no markdown fences, no preamble.",
            "Prefer conventional commits when it fits (feat:/fix:/chore:).",
            "Keep it to 1–2 sentences, under 120 characters for the subject when possible.",
          ].join("\n"),
        },
        {
          role: "user" as const,
          content: [
            `Branch: ${offer.branch ?? "unknown"}`,
            "Completed plan:",
            phases || "(no phases)",
            "",
            "Changed files:",
            fileList || "(none listed)",
            "",
            `Focus files: ${focusFiles}`,
          ].join("\n"),
        },
      ];
      let text = "";
      for await (const chunk of provider.chat(messages)) {
        if (chunk.type === "content") text += chunk.delta;
        if (
          chunk.type === "done" &&
          chunk.usage &&
          (chunk.usage.inputTokens > 0 || chunk.usage.outputTokens > 0)
        ) {
          this.applyProviderUsage(chunk.usage);
        }
        if (chunk.type === "error") {
          return {
            ok: false,
            error: {
              code: chunk.error.code,
              userMessage: chunk.error.userMessage,
              technicalDetail: chunk.error.technicalDetail,
            },
          };
        }
      }
      const message = text
        .trim()
        .replace(/^```[\s\S]*?\n/, "")
        .replace(/```$/, "")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (!message) {
        return {
          ok: false,
          error: {
            code: "PROVIDER_ERROR",
            userMessage: "The model returned an empty commit message.",
            technicalDetail: "empty draft",
          },
        };
      }
      return {
        ok: true,
        message: message.slice(0, 4000),
        branch: offer.branch,
        files: offer.files,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "PROVIDER_ERROR",
          userMessage: "Could not draft a commit message.",
          technicalDetail:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async commitBuild(message: string): Promise<{
    ok: boolean;
    commit?: string;
    state?: SessionState;
    error?: { code: string; userMessage: string; technicalDetail: string };
  }> {
    const trimmed = message.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Enter a commit message.",
          technicalDetail: "empty message",
        },
      };
    }
    if (!this.state.buildCommitOffer) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "No completed build commit is pending.",
          technicalDetail: "missing buildCommitOffer",
        },
      };
    }
    const root = this.state.workspace?.resolvedRootPath;
    if (!root) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }
    try {
      const git = new GitService(root);
      const staged = await git.stageAllChanges();
      if (staged.length === 0) {
        this.state = { ...this.state, buildCommitOffer: null };
        this.push();
        await this.maybeOfferIntegrate();
        this.markBuildFlowCompleteIfSettled();
        return {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            userMessage: "Nothing to commit — working tree is clean.",
            technicalDetail: "no staged files",
          },
        };
      }
      const commit = await git.commit(trimmed);
      const notice = {
        id: randomUUID(),
        role: "assistant" as const,
        content: `Committed on \`${this.state.buildCommitOffer.branch ?? "HEAD"}\`: ${trimmed}`,
        createdAt: new Date().toISOString(),
      };
      this.state = {
        ...this.state,
        buildCommitOffer: null,
        turns: [...this.state.turns, notice],
      };
      this.persist();
      this.push();
      await this.maybeOfferIntegrate();
      this.markBuildFlowCompleteIfSettled();
      return { ok: true, commit, state: this.state };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Git commit failed.",
          technicalDetail:
            error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async dismissBuildCommit(): Promise<{ ok: boolean; state: SessionState }> {
    this.state = { ...this.state, buildCommitOffer: null };
    this.push();
    await this.maybeOfferIntegrate();
    this.markBuildFlowCompleteIfSettled();
    return { ok: true, state: this.state };
  }

  dismissBuildIntegrate(): { ok: boolean; state: SessionState } {
    this.state = { ...this.state, buildIntegrateOffer: null };
    this.push();
    this.markBuildFlowCompleteIfSettled();
    return { ok: true, state: this.state };
  }

  async integrateBuild(action: "pr" | "merge"): Promise<{
    ok: boolean;
    url?: string;
    state?: SessionState;
    error?: { code: string; userMessage: string; technicalDetail: string };
  }> {
    const offer = this.state.buildIntegrateOffer;
    if (!offer) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "No integrate offer is pending.",
          technicalDetail: "missing buildIntegrateOffer",
        },
      };
    }
    const root = this.state.workspace?.resolvedRootPath;
    if (!root) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Open a workspace first.",
          technicalDetail: "no workspace",
        },
      };
    }

    try {
      const git = new GitService(root);
      if (action === "merge") {
        await git.mergeIntoBase({
          base: offer.baseBranch,
          head: offer.headBranch,
          message: `Merge branch '${offer.headBranch}' into ${offer.baseBranch}`,
        });
        const notice = {
          id: randomUUID(),
          role: "assistant" as const,
          content: `Merged \`${offer.headBranch}\` into \`${offer.baseBranch}\` locally.`,
          createdAt: new Date().toISOString(),
        };
        this.state = {
          ...this.state,
          buildIntegrateOffer: null,
          turns: [...this.state.turns, notice],
        };
        this.persist();
        this.push();
        this.markBuildFlowCompleteIfSettled();
        return { ok: true, state: this.state };
      }

      // Remote PR: push head, then gh pr create.
      const info = await git.branchInfo();
      if (info.localBranch !== offer.headBranch) {
        await git.checkoutExisting(offer.headBranch);
      }
      await git.pushCurrentUpstream("origin");
      const gh = new GhCli({ openUrl: (url) => shell.openExternal(url) });
      const pr = await gh.createPullRequest({
        cwd: root,
        base: offer.baseBranch,
        head: offer.headBranch,
        title: offer.headBranch.replace(/^feat\//, "").replace(/-/g, " "),
        body: `Opened after IDE Test gate on \`${offer.headBranch}\` (base \`${offer.baseBranch}\`).`,
      });
      void shell.openExternal(pr.url);
      const notice = {
        id: randomUUID(),
        role: "assistant" as const,
        content: `Opened pull request: ${pr.url} (\`${offer.headBranch}\` → \`${offer.baseBranch}\`).`,
        createdAt: new Date().toISOString(),
      };
      this.state = {
        ...this.state,
        buildIntegrateOffer: null,
        turns: [...this.state.turns, notice],
      };
      this.persist();
      this.push();
      this.markBuildFlowCompleteIfSettled();
      return { ok: true, url: pr.url, state: this.state };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const userMessage =
        detail === "DIRTY_WORKTREE"
          ? "Working tree is dirty — commit or stash before merging."
          : action === "pr"
            ? "Could not open a pull request (push + gh)."
            : "Local merge failed.";
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage,
          technicalDetail: detail,
        },
      };
    }
  }

  private async createProvider() {
    const store = this.providerStore;
    const active = store?.getActive() ?? null;
    if (active) {
      const apiKey = (await store!.getApiKey(active.id)) || "";
      return new OpenAiCompatibleProvider({
        baseUrl: active.baseUrl,
        apiKey,
        defaultModel: active.defaultModel || "gpt-4o-mini",
        thinking: active.thinking,
        reasoningEffort: active.reasoningEffort,
      });
    }

    // Legacy fallback while migrating.
    const cfg = this.storage.getPreference<{
      baseUrl?: string;
      defaultModel?: string;
    }>("providerConfig");
    const apiKey = this.credentials
      ? await getAppCredential(this.credentials, "default")
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
          : name === "write_file" || name === "replace_in_file"
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
                testLogs: {
                  get: (suiteId: string) => this.testLogs.get(suiteId),
                },
                testGate: this.testGateToolApi(),
                attachments: {
                  get: (id: string) => this.attachmentStore.get(id),
                  list: () =>
                    [...this.attachmentStore.values()].map((a) => ({
                      id: a.id,
                      kind: a.kind,
                      name: a.name,
                      ...(a.mime ? { mime: a.mime } : {}),
                      ...(a.path ? { path: a.path } : {}),
                    })),
                },
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
      // Never auto-rekick after errors / approvals — user must Resume.
      if (result.state.status === "idle" && !result.state.error) {
        if (!this.maybeTankContinueBuild()) {
          if (this.state.planStatus === "checking") {
            void this.maybeRunCheckGateThenBuild();
          } else if (!this.maybePromptTestingReady()) {
            void this.maybeRunTestGateThenCommit();
          }
        }
      }
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
