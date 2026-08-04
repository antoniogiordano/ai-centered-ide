import { useEffect } from "react";
import {
  planChecklistProgress,
  planHasOpenWork,
  CHECKLIST_CONTINUE_USER_MESSAGE,
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
 * Stop, or interrupt. User decides when to resume.
 */
export function BuildContinueBanner(props: { state: SessionState | null }) {
  const state = props.state;
  const show =
    Boolean(state) &&
    !isBusy(state?.status) &&
    state?.mode !== "plan" &&
    state?.planStatus !== "drafting" &&
    Boolean(state && planHasOpenWork(state));

  const { done, total } = state
    ? planChecklistProgress(state)
    : { done: 0, total: 0 };
  const open = total - done;
  const error = state?.error?.trim() || null;
  const isProviderError =
    Boolean(error) && error !== "Interrupted by user.";

  async function continueBuild() {
    await getBridge()?.session.sendMessage(CHECKLIST_CONTINUE_USER_MESSAGE);
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
  }, [show]);

  if (!show || !state) return null;

  return (
    <div
      className={
        isProviderError
          ? "build-continue-banner build-continue-banner--error"
          : "build-continue-banner"
      }
      role="status"
    >
      <div className="build-continue-copy">
        <strong>
          {isProviderError
            ? "Provider error · build paused"
            : "Build paused · checklist incomplete"}
        </strong>
        {isProviderError ? (
          <span>{error}</span>
        ) : null}
        <span>
          {done}/{total} done · {open} open. Fix the issue if needed, then
          resume when you are ready.
        </span>
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
