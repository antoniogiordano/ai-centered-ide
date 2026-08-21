import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cacheHitPercent,
  deriveProductPhase,
  emptyWorkspaceGitStatus,
  formatTokenCount,
  formatUsd,
  type WorkspaceGitStatusResponse,
} from "@ai-ide/shared";
import { getBridge } from "./bridge";
import { useBridgeReady, useSessionState } from "./hooks/useSessionState";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ConversationPane, VerifyPane } from "./components/Cockpit";
import { SplitGroup } from "./components/SplitGroup";
import { ComposerBar } from "./components/ComposerBar";
import { SessionBar } from "./components/SessionBar";
import { GitBar, type GitConflictNotice } from "./components/GitBar";
import { GitBranchDialog } from "./components/GitBranchDialog";
import { GitConflictDialog } from "./components/GitConflictDialog";
import { CommandPalette } from "./components/CommandPalette";
import { conflictResolvePrompt } from "./lib/gitBranches";
import {
  formatPlanAnswersMessage,
  PlanQaDialog,
  type PlanQaAnswer,
} from "./components/PlanQaDialog";
import { NewProjectDialog } from "./components/NewProjectDialog";
import {
  ArchitecturePane,
  modShiftHint,
} from "./components/ArchitecturePane";
import { TerminalConfirmBar } from "./components/TerminalConfirmBar";
import { TerminalAskDialog } from "./components/TerminalAskDialog";
import { AgentAskDialog } from "./components/AgentAskDialog";
import { EngineBanner } from "./components/EngineBanner";
import { PreviewPane } from "./components/PreviewPane";
import { HeaderSelect } from "./components/HeaderSelect";
import { SessionStatsDialog } from "./components/SessionStatsDialog";
import { useNativeOverlay } from "./hooks/useNativeOverlay";
import {
  autoCockpitWeights,
  resetAllSplitLayouts,
} from "./hooks/useSplitLayout";

const ONBOARDING_KEY = "ai-ide-onboarding-complete";

function readOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "true";
  } catch {
    return false;
  }
}

function modShortcutHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

function isBusyStatus(status: string | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running"
  );
}

export function App() {
  const { state, sessions, activeSessionId } = useSessionState();
  const bridgeReady = useBridgeReady();
  const [onboarded, setOnboarded] = useState(readOnboardingComplete);
  const [providerOpen, setProviderOpen] = useState(() => !readOnboardingComplete());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [qaFocusRequestId, setQaFocusRequestId] = useState(0);
  const [qaDismissedKey, setQaDismissedKey] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [architecturePaneOpen, setArchitecturePaneOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  /** The plan stays up next to the preview; the human can fold it away. */
  const [planOpen, setPlanOpen] = useState(true);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatusResponse | null>(
    null,
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [conflictNotice, setConflictNotice] = useState<GitConflictNotice | null>(
    null,
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const openPlanQuestions = useMemo(
    () => (state?.planQuestions ?? []).filter((q) => q.status === "open"),
    [state?.planQuestions],
  );
  const openQuestionKey = openPlanQuestions.map((q) => q.id).join("|");
  const planning =
    state?.mode === "plan" || state?.planStatus === "drafting";
  const qaEligible =
    planning &&
    !isBusyStatus(state?.status) &&
    openPlanQuestions.length > 0;

  const closeProviderDialog = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch {
      /* ignore quota / private mode */
    }
    setOnboarded(true);
    setProviderOpen(false);
  }, []);

  const openProviderSettings = useCallback(() => {
    setProviderSelectOpen(false);
    setModelSelectOpen(false);
    setProviderOpen(true);
  }, []);

  const openArchitecturePane = useCallback(() => {
    setArchitecturePaneOpen(true);
  }, []);

  const closeArchitecturePane = useCallback(() => {
    setArchitecturePaneOpen(false);
  }, []);

  const toggleArchitecturePane = useCallback(() => {
    setArchitecturePaneOpen((open) => !open);
  }, []);

  const togglePreview = useCallback(() => {
    setPreviewOpen((open) => !open);
  }, []);

  const togglePlan = useCallback(() => {
    setPlanOpen((open) => !open);
  }, []);

  const [layoutWidth, setLayoutWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  const [modelSelectOpen, setModelSelectOpen] = useState(false);
  const [providerSelectOpen, setProviderSelectOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [providers, setProviders] = useState<
    Array<{ id: string; name: string; defaultModel: string }>
  >([]);
  const toggleModelSwitcher = useCallback(() => {
    setProviderSelectOpen(false);
    setModelSelectOpen((open) => !open);
  }, []);
  const toggleProviderSelect = useCallback(() => {
    setModelSelectOpen(false);
    setProviderSelectOpen((open) => !open);
  }, []);
  const refreshProviders = useCallback(() => {
    void getBridge()
      ?.provider.list()
      .then((res) => {
        setProviders(
          (res?.providers ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            defaultModel: p.defaultModel,
          })),
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    function onResize() {
      setLayoutWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        resetAllSplitLayouts();
        return;
      }
      if (e.key === "[" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        toggleProviderSelect();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean((e.target as HTMLElement | null)?.isContentEditable);
      if (
        !typing &&
        (e.key === "s" || e.key === "S") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !providerOpen &&
        !paletteOpen &&
        !statsOpen
      ) {
        e.preventDefault();
        setStatsOpen(true);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paletteOpen, providerOpen, statsOpen, toggleProviderSelect]);

  const pickModel = useCallback(async (model: string) => {
    setModelSelectOpen(false);
    await getBridge()?.provider.setModel?.(model);
    refreshProviders();
  }, [refreshProviders]);

  const pickProvider = useCallback(async (id: string) => {
    setProviderSelectOpen(false);
    await getBridge()?.provider.setActive?.(id);
    refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders, state?.providerHud?.id, state?.providerHud?.model]);

  useEffect(() => {
    setQaDismissedKey(null);
    setQaOpen(false);
  }, [activeSessionId]);

  const refreshGitStatus = useCallback(
    (status?: WorkspaceGitStatusResponse) => {
      if (status) {
        setGitStatus(status);
        return;
      }
      void getBridge()?.workspace.gitStatus().then((info) => {
        if (info) setGitStatus(info);
      });
    },
    [],
  );

  useEffect(() => {
    if (!qaEligible) {
      setQaOpen(false);
      return;
    }
    if (qaDismissedKey === openQuestionKey) return;
    setQaOpen(true);
  }, [qaEligible, openQuestionKey, qaDismissedKey]);

  const openWorkspace = useCallback(async () => {
    try {
      const result = await getBridge()?.workspace.open();
      if (
        result &&
        "canceled" in (result as object) &&
        (result as { canceled?: boolean }).canceled
      ) {
        return;
      }
    } catch (err) {
      console.error("Open workspace failed:", err);
      window.alert(
        err instanceof Error ? err.message : "Could not open workspace",
      );
    }
  }, []);

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, []);

  const createSession = useCallback(
    async (input?: { branch?: string; dirtyStrategy?: "stash" | "force" }) => {
      const res = await getBridge()?.session.create(input);
      if (res && res.ok === false) {
        throw new Error(
          res.error?.userMessage ?? "Could not create the session.",
        );
      }
      focusComposer();
    },
    [focusComposer],
  );

  const requestNewSession = useCallback(() => {
    if (state?.workspace) {
      setNewSessionOpen(true);
      return;
    }
    void createSession();
  }, [createSession, state?.workspace]);

  const startConflictSession = useCallback(
    async (notice: GitConflictNotice) => {
      await createSession();
      await getBridge()?.session.sendMessage(conflictResolvePrompt(notice));
      focusComposer();
    },
    [createSession, focusComposer],
  );

  // Focus composer whenever the active chat changes (new / switch).
  useEffect(() => {
    if (!activeSessionId) return;
    const t = window.setTimeout(() => {
      if (qaOpen) return;
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }, 0);
    return () => window.clearTimeout(t);
  }, [activeSessionId, qaOpen]);

  useEffect(() => {
    function focusComposer() {
      if (qaOpen) {
        setQaFocusRequestId((n) => n + 1);
        return;
      }
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }

    const ui = getBridge()?.ui;
    const unsubs = [
      ui?.onFocusComposer(focusComposer),
      ui?.onTogglePalette(() => setPaletteOpen((open) => !open)),
      ui?.onOpenWorkspace(() => void openWorkspace()),
      ui?.onNewProject(() => setNewProjectOpen(true)),
      ui?.onNewSession(() => requestNewSession()),
      ui?.onOpenProvider(openProviderSettings),
      ui?.onToggleArchitecture(toggleArchitecturePane),
      ui?.onTogglePreview?.(togglePreview),
      ui?.onTogglePlan?.(togglePlan),
      ui?.onToggleModel?.(toggleModelSwitcher),
    ];

    return () => {
      for (const unsub of unsubs) unsub?.();
    };
  }, [
    qaOpen,
    openWorkspace,
    createSession,
    requestNewSession,
    openProviderSettings,
    toggleArchitecturePane,
    togglePreview,
    togglePlan,
    toggleModelSwitcher,
  ]);

  async function submitPlanAnswers(answers: PlanQaAnswer[]) {
    const content = formatPlanAnswersMessage(openPlanQuestions, answers);
    await getBridge()?.session.sendMessage(content, { planAnswers: answers });
    setQaOpen(false);
    setQaDismissedKey(openQuestionKey);
  }

  const workspaceRoot = state?.workspace?.resolvedRootPath ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!workspaceRoot) {
      setGitStatus(null);
      return;
    }

    async function refreshGit() {
      const gitStatusFn = getBridge()?.workspace.gitStatus;
      if (!gitStatusFn) {
        // Preload not rebuilt / bridge outdated — don't claim "not a repo".
        return;
      }
      try {
        const status = await gitStatusFn();
        if (!cancelled && status) setGitStatus(status);
      } catch (err) {
        console.warn("workspace.gitStatus failed", err);
        if (!cancelled) {
          setGitStatus(emptyWorkspaceGitStatus());
        }
      }
    }

    void refreshGit();
    const timer = window.setInterval(() => void refreshGit(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) setPreviewOpen(false);
  }, [workspaceRoot]);

  const previewWasOpen = useRef(false);
  useEffect(() => {
    if (previewOpen) {
      previewWasOpen.current = true;
      return;
    }
    if (!previewWasOpen.current) return;
    void getBridge()?.preview?.stop();
  }, [previewOpen]);

  // Everything modal has to hide the native preview view, which is painted on
  // top of the renderer and would otherwise cover the dialog.
  useNativeOverlay(
    providerOpen ||
      !onboarded ||
      newProjectOpen ||
      paletteOpen ||
      (qaOpen && qaEligible) ||
      Boolean(state?.pendingTerminalConfirm) ||
      Boolean(state?.pendingTerminalAsk) ||
      Boolean(state?.pendingAgentAsk) ||
      statsOpen,
  );

  if (!bridgeReady) {
    return (
      <div className="empty-state" style={{ margin: 48 }}>
        Waiting for desktop bridge…
      </div>
    );
  }

  const phase = state
    ? deriveProductPhase(state)
    : ("planning" as const);
  const showArchitecturePane = architecturePaneOpen;
  /** Settings always win the side column; otherwise it holds the plan. */
  const sidePaneOpen = architecturePaneOpen || planOpen;
  const cacheHit = state?.providerHud
    ? cacheHitPercent(state.providerHud.session)
    : null;

  return (
    <div
      className={`app-shell ${
        phase === "planning"
          ? "app-shell-planning"
          : phase === "checking"
            ? "app-shell-checking"
            : phase === "testing"
              ? "app-shell-testing"
              : "app-shell-building"
      }`}
    >
      <header className="chrome">
        <div className="topbar">
          <div className="topbar-left">
            <strong className="brand">
              AICI
              <span className="brand-sub">AI-Centered IDE</span>
            </strong>
            <span className="status-pill">{state?.status ?? "idle"}</span>
          </div>
          <div className="topbar-right">
            <div
              className={`provider-hud ${
                state?.providerHud?.paid ? "provider-hud-paid" : ""
              } ${!state?.providerHud?.id ? "provider-hud-empty" : ""}`}
            >
              {state?.providerHud?.paid ? (
                <span className="provider-paid-sign" aria-label="Paid">
                  $
                </span>
              ) : null}
              <span className="provider-hud-usage">
                in{" "}
                {formatTokenCount(
                  state?.providerHud?.session.inputTokens ?? 0,
                )}{" "}
                · out{" "}
                {formatTokenCount(
                  state?.providerHud?.session.outputTokens ?? 0,
                )}
                {cacheHit !== null ? (
                  <span
                    className="provider-hud-cache"
                    title={`${formatTokenCount(
                      state?.providerHud?.session.cachedInputTokens ?? 0,
                    )} prompt tokens served from the provider cache this session`}
                  >
                    {" "}
                    · cache {cacheHit}%
                  </span>
                ) : null}
                {state?.providerHud?.paid
                  ? ` · ${formatUsd(state.providerHud.sessionCostUsd)}`
                  : ""}
              </span>
            </div>
            <HeaderSelect
              value={state?.providerHud?.name ?? "No provider"}
              hint={modShiftHint("[")}
              open={providerSelectOpen}
              disabled={providers.length === 0}
              title={`Switch provider (${modShiftHint("[")})`}
              empty="Add a provider in Providers · ⌘P"
              options={providers.map((p) => ({
                id: p.id,
                label: p.name,
                hint: p.defaultModel,
              }))}
              onToggle={toggleProviderSelect}
              onClose={() => setProviderSelectOpen(false)}
              onPick={(id) => void pickProvider(id)}
            />
            <HeaderSelect
              value={state?.providerHud?.model ?? "No model"}
              hint={modShiftHint("M")}
              open={modelSelectOpen}
              disabled={!state?.providerHud?.id}
              title={`Switch model on this provider (${modShiftHint("M")})`}
              empty="Open Providers · ⌘P and list the models"
              options={(state?.providerHud?.models ?? []).map((id) => ({
                id,
                label: id,
              }))}
              onToggle={toggleModelSwitcher}
              onClose={() => setModelSelectOpen(false)}
              onPick={(id) => void pickModel(id)}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={openProviderSettings}
              title={`Provider settings (${modShortcutHint("P")})`}
            >
              Providers · {modShortcutHint("P")}
            </button>
          </div>
        </div>

        <div
          className={`workspace-bar ${state?.workspace ? "workspace-bar-active" : "workspace-bar-empty"}`}
          role="status"
          aria-label="Active workspace"
        >
          <div className="workspace-bar-label">Workspace</div>
          {state?.workspace ? (
            <div className="workspace-bar-main">
              <div className="workspace-bar-name">{state.workspace.name}</div>
              <div className="workspace-bar-path" title={state.workspace.resolvedRootPath}>
                {state.workspace.resolvedRootPath}
              </div>
            </div>
          ) : (
            <div className="workspace-bar-main">
              <div className="workspace-bar-name muted">No workspace open</div>
              <div className="workspace-bar-path">
                Open a project folder so the agent stays inside the correct perimeter.
              </div>
            </div>
          )}
          <div className="workspace-bar-actions">
            <button
              type="button"
              className={`btn btn-secondary btn-sm workspace-bar-action ${
                statsOpen ? "workspace-bar-action-active" : ""
              }`}
              title="Session stats · S"
              onClick={() => setStatsOpen(true)}
            >
              Stats · S
            </button>
            <button
              type="button"
              className={`btn btn-secondary btn-sm workspace-bar-action ${showArchitecturePane ? "workspace-bar-action-active" : ""}`}
              title={`Architecture settings (${modShiftHint("A")})`}
              aria-pressed={showArchitecturePane}
              onClick={toggleArchitecturePane}
            >
              Settings · {modShiftHint("A")}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm workspace-bar-action"
              title={`Reset column layout (${modShortcutHint("\\")})`}
              onClick={() => resetAllSplitLayouts()}
            >
              Layout · {modShortcutHint("\\")}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm workspace-bar-action"
              title={`New project (${modShiftHint("N")})`}
              onClick={() => setNewProjectOpen(true)}
            >
              New · {modShiftHint("N")}
            </button>
            <button
              type="button"
              className="btn btn-sm workspace-bar-action"
              title={`Open or change workspace (${modShortcutHint("O")})`}
              onClick={() => void openWorkspace()}
            >
              {state?.workspace ? "Change" : "Open"} · {modShortcutHint("O")}
            </button>
          </div>
        </div>

        <SessionBar
          state={state}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onAddSession={requestNewSession}
          workspaceReady={Boolean(state?.workspace)}
          previewOpen={previewOpen}
          planOpen={planOpen}
          onTogglePreview={togglePreview}
          onTogglePlan={togglePlan}
          onOpenStats={() => setStatsOpen(true)}
        />

        <GitBar
          workspaceReady={Boolean(state?.workspace)}
          status={gitStatus}
          onRefresh={refreshGitStatus}
          onConflict={setConflictNotice}
        />

        <ComposerBar state={state} inputRef={composerRef} />
      </header>

      <EngineBanner hasWorkspace={Boolean(state?.workspace)} />

      <main
        className={`cockpit ${previewOpen ? "cockpit-preview" : ""} ${
          sidePaneOpen ? "" : "cockpit-no-side"
        }`}
      >
        <SplitGroup
          storageKey={`cockpit:${sidePaneOpen ? "side" : "noside"}:${
            previewOpen ? "preview" : "nopreview"
          }`}
          autoWeights={autoCockpitWeights({
            width: layoutWidth,
            side: sidePaneOpen,
            preview: previewOpen,
          })}
          mins={
            sidePaneOpen && previewOpen
              ? [260, 220, 320]
              : previewOpen
                ? [280, 360]
                : sidePaneOpen
                  ? [280, 240]
                  : [320]
          }
        >
          <section className="pane">
            <ConversationPane
              state={state}
              sessions={sessions}
              activeSessionId={activeSessionId}
              onBuildStarted={refreshGitStatus}
              onBuildCommitted={refreshGitStatus}
              gitConflict={
                gitStatus?.conflicted?.length
                  ? {
                      files: gitStatus.conflicted,
                      branch: gitStatus.localBranch,
                      remote: gitStatus.compareRemote,
                      operation: "merge",
                    }
                  : null
              }
              gitConflictDialogOpen={Boolean(conflictNotice)}
              onOpenGitConflict={setConflictNotice}
              onToggleModel={toggleModelSwitcher}
            />
          </section>
          {sidePaneOpen ? (
            <section className="pane">
              {showArchitecturePane ? (
                <ArchitecturePane
                  workspaceRoot={state?.workspace?.resolvedRootPath}
                  onClose={closeArchitecturePane}
                />
              ) : (
                <VerifyPane
                  state={state}
                  planning={phase === "planning"}
                  onOpenQa={() => {
                    setQaDismissedKey(null);
                    setQaOpen(true);
                  }}
                  onOpenArchitecture={openArchitecturePane}
                  onHide={togglePlan}
                />
              )}
            </section>
          ) : null}
          {previewOpen ? (
            <PreviewPane
              onClose={() => setPreviewOpen(false)}
              onFocusComposer={() => composerRef.current?.focus()}
              busy={isBusyStatus(state?.status)}
            />
          ) : null}
        </SplitGroup>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenWorkspace={() => void openWorkspace()}
        onNewProject={() => setNewProjectOpen(true)}
        onFocusComposer={() => {
          if (qaOpen) setQaFocusRequestId((n) => n + 1);
          else composerRef.current?.focus();
        }}
        onOpenProviderSettings={openProviderSettings}
        onOpenArchitecture={openArchitecturePane}
        {...(state?.workspace
          ? { onTogglePreview: togglePreview, onTogglePlan: togglePlan }
          : {})}
        onToggleModel={toggleModelSwitcher}
        onResetLayout={() => resetAllSplitLayouts()}
        onNewSession={requestNewSession}
      />

      <GitBranchDialog
        open={newSessionOpen}
        mode="new-session"
        onClose={() => setNewSessionOpen(false)}
        onPicked={async ({ branch, dirtyStrategy }) => {
          await createSession({
            branch,
            ...(dirtyStrategy ? { dirtyStrategy } : {}),
          });
          refreshGitStatus();
        }}
      />

      <GitConflictDialog
        notice={conflictNotice}
        onClose={() => setConflictNotice(null)}
        onResolve={startConflictSession}
      />

      <SessionStatsDialog
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
      />

      <PlanQaDialog
        open={qaOpen && qaEligible && !providerOpen && !newProjectOpen}
        questions={openPlanQuestions}
        focusRequestId={qaFocusRequestId}
        onClose={() => {
          setQaOpen(false);
          setQaDismissedKey(openQuestionKey);
        }}
        onSubmit={submitPlanAnswers}
      />

      <NewProjectDialog
        open={newProjectOpen && !providerOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          setNewProjectOpen(false);
          setArchitecturePaneOpen(true);
        }}
      />

      {state?.pendingTerminalConfirm ? (
        <TerminalConfirmBar pending={state.pendingTerminalConfirm} />
      ) : null}

      {state?.pendingTerminalAsk &&
      !state.pendingTerminalConfirm &&
      !providerOpen &&
      !newProjectOpen ? (
        <TerminalAskDialog pending={state.pendingTerminalAsk} />
      ) : null}

      {state?.pendingAgentAsk &&
      !state.pendingTerminalAsk &&
      !state.pendingTerminalConfirm &&
      !providerOpen &&
      !newProjectOpen ? (
        <AgentAskDialog pending={state.pendingAgentAsk} />
      ) : null}

      <OnboardingWizard
        open={providerOpen || !onboarded}
        onComplete={closeProviderDialog}
        onCancel={closeProviderDialog}
      />
    </div>
  );
}
