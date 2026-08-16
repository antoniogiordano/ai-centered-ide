import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
 * Foot-of-chat local commit step (was a modal dialog). Shown when the build
 * checklist is done, the test gate passed and there are uncommitted changes.
 */
export function CommitBuildBanner(props: {
  state: SessionState | null;
  onCommitted?: (() => void) | undefined;
}) {
  const { state, onCommitted } = props;
  const offer = state?.buildCommitOffer ?? null;
  const show = Boolean(offer) && !isBusy(state?.status);
  const offerKey = offer ? `${state?.sessionId}:${offer.offeredAt}` : null;

  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!offerKey || !offer) return;
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
  }, [offerKey]);

  const dismiss = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await getBridge()?.session.dismissBuildCommit();
    } finally {
      setBusy(false);
    }
  }, [busy]);

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
      setBusy(false);
      onCommitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, drafting, message, onCommitted]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void dismiss();
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
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, dismiss, submit]);

  if (!show || !offer) return null;

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  return (
    <div
      className="start-build-banner commit-build-banner"
      role="region"
      aria-label="Build complete — local commit"
    >
      <div className="start-build-banner-top">
        <div className="build-continue-copy">
          <strong>Build complete · local commit</strong>
          <span>
            Commit the build on{" "}
            <strong>{offer.branch ?? "current branch"}</strong>
            {offer.baseBranch ? ` (started from ${offer.baseBranch})` : ""}
            {offer.files.length
              ? ` · ${offer.files.length} changed file${offer.files.length === 1 ? "" : "s"}`
              : ""}
            .
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

      <form className="start-build-banner-form" onSubmit={onFormSubmit}>
        {drafting ? (
          <div className="thinking-row" role="status">
            <span className="thinking-spinner" aria-hidden />
            <span>Drafting commit message…</span>
          </div>
        ) : (
          <label className="start-build-field">
            <span className="start-build-label">Commit message</span>
            <textarea
              ref={textareaRef}
              className="start-build-input start-build-textarea"
              value={message}
              disabled={busy}
              rows={4}
              spellCheck
              onChange={(e) => setMessage(e.target.value)}
            />
            <span className="start-build-hint">
              Drafted by the local model. Edit freely, then commit.
            </span>
          </label>
        )}

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
            Skip · Esc
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
  );
}
