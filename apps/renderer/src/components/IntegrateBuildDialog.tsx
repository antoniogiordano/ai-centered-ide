import { useCallback, useEffect, useState } from "react";
import type { BuildIntegrateOffer } from "@ai-ide/shared";
import { getBridge } from "../bridge";

type Props = {
  open: boolean;
  offer: BuildIntegrateOffer | null;
  onClose: () => void;
  onDone: () => void;
};

export function IntegrateBuildDialog(props: Props) {
  const { open, offer, onClose, onDone } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !offer) return;
    setBusy(false);
    setError(null);
  }, [open, offer?.offeredAt]);

  const dismiss = useCallback(async () => {
    await getBridge()?.session.dismissBuildIntegrate();
    onClose();
  }, [onClose]);

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
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [busy, onDone],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) void dismiss();
        return;
      }
      if (busy) return;
      if (e.key === "1" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        void run("pr");
        return;
      }
      if (e.key === "2" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        void run("merge");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, dismiss, run]);

  if (!open || !offer) return null;

  return (
    <div
      className="overlay palette-overlay qa-overlay start-build-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) void dismiss();
      }}
    >
      <div
        className="qa-dialog start-build-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="integrate-build-title"
      >
        <div className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Tests passed</div>
            <h2 id="integrate-build-title" className="qa-dialog-title">
              Integrate branch
            </h2>
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

        <div className="qa-dialog-body">
          <p className="qa-dialog-lead">
            Head <strong>{offer.headBranch}</strong> started from{" "}
            <strong>{offer.baseBranch}</strong>. Open a remote pull request, or
            merge locally into that base.
          </p>

          {error ? <p className="start-build-error">{error}</p> : null}

          <div className="start-build-actions start-build-actions-stack">
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
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void dismiss()}
            >
              Skip · Esc
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
