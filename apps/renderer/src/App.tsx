import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveProductPhase } from "@ai-ide/shared";
import { getBridge } from "./bridge";
import { useBridgeReady, useSessionState } from "./hooks/useSessionState";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { ConversationPane, VerifyPane, type VerifyTab } from "./components/Cockpit";
import { ComposerBar } from "./components/ComposerBar";
import { CommandPalette } from "./components/CommandPalette";
import {
  formatPlanAnswersMessage,
  PlanQaDialog,
  type PlanQaAnswer,
} from "./components/PlanQaDialog";
import { StartBuildDialog } from "./components/StartBuildDialog";

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
  const [verifyTab, setVerifyTab] = useState<VerifyTab>("plan");
  const [qaOpen, setQaOpen] = useState(false);
  const [qaFocusRequestId, setQaFocusRequestId] = useState(0);
  const [qaDismissedKey, setQaDismissedKey] = useState<string | null>(null);
  const [startBuildOpen, setStartBuildOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<{
    isRepo: boolean;
    localBranch: string | null;
    remoteBranch: string | null;
  } | null>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const lastAutoFocus = useRef<string | null>(null);

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

  useEffect(() => {
    setQaDismissedKey(null);
    setQaOpen(false);
    setStartBuildOpen(false);
  }, [activeSessionId]);

  const planReady = Boolean(state?.planReadyProposal);
  const openStartBuild = useCallback(() => {
    if (!state?.planReadyProposal) return;
    setStartBuildOpen(true);
  }, [state?.planReadyProposal]);

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
  }, []);

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
      ui?.onNewSession(() => void createSession()),
      ui?.onOpenProvider(openProviderSettings),
    ];

    return () => {
      for (const unsub of unsubs) unsub?.();
    };
  }, [qaOpen, openWorkspace, createSession, openProviderSettings]);

  async function submitPlanAnswers(answers: PlanQaAnswer[]) {
    const content = formatPlanAnswersMessage(openPlanQuestions, answers);
    await getBridge()?.session.sendMessage(content, { planAnswers: answers });
    setQaOpen(false);
    setQaDismissedKey(openQuestionKey);
  }

  // Auto-focus Plan while drafting; Diff when development starts.
  useEffect(() => {
    if (!state) return;
    const key = `${state.sessionId}:${state.mode}:${state.planStatus}`;
    if (lastAutoFocus.current === key) return;
    lastAutoFocus.current = key;
    if (state.mode === "plan" || state.planStatus === "drafting") {
      setVerifyTab("plan");
      return;
    }
    if (state.mode === "agent" || state.planStatus === "executing") {
      setVerifyTab((current) => (current === "plan" ? "diff" : current));
    }
  }, [state?.sessionId, state?.mode, state?.planStatus]);

  // Keep Plan tab in view when the plan structure changes during planning.
  useEffect(() => {
    if (!state) return;
    if (state.mode === "plan" || state.planStatus === "drafting") {
      setVerifyTab("plan");
    }
  }, [state?.planPhases, state?.mode, state?.planStatus]);

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

  return (
    <div
      className={`app-shell ${phase === "planning" ? "app-shell-planning" : "app-shell-building"}`}
    >
      <header className="chrome">
        <div className="topbar">
          <div className="topbar-left">
            <strong className="brand">AI-First IDE</strong>
            <span className="status-pill">{state?.status ?? "idle"}</span>
            {phase === "planning" ? (
              <span
                className="phase-banner phase-banner-planning"
                title="Phase for this chat — plan is being created"
              >
                Plan mode · this chat
              </span>
            ) : (
              <span
                className="phase-banner phase-banner-building"
                title="Phase for this chat — executing the agreed plan"
              >
                Build mode · this chat
              </span>
            )}
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={openProviderSettings}
              title={`Provider settings (${modShortcutHint("P")})`}
            >
              Provider
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm palette-trigger"
              onClick={() => setPaletteOpen(true)}
              title={`Command palette (${modShortcutHint("K")})`}
            >
              {modShortcutHint("K")}
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
              <div className="workspace-bar-name muted">Nessun workspace aperto</div>
              <div className="workspace-bar-path">
                Apri una cartella progetto per far operare l’agent nel perimetro corretto.
              </div>
            </div>
          )}
          <button
            type="button"
            className="btn workspace-bar-action"
            title={`Open or change workspace (${modShortcutHint("O")})`}
            onClick={() => void openWorkspace()}
          >
            {state?.workspace ? "Cambia…" : "Apri workspace"}{" "}
            <kbd>{modShortcutHint("O")}</kbd>
          </button>
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
                >
                  {gitStatus.remoteBranch ?? "not tracking"}
                </span>
              </span>
            </div>
          )}
        </div>

        <ComposerBar state={state} inputRef={composerRef} />
      </header>

      <main className="cockpit">
        <section className="pane">
          <ConversationPane
            state={state}
            sessions={sessions}
            activeSessionId={activeSessionId}
          />
        </section>
        <section className="pane">
          <VerifyPane
            state={state}
            activeTab={verifyTab}
            onTabChange={setVerifyTab}
            planning={phase === "planning"}
            onOpenQa={() => {
              setQaDismissedKey(null);
              setQaOpen(true);
            }}
            onConfirmPlan={openStartBuild}
          />
        </section>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        currentVerifyTab={verifyTab}
        planning={phase === "planning"}
        onOpenWorkspace={() => void openWorkspace()}
        onFocusComposer={() => {
          if (qaOpen) setQaFocusRequestId((n) => n + 1);
          else composerRef.current?.focus();
        }}
        onSetVerifyTab={setVerifyTab}
        onOpenProviderSettings={openProviderSettings}
      />

      <PlanQaDialog
        open={qaOpen && qaEligible && !providerOpen && !startBuildOpen}
        questions={openPlanQuestions}
        focusRequestId={qaFocusRequestId}
        onClose={() => {
          setQaOpen(false);
          setQaDismissedKey(openQuestionKey);
        }}
        onSubmit={submitPlanAnswers}
      />

      <StartBuildDialog
        open={startBuildOpen && planReady && !providerOpen}
        suggestedBranch={
          state?.planReadyProposal?.suggestedBranch ?? "feat/plan"
        }
        summary={state?.planReadyProposal?.summary}
        onClose={() => setStartBuildOpen(false)}
        onConfirmed={() => {
          setStartBuildOpen(false);
          void getBridge()?.workspace.gitStatus().then((info) => {
            if (info) setGitStatus(info);
          });
        }}
      />

      <OnboardingWizard
        open={providerOpen || !onboarded}
        onComplete={closeProviderDialog}
        onCancel={closeProviderDialog}
      />
    </div>
  );
}
