import { useEffect, useRef, useState } from "react";
import { getBridge } from "../bridge";
import { useNativeOverlay } from "../hooks/useNativeOverlay";
import { orderStartBranches, type GitBranchOption } from "../lib/gitBranches";

type DirtyStrategy = "stash" | "force";

export function GitBranchDialog(props: {
  open: boolean;
  mode: "new-session" | "switch";
  onClose: () => void;
  onPicked: (input: {
    branch: string;
    dirtyStrategy?: DirtyStrategy;
  }) => Promise<void>;
}) {
  const { open, mode, onClose, onPicked } = props;
  const [options, setOptions] = useState<GitBranchOption[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [dirty, setDirty] = useState(false);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);
  const [dirtyStrategy, setDirtyStrategy] = useState<DirtyStrategy>("stash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useNativeOverlay(open);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setDirtyStrategy("stash");
    dialogRef.current?.focus();
    let cancelled = false;
    void (async () => {
      const res = await getBridge()?.workspace.listBranches();
      if (cancelled || !res) return;
      const next = orderStartBranches(
        res.current,
        res.localBranches ?? [],
        res.remoteHeads ?? [],
      );
      setOptions(next);
      setCurrent(res.current);
      setDirty(Boolean(res.dirty));
      setDirtyFileCount(res.dirtyFileCount ?? 0);
      const preferred =
        next.find((o) => o.name === "main" || o.name === "master")?.name ??
        next[0]?.name ??
        res.current ??
        "";
      setSelected(mode === "new-session" ? preferred : (res.current ?? preferred));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode]);

  const changing = Boolean(selected && selected !== current);
  const needsDirty = dirty && changing;

  async function confirm() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPicked({
        branch: selected,
        ...(needsDirty ? { dirtyStrategy } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (busy) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void confirm();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean((e.target as HTMLElement | null)?.isContentEditable);
      if (typing) return;
      if (e.key >= "1" && e.key <= "9") {
        const option = options[Number(e.key) - 1];
        if (option) {
          e.preventDefault();
          setSelected(option.name);
        }
        return;
      }
      if (needsDirty && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        setDirtyStrategy("stash");
        return;
      }
      if (needsDirty && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setDirtyStrategy("force");
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!open) return null;

  const title =
    mode === "new-session" ? "New session branch" : "Switch branch";
  const lead =
    mode === "new-session"
      ? "This workspace has one working tree. The new chat starts on the branch you pick — other chats stay in history, but the files on disk will match this branch."
      : "Checkout a local branch, or create a local tracking branch from a remote head.";
  const confirmLabel =
    mode === "new-session"
      ? busy
        ? "Opening…"
        : "Create · Enter"
      : busy
        ? "Switching…"
        : "Switch · Enter";

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-branch-title"
        tabIndex={-1}
      >
        <div className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Git</div>
            <h2 className="provider-dialog-title" id="git-branch-title">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
            disabled={busy}
          >
            Cancel · Esc
          </button>
        </div>
        <div className="provider-dialog-body">
          <p className="provider-dialog-lead">{lead}</p>
          {options.length === 0 ? (
            <p className="start-build-hint">No branches found.</p>
          ) : (
            <div className="git-branch-list" role="listbox" aria-label="Branches">
              {options.map((option, index) => {
                const digit = index < 9 ? String(index + 1) : null;
                const active = option.name === selected;
                return (
                  <button
                    key={option.name}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`git-branch-option ${active ? "is-active" : ""}`}
                    onClick={() => setSelected(option.name)}
                    disabled={busy}
                  >
                    <span>{option.label}</span>
                    {digit ? <span className="git-branch-sc">· {digit}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
          {needsDirty ? (
            <div className="git-dirty-box">
              <p className="start-build-hint">
                {dirtyFileCount} uncommitted {dirtyFileCount === 1 ? "file" : "files"}.
                Stash keeps them; discard throws them away.
              </p>
              <div className="onboarding-actions">
                <button
                  type="button"
                  className={`btn btn-secondary btn-sm ${dirtyStrategy === "stash" ? "is-active" : ""}`}
                  onClick={() => setDirtyStrategy("stash")}
                >
                  Stash · S
                </button>
                <button
                  type="button"
                  className={`btn btn-secondary btn-sm ${dirtyStrategy === "force" ? "is-active" : ""}`}
                  onClick={() => setDirtyStrategy("force")}
                >
                  Discard · D
                </button>
              </div>
            </div>
          ) : null}
          {error ? <p className="start-build-error">{error}</p> : null}
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !selected}
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
