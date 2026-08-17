import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SessionState } from "@ai-ide/shared";
import { getBridge } from "../bridge";

/** Mirror of agent normalizeFeatBranchName for live validation. */
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

/** Order: current first, then main/master if not current, then others by last commit. */
function orderBaseBranches(
  current: string | null,
  local: Array<{ name: string; lastCommitAt: string }>,
): Array<{ name: string; label: string }> {
  const names = local.map((b) => b.name);
  const seen = new Set<string>();
  const out: Array<{ name: string; label: string }> = [];

  const push = (name: string, label: string) => {
    if (!name || seen.has(name) || !names.includes(name)) return;
    seen.add(name);
    out.push({ name, label });
  };

  if (current) push(current, `${current} (current)`);

  for (const preferred of ["main", "master"]) {
    if (preferred !== current) push(preferred, preferred);
  }

  for (const branch of local) {
    push(branch.name, branch.name);
  }

  return out;
}

type DirtyStrategy = "stash" | "commit_base";

function isBusy(status: SessionState["status"] | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running" ||
    status === "awaiting_approval"
  );
}

type Props = {
  state: SessionState | null;
  onConfirmed?: (() => void) | undefined;
};

  /**
 * Foot-of-chat controls to confirm a ready plan and enter Check (then Build).
 * Shown only after the agent turn finishes (plan is already in the transcript).
 */
export function StartBuildBanner(props: Props) {
  const { state, onConfirmed } = props;
  const proposal = state?.planReadyProposal ?? null;
  const planning =
    state?.mode === "plan" || state?.planStatus === "drafting";
  const show =
    Boolean(state) &&
    planning &&
    Boolean(proposal) &&
    !isBusy(state?.status);

  const suggestedBranch = proposal?.suggestedBranch ?? "feat/plan";
  const proposalKey = proposal
    ? `${state?.sessionId}:${suggestedBranch}:${proposal.summary ?? ""}`
    : null;

  const [createBranch, setCreateBranch] = useState(true);
  const [branchDraft, setBranchDraft] = useState(suggestedBranch);
  const [baseBranch, setBaseBranch] = useState<string>("");
  const [baseOptions, setBaseOptions] = useState<
    Array<{ name: string; label: string }>
  >([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);
  const [dirtyStrategy, setDirtyStrategy] = useState<DirtyStrategy>("stash");
  const [baseCommitMessage, setBaseCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reject = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await getBridge()?.session.rejectPlanReady();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  useEffect(() => {
    if (!show || !proposalKey) return;
    setCreateBranch(true);
    setBranchDraft(suggestedBranch);
    setDirtyStrategy("stash");
    setBaseCommitMessage("");
    setError(null);
    setBusy(false);
    let cancelled = false;
    void (async () => {
      const res = await getBridge()?.workspace.listBranches();
      if (cancelled || !res) return;
      setExisting(res.branches);
      setDirty(Boolean(res.dirty));
      setDirtyFileCount(res.dirtyFileCount ?? 0);
      const options = orderBaseBranches(
        res.current,
        res.localBranches ?? [],
      );
      setBaseOptions(options);
      const initialBase = res.current ?? options[0]?.name ?? "";
      setBaseBranch(initialBase);
      if (initialBase) {
        setBaseCommitMessage(
          `chore: checkpoint before branching from ${initialBase}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [show, proposalKey, suggestedBranch]);

  useEffect(() => {
    if (!baseBranch) return;
    setBaseCommitMessage((prev) => {
      if (!prev || prev.startsWith("chore: checkpoint before branching from ")) {
        return `chore: checkpoint before branching from ${baseBranch}`;
      }
      return prev;
    });
  }, [baseBranch]);

  const normalized = useMemo(
    () => normalizeFeatBranchName(branchDraft),
    [branchDraft],
  );

  const collision = useMemo(() => {
    if (!normalized) return false;
    return existing.includes(normalized);
  }, [existing, normalized]);

  const needsDirtyChoice = createBranch && dirty;
  const canConfirm =
    !busy &&
    (!createBranch ||
      (Boolean(normalized) &&
        !collision &&
        Boolean(baseBranch) &&
        (!needsDirtyChoice ||
          dirtyStrategy === "stash" ||
          (dirtyStrategy === "commit_base" &&
            Boolean(baseCommitMessage.trim())))));

  const submit = useCallback(async () => {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getBridge()?.session.confirmPlan(
        createBranch && normalized
          ? {
              createBranch: true,
              branchName: normalized,
              ...(baseBranch ? { baseBranch } : {}),
              ...(needsDirtyChoice ? { dirtyStrategy } : {}),
              ...(needsDirtyChoice && dirtyStrategy === "commit_base"
                ? { baseCommitMessage: baseCommitMessage.trim() }
                : {}),
            }
          : { createBranch: false },
      );
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "Could not start build.");
        setBusy(false);
        return;
      }
      onConfirmed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [
    baseBranch,
    baseCommitMessage,
    canConfirm,
    createBranch,
    dirtyStrategy,
    needsDirtyChoice,
    normalized,
    onConfirmed,
  ]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) void reject();
        return;
      }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        // Composer and other inputs keep their own Enter; banner fields wire Enter locally.
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        e.stopPropagation();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, busy, reject, submit]);

  if (!show || !proposal) return null;

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
    <div className="start-build-banner" role="region" aria-label="Start check and build">
      <div className="start-build-banner-top">
        <div className="build-continue-copy">
          <strong>Plan ready · Check then Build</strong>
          <span>
            Choose a branch (optional), then start. Check runs the baseline
            test gate on the branch before Build begins.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void reject()}
          disabled={busy}
        >
          Cancel · Esc
        </button>
      </div>

      <form className="start-build-banner-form" onSubmit={onFormSubmit}>
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
          <div className="start-build-banner-fields">
            <label className="start-build-field">
              <span className="start-build-label">Start from</span>
              <select
                className="start-build-input start-build-select"
                value={baseBranch}
                disabled={busy || baseOptions.length === 0}
                onChange={(e) => setBaseBranch(e.target.value)}
              >
                {baseOptions.length === 0 ? (
                  <option value="">No local branches</option>
                ) : (
                  baseOptions.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.label}
                    </option>
                  ))
                )}
              </select>
            </label>

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
                    : `Will create ${normalized} from ${baseBranch || "HEAD"}`
                  : "Use short kebab-case after feat/"}
              </span>
            </label>
          </div>
        ) : (
          <p className="start-build-hint">
            Stay on the current branch and enter Build mode.
          </p>
        )}

        {needsDirtyChoice ? (
          <fieldset className="start-build-dirty">
            <legend className="start-build-label">
              Uncommitted changes
              {dirtyFileCount > 0 ? ` · ${dirtyFileCount} files` : ""}
            </legend>
            <p className="start-build-hint">
              The worktree is dirty. Choose how to leave the base before creating
              the feat branch.
            </p>

            <label className="start-build-radio">
              <input
                type="radio"
                name="dirty-strategy"
                checked={dirtyStrategy === "stash"}
                disabled={busy}
                onChange={() => setDirtyStrategy("stash")}
              />
              <span>
                <strong>Stash</strong> — park changes, branch from the last
                commit on <code>{baseBranch || "base"}</code>
              </span>
            </label>

            <label className="start-build-radio">
              <input
                type="radio"
                name="dirty-strategy"
                checked={dirtyStrategy === "commit_base"}
                disabled={busy}
                onChange={() => setDirtyStrategy("commit_base")}
              />
              <span>
                <strong>Commit on base</strong> — commit on{" "}
                <code>{baseBranch || "base"}</code>, then fork the feat branch
              </span>
            </label>

            {dirtyStrategy === "commit_base" ? (
              <label className="start-build-field">
                <span className="start-build-label">Base commit message</span>
                <input
                  className="start-build-input"
                  value={baseCommitMessage}
                  disabled={busy}
                  onChange={(e) => setBaseCommitMessage(e.target.value)}
                />
              </label>
            ) : null}
          </fieldset>
        ) : null}

        {error ? <p className="start-build-error">{error}</p> : null}

        <div className="start-build-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canConfirm}
          >
            {createBranch ? "Create branch & start Check" : "Start Check"} ·
            Enter
          </button>
        </div>
      </form>
    </div>
  );
}
