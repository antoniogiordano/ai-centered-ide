import { useEffect, useRef, useState } from "react";
import { useNativeOverlay } from "../hooks/useNativeOverlay";
import type { GitConflictNotice } from "./GitBar";

export function GitConflictDialog(props: {
  notice: GitConflictNotice | null;
  onClose: () => void;
  onResolve: (notice: GitConflictNotice) => Promise<void>;
}) {
  const { notice, onClose, onResolve } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = Boolean(notice);
  useNativeOverlay(open);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    dialogRef.current?.focus();
  }, [open, notice?.files.join("|")]);

  useEffect(() => {
    if (!open || !notice) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (e.key === "Enter" && !busy) {
        e.preventDefault();
        e.stopPropagation();
        void run();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  async function run() {
    if (!notice || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(notice);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!notice) return null;

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-conflict-title"
        tabIndex={-1}
      >
        <div className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Git conflicts</div>
            <h2 className="provider-dialog-title" id="git-conflict-title">
              Resolve in a new session
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={busy}
          >
            Later · Esc
          </button>
        </div>
        <div className="provider-dialog-body">
          <p className="provider-dialog-lead">
            {notice.operation} left {notice.files.length} conflicted{" "}
            {notice.files.length === 1 ? "file" : "files"}
            {notice.branch ? ` on ${notice.branch}` : ""}
            {notice.remote ? ` vs ${notice.remote}` : ""}. A dedicated chat
            can open the files, keep the right sides, and finish the merge.
          </p>
          {notice.files.length > 0 ? (
            <ul className="git-conflict-files">
              {notice.files.map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <p className="start-build-error">{error}</p> : null}
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run()}
            >
              {busy ? "Opening…" : "Resolve · Enter"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
