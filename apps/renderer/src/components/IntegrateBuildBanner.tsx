import { useCallback, useEffect, useState } from "react";
import type { SessionState } from "@ai-ide/shared";
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
 * Foot-of-chat integrate step (was a modal dialog). After tests + commit/skip:
 * open a remote PR or merge the feat branch locally into the Start Build base.
 */
export function IntegrateBuildBanner(props: {
  state: SessionState | null;
  onDone?: (() => void) | undefined;
}) {
  const { state, onDone } = props;
  const offer = state?.buildIntegrateOffer ?? null;
  const show = Boolean(offer) && !isBusy(state?.status);
  const offerKey = offer ? `${state?.sessionId}:${offer.offeredAt}` : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!offerKey) return;
    setBusy(false);
    setError(null);
  }, [offerKey]);

  const dismiss = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await getBridge()?.session.dismissBuildIntegrate();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const run = useCallback(
    async (action: "pr" | "merge") => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await getBridge()?.session.integrateBuild(action);
        if (!res?.ok) {
          setError(res?.error?.userMessage ?? "Action failed.");
          setBusy(false);
          return;
        }
        setBusy(false);
        onDone?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [busy, onDone],
  );

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void dismiss();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "1") {
        e.preventDefault();
        e.stopPropagation();
        void run("pr");
        return;
      }
      if (e.key === "2") {
        e.preventDefault();
        e.stopPropagation();
        void run("merge");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, dismiss, run]);

  if (!show || !offer) return null;

  return (
    <div
      className="start-build-banner integrate-build-banner"
      role="region"
      aria-label="Tests passed — integrate branch"
    >
      <div className="start-build-banner-top">
        <div className="build-continue-copy">
          <strong>Tests passed · integrate branch</strong>
          <span>
            Head <strong>{offer.headBranch}</strong> started from{" "}
            <strong>{offer.baseBranch}</strong>. Open a remote pull request, or
            merge locally into that base.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void dismiss()}
          disabled={busy}
        >
          Skip · Esc
        </button>
      </div>

      {error ? <p className="start-build-error">{error}</p> : null}

      <div className="start-build-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void run("pr")}
        >
          Open PR on remote · 1
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void run("merge")}
        >
          Merge locally into {offer.baseBranch} · 2
        </button>
      </div>
    </div>
  );
}
