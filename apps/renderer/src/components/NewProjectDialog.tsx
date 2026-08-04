import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { getBridge } from "../bridge";
import type { GithubOwner } from "@ai-ide/shared";

type GithubMode = "skip" | "remote_url" | "create";

const LAST_PARENT_KEY = "ai-ide-new-project-parent";

function modShortcutHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

function readLastParentPath(): string {
  try {
    return localStorage.getItem(LAST_PARENT_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function writeLastParentPath(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(LAST_PARENT_KEY, trimmed);
  } catch {
    /* ignore quota / private mode */
  }
}

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

export function NewProjectDialog(props: Props) {
  const { open, onClose, onCreated } = props;
  const [step, setStep] = useState<"details" | "github">("details");
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [githubMode, setGithubMode] = useState<GithubMode>("skip");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [owner, setOwner] = useState("");
  const [owners, setOwners] = useState<GithubOwner[]>([]);
  const [ghInstalled, setGhInstalled] = useState(true);
  const [ghAuthenticated, setGhAuthenticated] = useState(false);
  const [ghLogin, setGhLogin] = useState<string | null>(null);
  const [ghDetail, setGhDetail] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [showTokenLogin, setShowTokenLogin] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const refreshGhStatus = useCallback(async () => {
    const status = await getBridge()?.github.status();
    if (!status) return;
    setGhInstalled(status.installed);
    setGhAuthenticated(status.authenticated);
    setGhLogin(status.login);
    setOwners(status.owners);
    setGhDetail(status.detail);
    setOwner((prev) => {
      if (prev && status.owners.some((o) => o.login === prev)) return prev;
      return status.login ?? status.owners[0]?.login ?? "";
    });
  }, []);

  const applyGhStatus = useCallback(
    (status: {
      installed: boolean;
      authenticated: boolean;
      login: string | null;
      owners: GithubOwner[];
      detail: string | null;
    }) => {
      setGhInstalled(status.installed);
      setGhAuthenticated(status.authenticated);
      setGhLogin(status.login);
      setOwners(status.owners);
      setGhDetail(status.detail);
      setOwner((prev) => {
        if (prev && status.owners.some((o) => o.login === prev)) return prev;
        return status.login ?? status.owners[0]?.login ?? "";
      });
    },
    [],
  );

  const logoutGh = useCallback(async () => {
    setError(null);
    setAuthBusy(true);
    try {
      const res = await getBridge()?.github.logout(ghLogin ?? undefined);
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "Could not log out of GitHub CLI.");
        return;
      }
      if (res.status) applyGhStatus(res.status);
      else await refreshGhStatus();
      setGhDetail("Logged out. Sign in with browser or a token below.");
      setTokenDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }, [ghLogin, applyGhStatus, refreshGhStatus]);

  const loginWeb = useCallback(async () => {
    setError(null);
    setAuthBusy(true);
    setGhDetail(
      "Browser opened. Paste the one-time code from your clipboard (⌘V) on GitHub, then Continue.",
    );
    try {
      const res = await getBridge()?.github.loginWeb();
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "GitHub browser sign-in failed.");
        setGhDetail(null);
        return;
      }
      if (res.status) applyGhStatus(res.status);
      else await refreshGhStatus();
      setGhDetail(null);
      setTokenDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGhDetail(null);
    } finally {
      setAuthBusy(false);
    }
  }, [applyGhStatus, refreshGhStatus]);

  const loginToken = useCallback(async () => {
    const token = tokenDraft.trim();
    if (!token) {
      setError("Paste a GitHub personal access token.");
      return;
    }
    setError(null);
    setAuthBusy(true);
    try {
      const res = await getBridge()?.github.loginToken(token);
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "GitHub token sign-in failed.");
        return;
      }
      if (res.status) applyGhStatus(res.status);
      else await refreshGhStatus();
      setTokenDraft("");
      setShowTokenLogin(false);
      setGhDetail(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }, [tokenDraft, applyGhStatus, refreshGhStatus]);

  const cancelAuth = useCallback(async () => {
    await getBridge()?.github.loginCancel();
    setAuthBusy(false);
    setGhDetail(null);
  }, []);

  const reset = useCallback(() => {
    setStep("details");
    setName("");
    setParentPath(readLastParentPath());
    setGithubMode("skip");
    setRemoteUrl("");
    setRepoName("");
    setRepoPrivate(true);
    setOwner("");
    setOwners([]);
    setGhInstalled(true);
    setGhAuthenticated(false);
    setGhLogin(null);
    setGhDetail(null);
    setTokenDraft("");
    setShowTokenLogin(false);
    setAuthBusy(false);
    setBusy(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    reset();
    const t = window.setTimeout(() => nameRef.current?.focus(), 40);
    void refreshGhStatus();
    return () => window.clearTimeout(t);
  }, [open, reset, refreshGhStatus]);

  const pickParent = useCallback(async () => {
    const res = await getBridge()?.workspace.pickDirectory();
    if (!res || res.canceled || !res.path) return;
    setParentPath(res.path);
  }, []);

  const close = useCallback(() => {
    if (busy || authBusy) {
      if (authBusy) void cancelAuth();
      if (busy) return;
    }
    onClose();
  }, [busy, authBusy, cancelAuth, onClose]);

  const create = useCallback(
    async (mode: GithubMode) => {
      const trimmedName = name.trim();
      if (!trimmedName || !parentPath.trim()) {
        setError("Name and parent folder are required.");
        return;
      }

      setGithubMode(mode);

      if (mode === "remote_url" && !remoteUrl.trim()) {
        setError("Paste a remote URL, then press 2 again.");
        return;
      }
      if (mode === "create") {
        if (!ghInstalled || !ghAuthenticated) {
          setError(
            ghDetail ??
              "Sign in with browser or a token, then press 3 again.",
          );
          return;
        }
        if (!owner.trim()) {
          setError("Choose a GitHub account or organization.");
          return;
        }
      }

      setBusy(true);
      setError(null);
      try {
        const res = await getBridge()?.workspace.createProject({
          parentPath: parentPath.trim(),
          name: trimmedName,
          github:
            mode === "skip"
              ? { mode: "skip" }
              : mode === "remote_url"
                ? { mode: "remote_url", remoteUrl: remoteUrl.trim() }
                : {
                    mode: "create",
                    repoName: repoName.trim() || trimmedName,
                    private: repoPrivate,
                    owner: owner.trim(),
                  },
        });
        if (!res?.ok) {
          setError(res?.error?.userMessage ?? "Could not create project.");
          setBusy(false);
          return;
        }
        onCreated();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [
      name,
      parentPath,
      remoteUrl,
      ghInstalled,
      ghAuthenticated,
      ghDetail,
      owner,
      repoName,
      repoPrivate,
      onCreated,
    ],
  );

  const selectGithubMode = useCallback((mode: GithubMode) => {
    setError(null);
    setGithubMode(mode);
    if (mode === "create") void refreshGhStatus();
  }, [refreshGhStatus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (authBusy) {
          void cancelAuth();
          return;
        }
        if (!busy) close();
        return;
      }

      // Details: Choose parent folder · ⌘/Ctrl+O (override global open-workspace while dialog is open)
      if (
        step === "details" &&
        !busy &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "o"
      ) {
        e.preventDefault();
        e.stopPropagation();
        void pickParent();
        return;
      }

      // Details / github: Back · Backspace when not typing
      if (
        e.key === "Backspace" &&
        !busy &&
        !authBusy &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        const typing =
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        if (!typing && step === "github") {
          e.preventDefault();
          e.stopPropagation();
          setError(null);
          setStep("details");
          return;
        }
      }

      if (step !== "github" || busy || authBusy || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (typing && e.key !== "1" && e.key !== "2" && e.key !== "3") {
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        e.stopPropagation();
        void create("skip");
        return;
      }
      if (e.key === "2") {
        e.preventDefault();
        e.stopPropagation();
        if (!remoteUrl.trim()) {
          selectGithubMode("remote_url");
          setError("Paste a remote URL, then press 2 again.");
          return;
        }
        void create("remote_url");
        return;
      }
      if (e.key === "3") {
        e.preventDefault();
        e.stopPropagation();
        if (!ghInstalled || !ghAuthenticated) {
          selectGithubMode("create");
          setError(
            ghDetail ??
              "Sign in with browser or a token, then press 3 again.",
          );
          return;
        }
        void create("create");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    open,
    busy,
    authBusy,
    step,
    close,
    cancelAuth,
    create,
    selectGithubMode,
    remoteUrl,
    ghInstalled,
    ghAuthenticated,
    ghDetail,
    pickParent,
  ]);

  if (!open) return null;

  function onDetailsSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !parentPath.trim()) {
      setError("Name and parent folder are required.");
      return;
    }
    writeLastParentPath(parentPath);
    setError(null);
    setRepoName((prev) => prev || name.trim());
    setStep("github");
    void refreshGhStatus();
  }

  return (
    <div
      className="overlay palette-overlay qa-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div
        className="qa-dialog new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <div className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Workspace</div>
            <h2 id="new-project-title" className="qa-dialog-title">
              New project
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={close}
            disabled={busy}
          >
            Cancel · Esc
          </button>
        </div>

        {step === "details" ? (
          <form className="qa-dialog-body" onSubmit={onDetailsSubmit}>
            <p className="qa-dialog-lead">
              Create an empty folder with git initialized. No scaffold files.
            </p>

            <label className="start-build-field">
              <span className="start-build-label">Project name</span>
              <input
                ref={nameRef}
                className="start-build-input"
                value={name}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className="start-build-field">
              <span className="start-build-label">Parent folder</span>
              <div className="new-project-path-row">
                <input
                  className="start-build-input"
                  value={parentPath}
                  readOnly
                  placeholder="Choose a folder"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void pickParent()}
                  disabled={busy}
                  title={`Choose parent folder (${modShortcutHint("O")})`}
                >
                  Choose · {modShortcutHint("O")}
                </button>
              </div>
            </label>

            {error ? (
              <p className="qa-dialog-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="qa-dialog-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Continue · Enter
              </button>
            </div>
          </form>
        ) : (
          <div className="qa-dialog-body">
            <p className="qa-dialog-lead">
              Optionally link GitHub. Empty repos get an <code>origin</code>{" "}
              remote only — push after the first commit.
            </p>

            <div
              className="new-project-mode-row"
              role="group"
              aria-label="Create options"
            >
              <button
                type="button"
                className={`btn btn-sm ${githubMode === "skip" ? "btn-primary" : "btn-secondary"}`}
                disabled={busy || authBusy}
                onClick={() => void create("skip")}
              >
                Skip · 1
              </button>
              <button
                type="button"
                className={`btn btn-sm ${githubMode === "remote_url" ? "btn-primary" : "btn-secondary"}`}
                disabled={busy || authBusy}
                onClick={() => {
                  if (!remoteUrl.trim()) {
                    selectGithubMode("remote_url");
                    setError("Paste a remote URL, then press 2 again.");
                    return;
                  }
                  void create("remote_url");
                }}
              >
                Remote URL · 2
              </button>
              <button
                type="button"
                className={`btn btn-sm ${githubMode === "create" ? "btn-primary" : "btn-secondary"}`}
                disabled={busy || authBusy}
                onClick={() => {
                  if (!ghInstalled || !ghAuthenticated) {
                    selectGithubMode("create");
                    setError(
                      ghDetail ??
                        "Sign in with browser or a token, then press 3 again.",
                    );
                    return;
                  }
                  void create("create");
                }}
              >
                {busy && githubMode === "create" ? "Creating" : "Create on GitHub · 3"}
              </button>
            </div>

            {githubMode === "remote_url" || remoteUrl ? (
              <label className="start-build-field">
                <span className="start-build-label">Remote URL</span>
                <input
                  className="start-build-input"
                  value={remoteUrl}
                  disabled={busy || authBusy}
                  spellCheck={false}
                  placeholder="https://github.com/org/repo.git"
                  onChange={(e) => {
                    setRemoteUrl(e.target.value);
                    selectGithubMode("remote_url");
                  }}
                  onFocus={() => selectGithubMode("remote_url")}
                />
              </label>
            ) : null}

            {githubMode === "create" ? (
              <>
                <div className="start-build-field">
                  <span className="start-build-label">GitHub CLI</span>
                  <p className="start-build-hint">
                    {!ghInstalled
                      ? "gh is not installed. Install from https://cli.github.com"
                      : !ghAuthenticated
                        ? ghDetail ??
                          "Not signed in. Use browser or a personal access token."
                        : `Signed in as ${ghLogin}`}
                  </p>
                  {authBusy && !ghAuthenticated && !showTokenLogin ? (
                    <p className="start-build-hint" style={{ marginTop: 6 }}>
                      One-time code is already on your clipboard — paste it on
                      the GitHub device page.
                    </p>
                  ) : null}
                  <div className="new-project-path-row">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void refreshGhStatus()}
                      disabled={busy || authBusy}
                    >
                      Refresh status
                    </button>
                    {ghAuthenticated ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void logoutGh()}
                        disabled={busy || authBusy}
                        title="Log out of gh to switch accounts"
                      >
                        Log out
                      </button>
                    ) : ghInstalled ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void loginWeb()}
                          disabled={busy || authBusy}
                        >
                          {authBusy && !showTokenLogin
                            ? "Waiting for browser"
                            : "Sign in with browser"}
                        </button>
                        {authBusy ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => void cancelAuth()}
                          >
                            Cancel
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setShowTokenLogin((v) => !v)}
                            disabled={busy}
                          >
                            {showTokenLogin ? "Hide token" : "Use token"}
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                  {!ghAuthenticated && showTokenLogin ? (
                    <label className="start-build-field" style={{ marginTop: 10 }}>
                      <span className="start-build-label">
                        Personal access token
                      </span>
                      <div className="new-project-path-row">
                        <input
                          className="start-build-input"
                          type="password"
                          value={tokenDraft}
                          disabled={busy || authBusy}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="ghp_… or github_pat_…"
                          onChange={(e) => setTokenDraft(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void loginToken()}
                          disabled={busy || authBusy || !tokenDraft.trim()}
                        >
                          Sign in
                        </button>
                      </div>
                      <span className="start-build-hint">
                        Needs <code>repo</code> scope. Stored by{" "}
                        <code>gh</code>, not by this app.
                      </span>
                    </label>
                  ) : null}
                </div>

                {ghAuthenticated && owners.length > 0 ? (
                  <label className="start-build-field">
                    <span className="start-build-label">Owner</span>
                    <select
                      className="start-build-input"
                      value={owner}
                      disabled={busy || authBusy}
                      onChange={(e) => setOwner(e.target.value)}
                    >
                      {owners.map((o) => (
                        <option key={o.login} value={o.login}>
                          {o.login}
                          {o.type === "org" ? " (org)" : " (you)"}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label className="start-build-field">
                  <span className="start-build-label">Repository name</span>
                  <input
                    className="start-build-input"
                    value={repoName}
                    disabled={busy || authBusy}
                    spellCheck={false}
                    onChange={(e) => setRepoName(e.target.value)}
                  />
                </label>

                <label className="start-build-check">
                  <input
                    type="checkbox"
                    checked={repoPrivate}
                    disabled={busy || authBusy}
                    onChange={(e) => setRepoPrivate(e.target.checked)}
                  />
                  <span>Private repository</span>
                </label>
              </>
            ) : null}

            {error ? (
              <p className="qa-dialog-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="qa-dialog-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setError(null);
                  setStep("details");
                }}
                disabled={busy || authBusy}
              >
                Back · Backspace
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
