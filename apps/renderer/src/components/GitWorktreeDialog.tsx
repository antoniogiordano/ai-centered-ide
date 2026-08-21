import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNativeOverlay } from "../hooks/useNativeOverlay";
import { getBridge } from "../bridge";

export type GitWorktreeMode = "stash" | "unstash" | "commit";

type StashEntry = { index: number; ref: string; message: string };

/**
 * AI-drafted stash / commit, or pick a stash to pop. The model fills the
 * message; the human can edit it before Enter.
 */
export function GitWorktreeDialog(props: {
  open: boolean;
  mode: GitWorktreeMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const { open, mode, onClose, onDone } = props;
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useNativeOverlay(open);

  const isUnstash = mode === "unstash";
  const title =
    mode === "stash"
      ? "Stash changes"
      : mode === "commit"
        ? "Commit changes"
        : "Apply stash";

  async function draft() {
    if (isUnstash) return;
    setDrafting(true);
    setError(null);
    const res = await getBridge()?.session.draftGitMessage?.(
      mode === "stash" ? "stash" : "commit",
    );
    setDrafting(false);
    if (!res?.ok || !res.message) {
      setError(
        res?.error?.userMessage ??
          "Could not draft a message — write one manually.",
      );
      setFiles(res?.files ?? files);
      if (!message.trim()) {
        setMessage(
          mode === "stash"
            ? `wip: ${files.length || "local"} files`
            : `chore: local changes (${files.length} files)`,
        );
      }
      return;
    }
    setMessage(res.message);
    setFiles(res.files ?? []);
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setMessage("");
    setFiles([]);
    setStashes([]);
    setSelected(0);
    dialogRef.current?.focus();
    let cancelled = false;
    void (async () => {
      if (mode === "unstash") {
        const res = await getBridge()?.workspace.gitStashList?.();
        if (cancelled) return;
        const list = res?.stashes ?? [];
        setStashes(list);
        setSelected(list[0]?.index ?? 0);
        if (!res?.ok) {
          setError(res?.error?.userMessage ?? "Could not list stashes.");
        }
        return;
      }
      const status = await getBridge()?.workspace.gitStatus();
      if (cancelled) return;
      if (status && !status.dirty) {
        setError(
          mode === "stash"
            ? "Nothing to stash — the working tree is clean."
            : "Nothing to commit — the working tree is clean.",
        );
        return;
      }
      await draft();
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "unstash") {
        const res = await getBridge()?.workspace.gitStashPop?.(selected);
        if (!res?.ok) {
          throw new Error(res?.error?.userMessage ?? "Could not apply stash.");
        }
        onDone();
        if (res.conflicted?.length) {
          throw new Error(
            `Applied with ${res.conflicted.length} conflict${
              res.conflicted.length === 1 ? "" : "s"
            }.`,
          );
        }
        onClose();
        return;
      }
      const trimmed = message.trim();
      if (!trimmed) {
        setError("Write a message first.");
        setBusy(false);
        return;
      }
      const res =
        mode === "stash"
          ? await getBridge()?.workspace.gitStash?.(trimmed)
          : await getBridge()?.workspace.gitCommit?.(trimmed);
      if (!res?.ok) {
        throw new Error(
          res?.error?.userMessage ??
            (mode === "stash" ? "Stash failed." : "Commit failed."),
        );
      }
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (isUnstash || drafting || busy) return;
        e.preventDefault();
        void draft();
        return;
      }
      if (isUnstash && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const digit = e.code.startsWith("Digit")
          ? Number(e.code.slice(5))
          : Number.NaN;
        if (digit >= 1 && digit <= 9 && stashes[digit - 1]) {
          e.preventDefault();
          setSelected(stashes[digit - 1]!.index);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, drafting, isUnstash, stashes, onClose]);

  if (!open) return null;

  const confirmLabel =
    mode === "stash"
      ? busy
        ? "Stashing…"
        : "Stash · Enter"
      : mode === "commit"
        ? busy
          ? "Committing…"
          : "Commit · Enter"
        : busy
          ? "Applying…"
          : "Apply · Enter";

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="provider-dialog git-worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-worktree-title"
        tabIndex={-1}
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <div className="provider-dialog-header">
            <div>
              <div className="provider-dialog-kicker">Git</div>
              <h2 className="provider-dialog-title" id="git-worktree-title">
                {title}
              </h2>
            </div>
            <div className="btn-group">
              {!isUnstash ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={drafting || busy}
                  onClick={() => void draft()}
                >
                  {drafting ? "Drafting…" : "Redraft · R"}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={onClose}
              >
                Cancel · Esc
              </button>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={busy || drafting || (isUnstash && stashes.length === 0)}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
          <div className="provider-dialog-body">
            {isUnstash ? (
              stashes.length === 0 ? (
                <p className="provider-dialog-lead">No stashes on this repo.</p>
              ) : (
                <ul className="git-worktree-stashes">
                  {stashes.map((stash, index) => (
                    <li key={stash.ref}>
                      <button
                        type="button"
                        className={`btn btn-sm ${
                          stash.index === selected
                            ? "btn-primary"
                            : "btn-secondary"
                        }`}
                        onClick={() => setSelected(stash.index)}
                      >
                        {stash.message || stash.ref}
                        {index < 9 ? ` · ${index + 1}` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <>
                <label className="git-worktree-label" htmlFor="git-worktree-msg">
                  {mode === "stash" ? "Stash name" : "Commit message"}
                </label>
                <input
                  id="git-worktree-msg"
                  ref={(el) => {
                    inputRef.current = el;
                  }}
                  className="git-worktree-input"
                  value={message}
                  disabled={busy}
                  onChange={(e) => setMessage(e.target.value)}
                />
                {files.length > 0 ? (
                  <ul className="git-worktree-files">
                    {files.slice(0, 20).map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                    {files.length > 20 ? (
                      <li className="muted">{files.length - 20} more</li>
                    ) : null}
                  </ul>
                ) : null}
              </>
            )}
            {error ? <p className="git-worktree-error">{error}</p> : null}
          </div>
        </form>
      </div>
    </div>
  );
}
