import type { GitConflictNotice } from "./GitBar";

export function GitConflictBanner(props: {
  notice: GitConflictNotice | null;
  dialogOpen: boolean;
  onResolve: (notice: GitConflictNotice) => void;
}) {
  const { notice, dialogOpen, onResolve } = props;
  const show = Boolean(notice && notice.files.length > 0 && !dialogOpen);

  if (!show || !notice) return null;

  return (
    <div className="git-conflict-banner" role="status">
      <div className="build-continue-copy">
        <strong>Merge conflicts</strong>
        <p>
          {notice.files.length} file{notice.files.length === 1 ? "" : "s"} still
          conflicted{notice.branch ? ` on ${notice.branch}` : ""}. Open a
          dedicated session to resolve them.
        </p>
      </div>
      <button
        type="button"
        className="btn btn-sm"
        title="Resolve conflicts · C"
        onClick={() => onResolve(notice)}
      >
        Resolve · C
      </button>
    </div>
  );
}
