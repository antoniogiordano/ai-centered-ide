import { useEffect } from "react";
import {
  awaitsTestingConfirm,
  noticesBlocking,
  planChecklistProgress,
  planHasOpenWork,
  planBuildComplete,
  CHECKLIST_CONTINUE_USER_MESSAGE,
  MAX_GATE_FIX_ROUNDS_WITHOUT_EDIT,
  TEST_FAILURE_CONTINUE_USER_MESSAGE,
  TEST_GATE_PAID_AUTO_FIX_LIMIT,
  TESTING_READY_CONTINUE_USER_MESSAGE,
  type SessionState,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";

function isBusy(status: SessionState["status"] | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running" ||
    status === "awaiting_approval"
  );
}

/**
 * Shown when Build stopped with an open checklist — after provider error,
 * Stop, or interrupt. Also when the post-build test gate failed.
 */
export function BuildContinueBanner(props: { state: SessionState | null }) {
  const state = props.state;
  const circuitOpen = Boolean(state?.testGateCircuitOpen);
  // Older sessions have no reason recorded; the paid limit was the only cause then.
  const circuitReason = state?.testGateCircuitReason ?? "paid_limit";
  const stalled = circuitOpen && circuitReason === "stalled";
  // HumanSetupBanner / SessionNoticeBanner own this pause until the human acts.
  const humanSetup = Boolean(state?.humanSetup);
  const blockingNotice = noticesBlocking(state?.notices);
  const escalationLevel = state?.testGateEscalationLevel ?? 0;
  const testFailed =
    Boolean(state) &&
    state?.testRun?.status === "failed" &&
    Boolean(
      state &&
        (planBuildComplete(state) || state.planStatus === "checking"),
    );
  const checklistOpen =
    Boolean(state) &&
    state?.mode !== "plan" &&
    state?.planStatus !== "drafting" &&
    state?.planStatus !== "checking" &&
    Boolean(state && planHasOpenWork(state));
  /**
   * A turn that died with the checklist complete and no test run yet (Testing
   * phase, gate not started) matched none of the conditions below, so the IDE
   * showed no way out: it stops auto-continuing on error by design, and the
   * error text sits further up the transcript.
   */
  const stopped =
    Boolean(state?.error?.trim()) &&
    state?.mode !== "plan" &&
    state?.planStatus !== "drafting";
  const show =
    Boolean(state) &&
    !isBusy(state?.status) &&
    !humanSetup &&
    !blockingNotice &&
    (checklistOpen || testFailed || circuitOpen || stopped);

  const { done, total } = state
    ? planChecklistProgress(state)
    : { done: 0, total: 0 };
  const open = total - done;
  const error = state?.error?.trim() || null;
  const isProviderError =
    Boolean(error) && error !== "Interrupted by user.";
  const attempts = state?.testGateAutoFixAttempts ?? 0;
  const streak = state?.testGateSameFailureStreak ?? 0;

  async function continueBuild() {
    const message =
      state && awaitsTestingConfirm(state)
        ? TESTING_READY_CONTINUE_USER_MESSAGE
        : testFailed || circuitOpen
          ? TEST_FAILURE_CONTINUE_USER_MESSAGE
          : CHECKLIST_CONTINUE_USER_MESSAGE;
    await getBridge()?.session.sendMessage(message);
  }

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      void continueBuild();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, testFailed, circuitOpen]);

  if (!show || !state) return null;

  return (
    <div
      className={
        isProviderError || circuitOpen || escalationLevel > 0
          ? "build-continue-banner build-continue-banner--error"
          : "build-continue-banner"
      }
      role="status"
    >
      <div className="build-continue-copy">
        <strong>
          {isProviderError
            ? "Provider error · build paused"
            : circuitOpen
              ? `${state?.planStatus === "checking" ? "Check" : "Test"} gate circuit open · ${
                  stalled ? "fix loop stalled" : "paid provider"
                }`
              : escalationLevel >= 2
                ? "Test gate · strong escalation"
                : escalationLevel > 0
                  ? "Test gate · strategy escalation"
                  : testFailed
                    ? state.planStatus === "checking"
                      ? "Check gate failed"
                      : "Test gate failed"
                    : checklistOpen
                      ? "Build paused · checklist incomplete"
                      : "Turn stopped · nothing is running"}
        </strong>
        {circuitOpen ? (
          stalled ? (
            <span>
              The agent read the failures for {MAX_GATE_FIX_ROUNDS_WITHOUT_EDIT}{" "}
              rounds without editing a file, so the loop was stopped. Review the
              digest, fix locally if needed, then Resume · Enter for another
              batch.
            </span>
          ) : (
            <span>
              Stopped auto-retry after {attempts} paid fix turn
              {attempts === 1 ? "" : "s"} (limit{" "}
              {TEST_GATE_PAID_AUTO_FIX_LIMIT}). Review the digest, fix locally
              if needed, then Resume · Enter for another batch.
            </span>
          )
        ) : escalationLevel > 0 && testFailed ? (
          <span>
            Same failure streak {streak}. Agent was told to stop micro-patches
            and rewrite brittle tests (data-testid). Resume · Enter to continue.
          </span>
        ) : testFailed ? (
          <span>
            Fix the reported failures (use read_test_log if needed), then
            Resume · Enter to continue. The IDE will re-run the gate after
            changes.
          </span>
        ) : checklistOpen ? (
          <span>
            {done}/{total} done · {open} open. Fix the issue if needed, then
            resume when you are ready.
          </span>
        ) : (
          <span>
            The last turn ended before the agent could finish. Nothing is
            running and nothing retries on its own — Resume · Enter to pick the
            work back up.
          </span>
        )}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void continueBuild()}
      >
        Resume · Enter
      </button>
    </div>
  );
}
