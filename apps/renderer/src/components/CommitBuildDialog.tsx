import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { BuildCommitOffer } from "@ai-ide/shared";
import { getBridge } from "../bridge";

type Props = {
  open: boolean;
  offer: BuildCommitOffer | null;
  onClose: () => void;
  onCommitted: () => void;
};

export function CommitBuildDialog(props: Props) {
  const { open, offer, onClose, onCommitted } = props;
  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || !offer) return;
    setMessage("");
    setError(null);
    setBusy(false);
    setDrafting(true);
    let cancelled = false;
    void (async () => {
      const res = await getBridge()?.session.draftBuildCommit();
      if (cancelled) return;
      setDrafting(false);
      if (!res?.ok || !res.message) {
        setError(
          res?.error?.userMessage ??
            "Could not draft a commit message — write one manually.",
        );
        setMessage(
          `feat: complete build on ${offer.branch ?? "branch"} (${offer.files.length} files)`,
        );
        return;
      }
      setMessage(res.message);
      window.setTimeout(() => textareaRef.current?.focus(), 40);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, offer?.offeredAt]);

  const dismiss = useCallback(async () => {
    await getBridge()?.session.dismissBuildCommit();
    onClose();
  }, [onClose]);

  const submit = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed || busy || drafting) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getBridge()?.session.commitBuild(trimmed);
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "Commit failed.");
        setBusy(false);
        return;
      }
      onCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, drafting, message, onCommitted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) void dismiss();
        return;
      }
      if (
        e.key === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, dismiss, submit]);

  if (!open || !offer) return null;

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

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
        aria-labelledby="commit-build-title"
      >
        <div className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Build complete</div>
            <h2 id="commit-build-title" className="qa-dialog-title">
              Local commit
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

        <form className="qa-dialog-body" onSubmit={onFormSubmit}>
          <p className="qa-dialog-lead">
            Commit the build on{" "}
            <strong>{offer.branch ?? "current branch"}</strong>
            {offer.baseBranch
              ? ` (started from ${offer.baseBranch})`
              : ""}
            {offer.files.length
              ? ` · ${offer.files.length} changed file${offer.files.length === 1 ? "" : "s"}`
              : ""}
            .
          </p>

          <label className="start-build-field">
            <span className="start-build-label">
              Commit message
              {drafting ? " · drafting…" : ""}
            </span>
            <textarea
              ref={textareaRef}
              className="start-build-input start-build-textarea"
              value={message}
              disabled={busy || drafting}
              rows={4}
              spellCheck
              onChange={(e) => setMessage(e.target.value)}
            />
            <span className="start-build-hint">
              Drafted by the local model. Edit freely, then commit.
            </span>
          </label>

          {offer.files.length > 0 ? (
            <div className="commit-build-files">
              {offer.files.slice(0, 12).map((f) => (
                <code key={f}>{f}</code>
              ))}
              {offer.files.length > 12 ? (
                <span>+{offer.files.length - 12} more</span>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="start-build-error">{error}</p> : null}

          <div className="start-build-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void dismiss()}
            >
              Skip
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || drafting || !message.trim()}
            >
              Commit locally · ⌘/Ctrl+Enter
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
