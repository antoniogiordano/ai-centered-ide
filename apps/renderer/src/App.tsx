import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const ONBOARDING_KEY = "ai-ide-onboarding-complete";

function readOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "true";
  } catch {
    return false;
  }
}

function phaseLabel(state: {
  mode?: string;
  planStatus?: string;
} | null): string {
  if (!state) return "idle";
  if (state.mode === "plan" || state.planStatus === "drafting") return "planning";
  if (state.planStatus === "executing") return "building";
  return state.mode ?? "idle";
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [verifyTab, setVerifyTab] = useState<VerifyTab>("plan");
  const [qaOpen, setQaOpen] = useState(false);
  const [qaFocusRequestId, setQaFocusRequestId] = useState(0);
  const [qaDismissedKey, setQaDismissedKey] = useState<string | null>(null);
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

  const completeOnboarding = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch {
      /* ignore quota / private mode */
    }
    setOnboarded(true);
  }, []);

  const openProviderSettings = useCallback(() => {
    try {
      localStorage.removeItem(ONBOARDING_KEY);
    } catch {
      /* ignore */
    }
    setOnboarded(false);
  }, []);

  useEffect(() => {
    if (!qaEligible) {
      setQaOpen(false);
      return;
    }
    if (qaDismissedKey === openQuestionKey) return;
    setQaOpen(true);
  }, [qaEligible, openQuestionKey, qaDismissedKey]);

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

    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;

      if (e.code === "KeyK" || e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.code === "KeyI" || e.key.toLowerCase() === "i") {
        e.preventDefault();
        e.stopPropagation();
        focusComposer();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    const unsubFocus = getBridge()?.ui?.onFocusComposer(focusComposer);
    const unsubPalette = getBridge()?.ui?.onTogglePalette(() => {
      setPaletteOpen((open) => !open);
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubFocus?.();
      unsubPalette?.();
    };
  }, [qaOpen]);

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

  async function openWorkspace() {
    try {
      const result = await getBridge()?.workspace.open();
      if (result && "canceled" in (result as object) && (result as { canceled?: boolean }).canceled) {
        return;
      }
    } catch (err) {
      console.error("Open workspace failed:", err);
      window.alert(
        err instanceof Error ? err.message : "Could not open workspace",
      );
    }
  }

  if (!bridgeReady) {
    return (
      <div className="empty-state" style={{ margin: 48 }}>
        Waiting for desktop bridge…
      </div>
    );
  }

  if (!onboarded) {
    return <OnboardingWizard onComplete={completeOnboarding} />;
  }

  const phase = phaseLabel(state);

  return (
    <div className="app-shell">
      <header className="chrome">
        <div className="topbar">
          <div className="topbar-left">
            <strong className="brand">AI-First IDE</strong>
            <span className="status-pill">{state?.status ?? "idle"}</span>
            <span
              className={`phase-pill phase-pill-${phase}`}
              title="Product flow for this chat"
            >
              {phase === "planning" ? "Planning" : phase === "building" ? "Building" : phase}
            </span>
          </div>
          <div className="topbar-right">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={openProviderSettings}
              title="Change Base URL, API key, and model"
            >
              Provider
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm palette-trigger"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K)"
            >
              ⌘K
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
            onClick={() => void openWorkspace()}
          >
            {state?.workspace ? "Cambia…" : "Apri workspace"}
          </button>
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
            onOpenQa={() => {
              setQaDismissedKey(null);
              setQaOpen(true);
            }}
          />
        </section>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        currentVerifyTab={verifyTab}
        onOpenWorkspace={() => void openWorkspace()}
        onFocusComposer={() => {
          if (qaOpen) setQaFocusRequestId((n) => n + 1);
          else composerRef.current?.focus();
        }}
        onSetVerifyTab={setVerifyTab}
        onOpenProviderSettings={openProviderSettings}
      />

      <PlanQaDialog
        open={qaOpen && qaEligible}
        questions={openPlanQuestions}
        focusRequestId={qaFocusRequestId}
        onClose={() => {
          setQaOpen(false);
          setQaDismissedKey(openQuestionKey);
        }}
        onSubmit={submitPlanAnswers}
      />
    </div>
  );
}
