import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveProductPhase } from "@ai-ide/shared";
import { getBridge } from "./bridge";
import { useBridgeReady, useSessionState } from "./hooks/useSessionState";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ConversationPane, VerifyPane } from "./components/Cockpit";
import { ComposerBar } from "./components/ComposerBar";
import { CommandPalette } from "./components/CommandPalette";
import {
  formatPlanAnswersMessage,
  PlanQaDialog,
  type PlanQaAnswer,
} from "./components/PlanQaDialog";
import { StartBuildDialog } from "./components/StartBuildDialog";
import { CommitBuildDialog } from "./components/CommitBuildDialog";
import { NewProjectDialog } from "./components/NewProjectDialog";
import {
  ArchitecturePane,
  modShiftHint,
} from "./components/ArchitecturePane";
import { TerminalConfirmBar } from "./components/TerminalConfirmBar";
import { TerminalAskDialog } from "./components/TerminalAskDialog";
import { EngineBanner } from "./components/EngineBanner";

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
  const [startBuildOpen, setStartBuildOpen] = useState(false);
  const [commitBuildOpen, setCommitBuildOpen] = useState(false);
  const [commitBuildDismissedKey, setCommitBuildDismissedKey] = useState<
    string | null
  >(null);
  const [startBuildDismissedKey, setStartBuildDismissedKey] = useState<
    string | null
  >(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [architecturePaneOpen, setArchitecturePaneOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<{
    isRepo: boolean;
    localBranch: string | null;
    remoteBranch: string | null;
    hasRemote: boolean;
  } | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);

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
  useEffect(() => {
    setQaDismissedKey(null);
    setQaOpen(false);
    setStartBuildOpen(false);
    setStartBuildDismissedKey(null);
    setCommitBuildOpen(false);
    setCommitBuildDismissedKey(null);
  }, [activeSessionId]);

  const planReady = Boolean(state?.planReadyProposal);
  const planReadyKey = state?.planReadyProposal
    ? `${state.sessionId}:${state.planReadyProposal.suggestedBranch}:${state.planReadyProposal.summary ?? ""}`
    : null;
  const buildCommitOffer = state?.buildCommitOffer ?? null;
  const buildCommitKey = buildCommitOffer
    ? `${state?.sessionId}:${buildCommitOffer.offeredAt}`
    : null;
  const openStartBuild = useCallback(() => {
    if (!state?.planReadyProposal) return;
    setStartBuildOpen(true);
  }, [state?.planReadyProposal]);

  // Auto-open Start Build when the agent proposes plan ready (same pattern as Plan Q&A).
  useEffect(() => {
    if (!planning || !planReady || !planReadyKey) {
      if (!planReady) setStartBuildOpen(false);
      return;
    }
    if (startBuildDismissedKey === planReadyKey) return;
    if (qaOpen || providerOpen || newProjectOpen || commitBuildOpen) return;
    setStartBuildOpen(true);
  }, [
    planning,
    planReady,
    planReadyKey,
    startBuildDismissedKey,
    qaOpen,
    providerOpen,
    newProjectOpen,
    commitBuildOpen,
  ]);

  // Auto-open local commit dialog when build checklist is complete.
  useEffect(() => {
    if (!buildCommitOffer || !buildCommitKey) {
      setCommitBuildOpen(false);
      return;
    }
    if (commitBuildDismissedKey === buildCommitKey) return;
    if (providerOpen || newProjectOpen || startBuildOpen || qaOpen) return;
    setCommitBuildOpen(true);
  }, [
    buildCommitOffer,
    buildCommitKey,
    commitBuildDismissedKey,
    providerOpen,
    newProjectOpen,
    startBuildOpen,
    qaOpen,
  ]);

  useEffect(() => {
    if (!planning || !planReady || startBuildOpen || qaOpen || providerOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      openStartBuild();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    planning,
    planReady,
    startBuildOpen,
    qaOpen,
    providerOpen,
    openStartBuild,
  ]);

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

  const createSession = useCallback(async () => {
    await getBridge()?.session.create();
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, []);

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
      ui?.onNewSession(() => void createSession()),
      ui?.onOpenProvider(openProviderSettings),
      ui?.onToggleArchitecture(toggleArchitecturePane),
    ];

    return () => {
      for (const unsub of unsubs) unsub?.();
    };
  }, [
    qaOpen,
    openWorkspace,
    createSession,
    openProviderSettings,
    toggleArchitecturePane,
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
          setGitStatus({
            isRepo: false,
            localBranch: null,
            remoteBranch: null,
            hasRemote: false,
          });
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

  return (
    <div
      className={`app-shell ${
        phase === "planning" ? "app-shell-planning" : "app-shell-building"
      }`}
    >
      <header className="chrome">
        <div className="topbar">
          <div className="topbar-left">
            <strong className="brand">AI-First IDE</strong>
            <span className="status-pill">{state?.status ?? "idle"}</span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={openProviderSettings}
              title={`Provider settings (${modShortcutHint("P")})`}
            >
              Provider · {modShortcutHint("P")}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm palette-trigger"
              onClick={() => setPaletteOpen(true)}
              title={`Command palette (${modShortcutHint("K")})`}
            >
              Palette · {modShortcutHint("K")}
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
              className={`btn workspace-bar-action ${showArchitecturePane ? "workspace-bar-action-active" : ""}`}
              title={`Architecture settings (${modShiftHint("A")})`}
              aria-pressed={showArchitecturePane}
              onClick={toggleArchitecturePane}
            >
              Settings · {modShiftHint("A")}
            </button>
            <button
              type="button"
              className="btn workspace-bar-action"
              title={`New project (${modShiftHint("N")})`}
              onClick={() => setNewProjectOpen(true)}
            >
              New · {modShiftHint("N")}
            </button>
            <button
              type="button"
              className="btn workspace-bar-action"
              title={`Open or change workspace (${modShortcutHint("O")})`}
              onClick={() => void openWorkspace()}
            >
              {state?.workspace ? "Change" : "Open"} · {modShortcutHint("O")}
            </button>
          </div>
        </div>

        <div
          className="git-bar"
          role="status"
          aria-label="Git branch"
        >
          <div className="git-bar-label">Git</div>
          {!state?.workspace ? (
            <div className="git-bar-main muted">No workspace</div>
          ) : gitStatus == null ? (
            <div className="git-bar-main muted">Checking repository…</div>
          ) : !gitStatus.isRepo ? (
            <div className="git-bar-main muted">Not a git repository</div>
          ) : (
            <div className="git-bar-main">
              <span className="git-bar-item">
                <span className="git-bar-key">local</span>
                <span className="git-bar-value">
                  {gitStatus.localBranch ?? "—"}
                </span>
              </span>
              <span className="git-bar-sep" aria-hidden>
                →
              </span>
              <span className="git-bar-item">
                <span className="git-bar-key">remote</span>
                <span
                  className={`git-bar-value ${gitStatus.remoteBranch ? "" : "muted"}`}
                  title={
                    gitStatus.remoteBranch
                      ? undefined
                      : gitStatus.hasRemote
                        ? "origin is set; upstream tracking appears after the first push"
                        : "No git remote configured"
                  }
                >
                  {gitStatus.remoteBranch ??
                    (gitStatus.hasRemote
                      ? "push after first commit"
                      : "no remote")}
                </span>
              </span>
            </div>
          )}
        </div>

        <ComposerBar state={state} inputRef={composerRef} />
      </header>

      <EngineBanner hasWorkspace={Boolean(state?.workspace)} />

      <main className="cockpit">
        <section className="pane">
          <ConversationPane
            state={state}
            sessions={sessions}
            activeSessionId={activeSessionId}
          />
        </section>
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
              onConfirmPlan={openStartBuild}
              onOpenArchitecture={openArchitecturePane}
            />
          )}
        </section>
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
      />

      <PlanQaDialog
        open={
          qaOpen &&
          qaEligible &&
          !providerOpen &&
          !startBuildOpen &&
          !newProjectOpen
        }
        questions={openPlanQuestions}
        focusRequestId={qaFocusRequestId}
        onClose={() => {
          setQaOpen(false);
          setQaDismissedKey(openQuestionKey);
        }}
        onSubmit={submitPlanAnswers}
      />

      <StartBuildDialog
        open={startBuildOpen && planReady && !providerOpen && !newProjectOpen}
        suggestedBranch={
          state?.planReadyProposal?.suggestedBranch ?? "feat/plan"
        }
        summary={state?.planReadyProposal?.summary}
        onClose={() => {
          setStartBuildOpen(false);
          if (planReadyKey) setStartBuildDismissedKey(planReadyKey);
        }}
        onConfirmed={() => {
          setStartBuildOpen(false);
          void getBridge()?.workspace.gitStatus().then((info) => {
            if (info) setGitStatus(info);
          });
        }}
      />

      <CommitBuildDialog
        open={
          commitBuildOpen &&
          Boolean(buildCommitOffer) &&
          !providerOpen &&
          !newProjectOpen &&
          !startBuildOpen
        }
        offer={buildCommitOffer}
        onClose={() => {
          setCommitBuildOpen(false);
          if (buildCommitKey) setCommitBuildDismissedKey(buildCommitKey);
        }}
        onCommitted={() => {
          setCommitBuildOpen(false);
          if (buildCommitKey) setCommitBuildDismissedKey(buildCommitKey);
          void getBridge()?.workspace.gitStatus().then((info) => {
            if (info) setGitStatus(info);
          });
        }}
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

      <OnboardingWizard
        open={providerOpen || !onboarded}
        onComplete={closeProviderDialog}
        onCancel={closeProviderDialog}
      />
    </div>
  );
}
