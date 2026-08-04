import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { getBridge } from "../bridge";

/** Mirror of agent normalizeFeatBranchName for live validation in the dialog. */
function normalizeFeatBranchName(raw: string): string | null {
  let slug = raw.trim().toLowerCase();
  if (slug.startsWith("feat/")) slug = slug.slice("feat/".length);
  slug = slug
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) return null;
  return `feat/${slug}`;
}

type Props = {
  open: boolean;
  suggestedBranch: string;
  summary?: string | undefined;
  onClose: () => void;
  onConfirmed: () => void;
};

export function StartBuildDialog(props: Props) {
  const { open, suggestedBranch, summary, onClose, onConfirmed } = props;
  const [createBranch, setCreateBranch] = useState(true);
  const [branchDraft, setBranchDraft] = useState(suggestedBranch);
  const [existing, setExisting] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCreateBranch(true);
    setBranchDraft(suggestedBranch);
    setError(null);
    setBusy(false);
    let cancelled = false;
    void (async () => {
      const res = await getBridge()?.workspace.listBranches();
      if (cancelled || !res) return;
      setExisting(res.branches);
    })();
    const t = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, suggestedBranch]);

  const normalized = useMemo(
    () => normalizeFeatBranchName(branchDraft),
    [branchDraft],
  );

  const collision = useMemo(() => {
    if (!normalized) return false;
    return existing.includes(normalized);
  }, [existing, normalized]);

  const canConfirm =
    !busy &&
    (!createBranch || (Boolean(normalized) && !collision));

  const submit = useCallback(async () => {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getBridge()?.session.confirmPlan(
        createBranch && normalized
          ? { createBranch: true, branchName: normalized }
          : { createBranch: false },
      );
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "Could not start build.");
        setBusy(false);
        return;
      }
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [canConfirm, createBranch, normalized, onConfirmed]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "TEXTAREA") return;
        e.preventDefault();
        e.stopPropagation();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, onClose, submit]);

  if (!open) return null;

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div
      className="overlay palette-overlay qa-overlay start-build-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="qa-dialog start-build-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-build-title"
      >
        <div className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Plan ready</div>
            <h2 id="start-build-title" className="qa-dialog-title">
              Start building
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

        <form className="qa-dialog-body" onSubmit={onFormSubmit}>
          <p className="qa-dialog-lead">
            {summary?.trim()
              ? summary
              : "Create a feature branch from the plan, then switch this chat to Build mode."}
          </p>

          <label className="start-build-check">
            <input
              type="checkbox"
              checked={createBranch}
              disabled={busy}
              onChange={(e) => setCreateBranch(e.target.checked)}
            />
            <span>Create new branch · feat/*</span>
          </label>

          {createBranch ? (
            <label className="start-build-field">
              <span className="start-build-label">Branch name</span>
              <input
                ref={inputRef}
                className="start-build-input"
                value={branchDraft}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setBranchDraft(e.target.value)}
                onKeyDown={onInputKeyDown}
              />
              <span className="start-build-hint">
                {normalized
                  ? collision
                    ? `"${normalized}" already exists — pick another name`
                    : `Will create ${normalized}`
                  : "Use short kebab-case after feat/"}
              </span>
            </label>
          ) : (
            <p className="qa-dialog-lead">
              Stay on the current branch and enter Build mode.
            </p>
          )}

          {error ? <p className="start-build-error">{error}</p> : null}

          <div className="start-build-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canConfirm}
            >
              {createBranch ? "Create branch & start" : "Start without branch"}{" "}
              · Enter
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
