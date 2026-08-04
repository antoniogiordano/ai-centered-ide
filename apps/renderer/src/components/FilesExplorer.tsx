import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { MonacoEditor } from "./MonacoEditor";

type OpenFile = {
  path: string;
  content: string;
};

function parentPath(dir: string): string | null {
  if (!dir || dir === ".") return null;
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, -1).join("/");
}

function breadcrumbParts(dir: string): { label: string; path: string }[] {
  const root = { label: "workspace", path: "." };
  if (!dir || dir === ".") return [root];
  const parts = dir.split("/").filter(Boolean);
  const crumbs = [root];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

export function FilesExplorer(props: {
  workspaceRoot: string | null | undefined;
  /** Bump when agent writes files so the tree refreshes. */
  refreshToken?: number | string;
  focus?: boolean;
}) {
  const { workspaceRoot, refreshToken, focus = false } = props;
  const [dir, setDir] = useState(".");
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    const bridge = getBridge();
    if (!bridge?.workspace.listDir) {
      setError("File browser unavailable.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await bridge.workspace.listDir(path);
      if (res.error) {
        setError(res.error.userMessage);
        setEntries([]);
      } else {
        setEntries(res.entries);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDir(".");
    setOpenFile(null);
    setFileError(null);
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) {
      setEntries([]);
      return;
    }
    void loadDir(dir);
  }, [workspaceRoot, dir, refreshToken, loadDir]);

  useEffect(() => {
    if (!openFile && !fileError) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpenFile(null);
        setFileError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile, fileError]);

  const crumbs = useMemo(() => breadcrumbParts(dir), [dir]);

  async function openEntry(entry: WorkspaceFileEntry) {
    if (entry.isDirectory) {
      setDir(entry.path);
      return;
    }
    const bridge = getBridge();
    if (!bridge?.workspace.readFile) return;
    setFileError(null);
    try {
      const res = await bridge.workspace.readFile(entry.path);
      if (res.error || res.content === undefined) {
        setFileError(res.error?.userMessage ?? "Could not read file.");
        setOpenFile(null);
        return;
      }
      setOpenFile({ path: res.path, content: res.content });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
      setOpenFile(null);
    }
  }

  function goUp() {
    const parent = parentPath(dir);
    if (parent !== null) setDir(parent);
  }

  function closeFile() {
    setOpenFile(null);
    setFileError(null);
  }

  if (!workspaceRoot) {
    return (
      <div className="empty-state verify-empty">
        <strong>Files</strong>
        <p>Open a workspace to browse the project tree.</p>
      </div>
    );
  }

  return (
    <div
      className={`files-explorer ${openFile || fileError ? "files-explorer-split" : "files-explorer-full"} ${focus ? "verify-panel-focused" : ""}`}
    >
      <div className="files-nav">
        <div className="files-nav-toolbar">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={goUp}
            disabled={dir === "." || loading}
            title="Parent folder"
          >
            ↑
          </button>
          <nav className="files-breadcrumb" aria-label="Path">
            {crumbs.map((c, i) => (
              <span key={c.path} className="files-crumb">
                {i > 0 ? <span className="files-crumb-sep">/</span> : null}
                <button
                  type="button"
                  className="files-crumb-btn"
                  onClick={() => setDir(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        </div>

        {error ? <p className="files-error">{error}</p> : null}

        <ul className="files-list" aria-label="Directory contents">
          {loading && entries.length === 0 ? (
            <li className="files-list-empty">Loading…</li>
          ) : null}
          {!loading && entries.length === 0 && !error ? (
            <li className="files-list-empty">Empty folder</li>
          ) : null}
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={`files-entry ${entry.isDirectory ? "is-dir" : "is-file"} ${openFile?.path === entry.path ? "is-open" : ""}`}
                onClick={() => void openEntry(entry)}
              >
                <span className="files-entry-icon" aria-hidden>
                  {entry.isDirectory ? "▸" : "·"}
                </span>
                <span className="files-entry-name">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {openFile || fileError ? (
        <div className="files-preview">
          <div className="files-preview-toolbar">
            <span className="files-preview-path" title={openFile?.path}>
              {openFile?.path ?? "Preview"}
              <span className="verify-hint"> · read-only</span>
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={closeFile}
              title="Close file · Esc"
            >
              ✕
            </button>
          </div>
          {fileError ? (
            <p className="files-error">{fileError}</p>
          ) : openFile ? (
            <div className="files-preview-editor">
              <MonacoEditor
                path={openFile.path}
                value={openFile.content}
                readOnly
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
