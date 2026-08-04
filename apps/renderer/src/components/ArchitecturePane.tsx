import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ARCHITECTURE_FILE_PATH,
  ApiStyleSchema,
  createEmptyArchitectureProfile,
  DatabaseSchema,
  E2eTestLibSchema,
  LanguageSchema,
  OrmSchema,
  PackageManagerSchema,
  RepoShapeSchema,
  RuntimeIdSchema,
  UnitTestLibSchema,
  type ArchitectureProfile,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";

function modShiftHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinList(value: string[] | undefined): string {
  return (value ?? []).join(", ");
}

const LANGS = LanguageSchema.options;
const PMS = PackageManagerSchema.options;
const SHAPES = RepoShapeSchema.options;
const RUNTIMES = RuntimeIdSchema.options;
const UNIT_LIBS = UnitTestLibSchema.options;
const E2E_LIBS = E2eTestLibSchema.options;
const APIS = ApiStyleSchema.options;
const DBS = DatabaseSchema.options;
const ORMS = OrmSchema.options;

type Props = {
  workspaceRoot: string | null | undefined;
  onClose: () => void;
};

export function ArchitecturePane(props: Props) {
  const { workspaceRoot, onClose } = props;
  const [draft, setDraft] = useState<ArchitectureProfile>(() =>
    createEmptyArchitectureProfile(),
  );
  const [intent, setIntent] = useState("");
  const [drift, setDrift] = useState<
    Array<{ path: string; derived: unknown; override: unknown }>
  >([]);
  const [fromFile, setFromFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceRoot) {
      setDraft(createEmptyArchitectureProfile());
      setIntent("");
      setDrift([]);
      setFromFile(false);
      return;
    }
    try {
      const res = await getBridge()?.workspace.architectureGet();
      if (!res) return;
      setDraft(res.profile ?? createEmptyArchitectureProfile());
      setIntent(res.intent ?? "");
      setDrift(res.drift ?? []);
      setFromFile(res.fromFile);
      setError(res.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = useCallback(async () => {
    if (!workspaceRoot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getBridge()?.workspace.architectureSave({
        profile: draft,
        intent,
        confirm: true,
      });
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "Save failed");
        setBusy(false);
        return;
      }
      if (res.profile) setDraft(res.profile);
      if (res.intent !== undefined) setIntent(res.intent);
      setDrift(res.drift ?? []);
      setFromFile(true);
      setBusy(false);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, draft, intent, workspaceRoot]);

  const detect = useCallback(async () => {
    if (!workspaceRoot || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getBridge()?.workspace.architectureDetect();
      if (res?.profile) {
        setDraft(res.profile);
        setFromFile(res.fromFile);
        setIntent(res.intent ?? intent);
        setDrift(res.drift ?? []);
      }
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, workspaceRoot]);

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    void save();
  }

  function patch(updater: (prev: ArchitectureProfile) => ArchitectureProfile) {
    setDraft((prev) => updater(prev));
  }

  if (!workspaceRoot) {
    return (
      <div className="arch-pane">
        <div className="arch-pane-header">
          <div>
            <div className="arch-pane-kicker">Settings</div>
            <h2 className="arch-pane-title">Architecture</h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Close · Esc
          </button>
        </div>
        <div className="empty-state verify-empty">
          <strong>No workspace</strong>
          <p>Open a project folder to edit `.aifi/ARCHITECTURE.md`.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="arch-pane" role="region" aria-label="Architecture settings">
      <div className="arch-pane-header">
        <div>
          <div className="arch-pane-kicker">Settings</div>
          <h2 className="arch-pane-title">Architecture</h2>
          <p className="arch-pane-path muted">
            {fromFile ? ARCHITECTURE_FILE_PATH : "Draft — not saved yet"} ·{" "}
            {modShiftHint("A")} to toggle
          </p>
        </div>
        <div className="arch-pane-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => void detect()}
          >
            Re-detect
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Close · Esc
          </button>
        </div>
      </div>

      {drift.length > 0 ? (
        <p className="start-build-hint" style={{ padding: "0 16px" }} role="status">
          Drift (override ≠ detected): {drift.map((d) => d.path).join(", ")}
        </p>
      ) : null}

      <form className="arch-pane-body" onSubmit={onFormSubmit}>
        <section className="arch-section">
          <h3 className="arch-section-title">Product intent</h3>
          <label className="arch-field">
            <span>Markdown body of ARCHITECTURE.md</span>
            <textarea
              className="input arch-input"
              rows={5}
              value={intent}
              disabled={busy}
              spellCheck
              placeholder={"# My project\n\nWhat this product does…"}
              onChange={(e) => setIntent(e.target.value)}
            />
          </label>
        </section>

        <section className="arch-section">
          <h3 className="arch-section-title">Project</h3>
          <label className="arch-field">
            <span>Name</span>
            <input
              className="input arch-input"
              value={draft.name ?? ""}
              onChange={(e) => {
                const name = e.target.value.trim();
                patch((p) => {
                  if (!name) {
                    const { name: _drop, ...rest } = p;
                    void _drop;
                    return rest as ArchitectureProfile;
                  }
                  return { ...p, name };
                });
              }}
            />
          </label>
        </section>

        <section className="arch-section">
          <h3 className="arch-section-title">Repo</h3>
          <div className="arch-grid-2">
            <label className="arch-field">
              <span>Shape</span>
              <select
                className="input arch-input"
                value={draft.repo?.shape ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    repo: {
                      ...p.repo,
                      ...(e.target.value
                        ? {
                            shape: e.target.value as NonNullable<
                              ArchitectureProfile["repo"]
                            >["shape"],
                          }
                        : { shape: undefined }),
                    },
                  }))
                }
              >
                <option value="">—</option>
                {SHAPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="arch-field">
              <span>Package manager</span>
              <select
                className="input arch-input"
                value={draft.repo?.packageManager ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    repo: {
                      ...p.repo,
                      ...(e.target.value
                        ? {
                            packageManager: e.target
                              .value as NonNullable<
                              ArchitectureProfile["repo"]
                            >["packageManager"],
                          }
                        : { packageManager: undefined }),
                    },
                  }))
                }
              >
                <option value="">—</option>
                {PMS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="arch-section">
          <h3 className="arch-section-title">Runtimes</h3>
          <label className="arch-field">
            <span>Primary runtime</span>
            <select
              className="input arch-input"
              value={draft.runtimes[0]?.id ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                patch((p) => ({
                  ...p,
                  runtimes: id
                    ? [
                        {
                          id: id as ArchitectureProfile["runtimes"][number]["id"],
                          ...(p.runtimes[0]?.version
                            ? { version: p.runtimes[0].version }
                            : {}),
                        },
                      ]
                    : [],
                }));
              }}
            >
              <option value="">—</option>
              {RUNTIMES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="arch-field">
            <span>Version</span>
            <input
              className="input arch-input"
              placeholder="e.g. &gt;=22"
              value={draft.runtimes[0]?.version ?? ""}
              onChange={(e) => {
                const version = e.target.value.trim();
                patch((p) => {
                  const id = p.runtimes[0]?.id;
                  if (!id) return p;
                  return {
                    ...p,
                    runtimes: [
                      {
                        id,
                        ...(version ? { version } : {}),
                      },
                    ],
                  };
                });
              }}
            />
          </label>
        </section>

        <LayerSection
          title="Backend"
          language={draft.backend?.language}
          frameworks={joinList(draft.backend?.frameworks)}
          roots={joinList(draft.backend?.roots)}
          bundler={draft.backend?.bundler ?? ""}
          onChange={(next) =>
            patch((p) => ({
              ...p,
              backend: {
                frameworks: splitList(next.frameworks),
                roots: splitList(next.roots),
                ...(next.language
                  ? {
                      language: next.language as NonNullable<
                        ArchitectureProfile["backend"]
                      >["language"],
                    }
                  : {}),
                ...(next.bundler.trim()
                  ? { bundler: next.bundler.trim() }
                  : {}),
              },
            }))
          }
        />

        <LayerSection
          title="Frontend"
          language={draft.frontend?.language}
          frameworks={joinList(draft.frontend?.frameworks)}
          roots={joinList(draft.frontend?.roots)}
          bundler={draft.frontend?.bundler ?? ""}
          styling={joinList(draft.frontend?.styling)}
          showStyling
          onChange={(next) =>
            patch((p) => ({
              ...p,
              frontend: {
                frameworks: splitList(next.frameworks),
                roots: splitList(next.roots),
                ...(next.language
                  ? {
                      language: next.language as NonNullable<
                        ArchitectureProfile["frontend"]
                      >["language"],
                    }
                  : {}),
                ...(next.bundler.trim()
                  ? { bundler: next.bundler.trim() }
                  : {}),
                ...(next.styling
                  ? { styling: splitList(next.styling) }
                  : {}),
              },
            }))
          }
        />

        <section className="arch-section">
          <h3 className="arch-section-title">Testing</h3>
          <div className="arch-grid-2">
            <label className="arch-field">
              <span>Unit lib</span>
              <select
                className="input arch-input"
                value={draft.testing?.unit?.lib ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    testing: {
                      ...p.testing,
                      ...(e.target.value
                        ? {
                            unit: {
                              ...p.testing?.unit,
                              lib: e.target.value,
                            },
                          }
                        : { unit: undefined }),
                    },
                  }))
                }
              >
                <option value="">—</option>
                {UNIT_LIBS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="arch-field">
              <span>Unit command</span>
              <input
                className="input arch-input"
                value={draft.testing?.unit?.command ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    testing: {
                      ...p.testing,
                      unit: {
                        lib: p.testing?.unit?.lib ?? "custom",
                        ...(e.target.value.trim()
                          ? { command: e.target.value.trim() }
                          : {}),
                      },
                    },
                  }))
                }
              />
            </label>
            <label className="arch-field">
              <span>E2E lib</span>
              <select
                className="input arch-input"
                value={draft.testing?.e2e?.lib ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    testing: {
                      ...p.testing,
                      ...(e.target.value
                        ? {
                            e2e: {
                              ...p.testing?.e2e,
                              lib: e.target.value,
                            },
                          }
                        : { e2e: undefined }),
                    },
                  }))
                }
              >
                <option value="">—</option>
                {E2E_LIBS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="arch-field">
              <span>E2E command</span>
              <input
                className="input arch-input"
                value={draft.testing?.e2e?.command ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    testing: {
                      ...p.testing,
                      e2e: {
                        lib: p.testing?.e2e?.lib ?? "custom",
                        ...(e.target.value.trim()
                          ? { command: e.target.value.trim() }
                          : {}),
                      },
                    },
                  }))
                }
              />
            </label>
            <label className="arch-field arch-field-span">
              <span>E2E roots (comma-separated)</span>
              <input
                className="input arch-input"
                value={joinList(draft.testing?.e2e?.roots)}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    testing: {
                      ...p.testing,
                      e2e: {
                        lib: p.testing?.e2e?.lib ?? "custom",
                        ...(p.testing?.e2e?.command
                          ? { command: p.testing.e2e.command }
                          : {}),
                        roots: splitList(e.target.value),
                      },
                    },
                  }))
                }
              />
            </label>
          </div>
        </section>

        <section className="arch-section">
          <h3 className="arch-section-title">Quality</h3>
          <div className="arch-grid-2">
            {(
              [
                ["lint", "Lint"],
                ["typecheck", "Typecheck"],
                ["format", "Format"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="arch-field">
                <span>{label}</span>
                <input
                  className="input arch-input"
                  value={draft.quality?.[key] ?? ""}
                  onChange={(e) =>
                    patch((p) => ({
                      ...p,
                      quality: {
                        ...p.quality,
                        ...(e.target.value.trim()
                          ? { [key]: e.target.value.trim() }
                          : { [key]: undefined }),
                      },
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </section>

        <section className="arch-section">
          <h3 className="arch-section-title">Data & API</h3>
          <div className="arch-grid-2">
            <label className="arch-field">
              <span>Database</span>
              <select
                className="input arch-input"
                value={draft.data?.database ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    data: {
                      ...p.data,
                      ...(e.target.value
                        ? {
                            database: e.target.value as NonNullable<
                              ArchitectureProfile["data"]
                            >["database"],
                          }
                        : { database: undefined }),
                    },
                  }))
                }
              >
                <option value="">—</option>
                {DBS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="arch-field">
              <span>ORM</span>
              <select
                className="input arch-input"
                value={draft.data?.orm ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    data: {
                      ...p.data,
                      ...(e.target.value
                        ? {
                            orm: e.target.value as NonNullable<
                              ArchitectureProfile["data"]
                            >["orm"],
                          }
                        : { orm: undefined }),
                    },
                  }))
                }
              >
                <option value="">—</option>
                {ORMS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="arch-field">
              <span>API style</span>
              <select
                className="input arch-input"
                value={draft.api?.style ?? ""}
                onChange={(e) =>
                  patch((p) => ({
                    ...p,
                    api: e.target.value
                      ? {
                          style: e.target.value as NonNullable<
                            ArchitectureProfile["api"]
                          >["style"],
                        }
                      : undefined,
                  }))
                }
              >
                <option value="">—</option>
                {APIS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {error ? <p className="arch-summary-error">{error}</p> : null}
        {savedFlash ? (
          <p className="arch-pane-saved">Saved to {ARCHITECTURE_FILE_PATH}</p>
        ) : null}

        <div className="arch-pane-footer">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy}
            onKeyDown={(e: ReactKeyboardEvent) => {
              if (e.key === "Enter") e.stopPropagation();
            }}
          >
            Save · Enter
          </button>
        </div>
      </form>
    </div>
  );
}

function LayerSection(props: {
  title: string;
  language?: string | undefined;
  frameworks: string;
  roots: string;
  bundler: string;
  styling?: string;
  showStyling?: boolean;
  onChange: (next: {
    language: string;
    frameworks: string;
    roots: string;
    bundler: string;
    styling?: string;
  }) => void;
}) {
  const {
    title,
    language = "",
    frameworks,
    roots,
    bundler,
    styling = "",
    showStyling,
    onChange,
  } = props;

  return (
    <section className="arch-section">
      <h3 className="arch-section-title">{title}</h3>
      <div className="arch-grid-2">
        <label className="arch-field">
          <span>Language</span>
          <select
            className="input arch-input"
            value={language}
            onChange={(e) =>
              onChange({
                language: e.target.value,
                frameworks,
                roots,
                bundler,
                styling,
              })
            }
          >
            <option value="">—</option>
            {LANGS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="arch-field">
          <span>Bundler</span>
          <input
            className="input arch-input"
            value={bundler}
            placeholder="vite, next…"
            onChange={(e) =>
              onChange({
                language,
                frameworks,
                roots,
                bundler: e.target.value,
                styling,
              })
            }
          />
        </label>
        <label className="arch-field arch-field-span">
          <span>Frameworks (comma-separated)</span>
          <input
            className="input arch-input"
            value={frameworks}
            onChange={(e) =>
              onChange({
                language,
                frameworks: e.target.value,
                roots,
                bundler,
                styling,
              })
            }
          />
        </label>
        <label className="arch-field arch-field-span">
          <span>Roots (comma-separated)</span>
          <input
            className="input arch-input"
            value={roots}
            onChange={(e) =>
              onChange({
                language,
                frameworks,
                roots: e.target.value,
                bundler,
                styling,
              })
            }
          />
        </label>
        {showStyling ? (
          <label className="arch-field arch-field-span">
            <span>Styling (comma-separated)</span>
            <input
              className="input arch-input"
              value={styling}
              onChange={(e) =>
                onChange({
                  language,
                  frameworks,
                  roots,
                  bundler,
                  styling: e.target.value,
                })
              }
            />
          </label>
        ) : null}
      </div>
    </section>
  );
}

export { modShiftHint };
