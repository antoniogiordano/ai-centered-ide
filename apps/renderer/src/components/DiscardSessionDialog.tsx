import { useEffect, useRef, useState } from "react";
import { useNativeOverlay } from "../hooks/useNativeOverlay";
import { getBridge } from "../bridge";

/**
 * Confirm discarding a chat. If Start Build created a feat/* branch, the
 * human can delete that local branch too — never without this dialog.
 */
export function DiscardSessionDialog(props: {
  open: boolean;
  sessionId: string | null;
  title: string;
  featBranch: string | null;
  onClose: () => void;
  onDiscarded: () => void;
}) {
  const { open, sessionId, title, featBranch, onClose, onDiscarded } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedBranch, setResolvedBranch] = useState<string | null>(
    featBranch,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  useNativeOverlay(open);

  useEffect(() => {
    if (!open) return;
    setResolvedBranch(featBranch);
    if (featBranch || !sessionId) return;
    void getBridge()
      ?.session.getLog(sessionId)
      .then((res) => {
        if (res?.log?.featBranch) setResolvedBranch(res.log.featBranch);
      })
      .catch(() => undefined);
  }, [open, featBranch, sessionId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (busy) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void run(Boolean(resolvedBranch));
        return;
      }
      if (e.key === "2" && resolvedBranch) {
        e.preventDefault();
        void run(false);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, resolvedBranch, onClose]);

  async function run(deleteBranch: boolean) {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await getBridge()?.session.discard(sessionId, deleteBranch);
      if (!result?.ok) {
        setError(
          result?.error?.userMessage ??
            result?.error?.technicalDetail ??
            "Could not discard the session.",
        );
        return;
      }
      onDiscarded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discard-session-title"
        tabIndex={-1}
      >
        <div className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Discard session</div>
            <h2 className="provider-dialog-title" id="discard-session-title">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Cancel · Esc
          </button>
        </div>
        <div className="provider-dialog-body">
          <p className="provider-dialog-lead">
            This closes the chat and keeps the analytics log. Uncommitted work
            on the feat branch is lost if you delete the branch.
          </p>
          {resolvedBranch ? (
            <p className="start-build-hint">
              Local branch <code>{resolvedBranch}</code> will be deleted after
              checking out the remembered base. Remotes are not touched.
            </p>
          ) : (
            <p className="start-build-hint">
              No feat branch is recorded for this session — only the chat is
              discarded.
            </p>
          )}
          {error ? <p className="start-build-error">{error}</p> : null}
          <div className="onboarding-actions">
            {resolvedBranch ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void run(false)}
              >
                Keep branch · 2
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(Boolean(resolvedBranch))}
            >
              {busy
                ? "Discarding…"
                : resolvedBranch
                  ? "Delete branch · Enter"
                  : "Discard · Enter"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
