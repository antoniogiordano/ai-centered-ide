import { useCallback, useEffect, useState } from "react";
import type { WorkspaceGitStatusResponse } from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { formatAheadBehind } from "../lib/gitBranches";
import { GitBranchDialog } from "./GitBranchDialog";
import { GitWorktreeDialog, type GitWorktreeMode } from "./GitWorktreeDialog";

function modShiftHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

function overlayOpen(): boolean {
  return Boolean(document.querySelector(".overlay, [role='dialog']"));
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  const tag = el?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    Boolean(el?.isContentEditable)
  );
}

export type GitConflictNotice = {
  files: string[];
  branch: string | null;
  remote: string | null;
  operation: string;
};

export function GitBar(props: {
  workspaceReady: boolean;
  status: WorkspaceGitStatusResponse | null;
  onRefresh: (status?: WorkspaceGitStatusResponse) => void;
  onConflict: (notice: GitConflictNotice) => void;
}) {
  const { workspaceReady, status, onRefresh, onConflict } = props;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [worktreeMode, setWorktreeMode] = useState<GitWorktreeMode | null>(null);
  const [busy, setBusy] = useState<"pull" | "push" | "remote" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback(
    (next?: WorkspaceGitStatusResponse) => {
      if (next) onRefresh(next);
      else onRefresh();
    },
    [onRefresh],
  );

  const cycleRemote = useCallback(async () => {
    const remotes = status?.remotes ?? [];
    if (remotes.length < 2 || busy) return;
    const current = status?.compareRemote ?? remotes[0];
    const idx = Math.max(0, remotes.indexOf(current ?? ""));
    const next = remotes[(idx + 1) % remotes.length];
    if (!next) return;
    setBusy("remote");
    setError(null);
    try {
      const res = await getBridge()?.workspace.gitSetRemote(next);
      if (res?.ok && res.status) applyStatus(res.status);
      else if (res?.error) setError(res.error.userMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [applyStatus, busy, status?.compareRemote, status?.remotes]);

  const pull = useCallback(async () => {
    if (busy || !status?.compareRemote) return;
    setBusy("pull");
    setError(null);
    try {
      const res = await getBridge()?.workspace.gitPull(status.compareRemote);
      if (res?.status) applyStatus(res.status);
      if (res?.ok) return;
      if (res?.conflicted?.length) {
        onConflict({
          files: res.conflicted,
          branch: res.status?.localBranch ?? status.localBranch,
          remote: status.compareRemote,
          operation: "pull",
        });
        return;
      }
      setError(res?.error?.userMessage ?? "Pull failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [applyStatus, busy, onConflict, status]);

  const push = useCallback(async () => {
    if (busy) return;
    setBusy("push");
    setError(null);
    try {
      const res = await getBridge()?.workspace.gitPush(
        status?.compareRemote ?? undefined,
      );
      if (res?.status) applyStatus(res.status);
      if (!res?.ok) setError(res?.error?.userMessage ?? "Push failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [applyStatus, busy, status?.compareRemote]);

  const openPicker = useCallback(() => {
    if (!status?.isRepo) return;
    setPickerOpen(true);
  }, [status?.isRepo]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (pickerOpen || worktreeMode || overlayOpen()) return;
      if (e.key === "b" || e.key === "B") {
        if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
        e.preventDefault();
        openPicker();
        return;
      }
      if ((e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTypingTarget(e.target)) return;
        if (!status?.conflicted?.length) return;
        e.preventDefault();
        onConflict({
          files: status.conflicted,
          branch: status.localBranch,
          remote: status.compareRemote,
          operation: "merge",
        });
        return;
      }
      if (e.key === "r" || e.key === "R") {
        if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
        e.preventDefault();
        void cycleRemote();
        return;
      }
      if ((e.key === "u" || e.key === "U") && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        void pull();
        return;
      }
      if ((e.key === "y" || e.key === "Y") && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        void push();
        return;
      }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "t" || e.key === "T") && status?.dirty) {
        e.preventDefault();
        setWorktreeMode("stash");
        return;
      }
      if ((e.key === "u" || e.key === "U") && (status?.stashCount ?? 0) > 0) {
        e.preventDefault();
        setWorktreeMode("unstash");
        return;
      }
      if ((e.key === "m" || e.key === "M") && status?.dirty) {
        e.preventDefault();
        setWorktreeMode("commit");
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    cycleRemote,
    onConflict,
    openPicker,
    pickerOpen,
    pull,
    push,
    status,
    worktreeMode,
  ]);

  const remotes = status?.remotes ?? [];
  const canPull = Boolean(status?.compareRef) && busy == null;
  const canPush = Boolean(status?.hasRemote) && busy == null;
  const conflicted = status?.conflicted ?? [];

  return (
    <>
      <div className="git-bar" role="status" aria-label="Git branch">
        <div className="git-bar-label">Git</div>
        {!workspaceReady ? (
          <div className="git-bar-main muted">No workspace</div>
        ) : status == null ? (
          <div className="git-bar-main muted">Checking repository…</div>
        ) : !status.isRepo ? (
          <div className="git-bar-main muted">Not a git repository</div>
        ) : (
          <div className="git-bar-main">
            <button
              type="button"
              className="git-bar-branch"
              title="Switch branch · B"
              onClick={openPicker}
            >
              <span className="git-bar-key">local</span>
              <span className="git-bar-value">{status.localBranch ?? "—"}</span>
              <span className="git-bar-sc">· B</span>
            </button>
            <span className="git-bar-sep" aria-hidden>
              →
            </span>
            <button
              type="button"
              className="git-bar-branch"
              title={
                remotes.length > 1
                  ? `Compare remote (${modShiftHint("R")})`
                  : status.remoteBranch ?? "No upstream yet"
              }
              disabled={remotes.length < 2 || busy !== null}
              onClick={() => void cycleRemote()}
            >
              <span className="git-bar-key">remote</span>
              <span className={`git-bar-value ${status.compareRef ? "" : "muted"}`}>
                {status.compareRef ??
                  (status.hasRemote ? "push after first commit" : "no remote")}
              </span>
              {remotes.length > 1 ? (
                <span className="git-bar-sc">· {modShiftHint("R")}</span>
              ) : null}
            </button>
            <span
              className={`git-bar-sync ${
                (status.ahead ?? 0) > 0 || (status.behind ?? 0) > 0
                  ? "is-divergent"
                  : ""
              }`}
            >
              {formatAheadBehind(status.ahead, status.behind)}
            </span>
            {status.dirty ? (
              <span className="git-bar-pill">
                dirty{status.dirtyFileCount ? ` · ${status.dirtyFileCount}` : ""}
              </span>
            ) : null}
            {(status.stashCount ?? 0) > 0 ? (
              <span className="git-bar-pill">
                {status.stashCount} stash{status.stashCount === 1 ? "" : "es"}
              </span>
            ) : null}
            {conflicted.length > 0 ? (
              <button
                type="button"
                className="git-bar-pill git-bar-pill-conflict"
                title="Resolve conflicts · C"
                onClick={() =>
                  onConflict({
                    files: conflicted,
                    branch: status.localBranch,
                    remote: status.compareRemote,
                    operation: "merge",
                  })
                }
              >
                {conflicted.length} conflict{conflicted.length === 1 ? "" : "s"} · C
              </button>
            ) : null}
            <div className="git-bar-actions">
              {status.dirty ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    title="Stash dirty files · T"
                    onClick={() => setWorktreeMode("stash")}
                  >
                    Stash · T
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    title="Commit dirty files · M"
                    onClick={() => setWorktreeMode("commit")}
                  >
                    Commit · M
                  </button>
                </>
              ) : null}
              {(status.stashCount ?? 0) > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  title="Apply latest stash · U"
                  onClick={() => setWorktreeMode("unstash")}
                >
                  Unstash · U
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!canPull}
                title={`Pull from ${status.compareRemote ?? "remote"} (${modShiftHint("U")})`}
                onClick={() => void pull()}
              >
                {busy === "pull" ? "Pulling…" : `Pull · ${modShiftHint("U")}`}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!canPush}
                title={`Push to ${status.compareRemote ?? "origin"} (${modShiftHint("Y")})`}
                onClick={() => void push()}
              >
                {busy === "push" ? "Pushing…" : `Push · ${modShiftHint("Y")}`}
              </button>
            </div>
            {error ? (
              <span className="git-bar-error" title={error}>
                {error}
              </span>
            ) : null}
          </div>
        )}
      </div>
      <GitWorktreeDialog
        open={Boolean(worktreeMode)}
        mode={worktreeMode ?? "stash"}
        onClose={() => setWorktreeMode(null)}
        onDone={() => applyStatus()}
      />
      <GitBranchDialog
        open={pickerOpen}
        mode="switch"
        onClose={() => setPickerOpen(false)}
        onPicked={async ({ branch, dirtyStrategy }) => {
          const res = await getBridge()?.workspace.gitCheckout({
            branch,
            ...(dirtyStrategy ? { dirtyStrategy } : {}),
          });
          if (res?.status) applyStatus(res.status);
          if (!res?.ok) {
            throw new Error(res?.error?.userMessage ?? "Could not switch branch.");
          }
          if (res.conflicted.length) {
            onConflict({
              files: res.conflicted,
              branch,
              remote: status?.compareRemote ?? null,
              operation: "checkout",
            });
          }
        }}
      />
    </>
  );
}
