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
  tryParsePartialJson,
  type AgentProgressEvent,
  type PlanAnswerInput,
} from "@ai-ide/agent";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import { app } from "electron";
import type { CredentialStore } from "@ai-ide/storage";
import { CREDENTIAL_SERVICE } from "@ai-ide/storage";

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

  constructor(private readonly storage: ProjectStorage) {
    const boot = this.bootstrap();
    this.state = boot.state;
    this.createdAt = boot.createdAt;
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
    approvalGrants: SessionState["approvalGrants"];
    createdAt: string;
  }): { state: SessionState; createdAt: string } {
    const turns = this.storage.loadTurns(row.id);
    const mode = row.mode === "ask" ? "plan" : row.mode;
    const state: SessionState = {
      ...createEmptySessionState(row.id),
      mode,
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
    return this.storage.listConversations().map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      workspaceName: c.workspace?.name ?? null,
      phase: deriveProductPhase({ mode: c.mode, planStatus: c.planStatus }),
    }));
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
    this.storage.upsertConversation({
      id: this.state.sessionId,
      projectId: this.state.workspace?.projectId ?? "global",
      title: titleFromTurns(this.state.turns),
      mode: this.state.mode,
      workspace: this.state.workspace,
      planSteps: this.state.planSteps,
      planPhases: this.state.planPhases,
      planStatus: this.state.planStatus,
      planQuestions: this.state.planQuestions,
      planReadyProposal: this.state.planReadyProposal,
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
    const all = this.storage.listConversations();
    if (all.length <= 1 && all[0]?.id === sessionId) {
      // Always keep one session — reset it instead of deleting.
      if (sessionId === this.state.sessionId && isBusy(this.state.status)) {
        this.cancel();
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.storage.deleteConversation(sessionId);
      this.state = createEmptySessionState(id);
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

    // Closing active: pick another, then delete.
    this.persist();
    const remaining = all.filter((c) => c.id !== sessionId);
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
    return { ok: true, state: this.state, branch: createdBranch };
  }

  openWorkspace(rootPath: string): WorkspaceRef {
    const resolved = realpathSync(rootPath);
    const workspace: WorkspaceRef = {
      projectId: randomUUID(),
      rootPath,
      resolvedRootPath: resolved,
      name: basename(resolved),
    };
    const notice = {
      id: randomUUID(),
      role: "assistant" as const,
      content: `Workspace opened: **${workspace.name}**\n\`${workspace.resolvedRootPath}\`\n\nYou can describe a goal in the composer. Mode is currently **${this.state.mode}**.`,
      createdAt: new Date().toISOString(),
    };
    this.state = {
      ...this.state,
      workspace,
      status: "idle",
      error: null,
      turns: [...this.state.turns, notice],
    };
    this.recordRecent(workspace);
    this.persist();
    this.push(true);
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
    this.state = {
      ...this.state,
      status: "idle",
      error: "Interrupted by user.",
      partialAssistantText: null,
      activityLabel: null,
      activeToolCallId: null,
      liveTools: [],
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

  approve(approvalId: string, grantCategory: boolean): void {
    const pending = this.state.pendingApprovals.find((a) => a.id === approvalId);
    if (!pending) return;
    const grants = [...this.state.approvalGrants];
    if (grantCategory) {
      grants.push({
        id: randomUUID(),
        category: pending.toolCall.name,
        grantedAt: new Date().toISOString(),
      });
    }
    this.state = {
      ...this.state,
      pendingApprovals: this.state.pendingApprovals.filter((a) => a.id !== approvalId),
      approvalGrants: grants,
      status: "idle",
      activityLabel: null,
    };
    this.persist();
    this.push();
  }

  reject(approvalId: string): void {
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
}
