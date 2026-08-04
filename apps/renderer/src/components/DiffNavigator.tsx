import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceDiffFileEntry } from "@ai-ide/shared";
import { getBridge } from "../bridge";

type DiffLine = {
  type: "ctx" | "add" | "del" | "hunk" | "meta";
  text: string;
  oldNo?: number;
  newNo?: number;
};

type TreeNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  status?: WorkspaceDiffFileEntry["status"];
  children?: TreeNode[];
};

function statusLabel(status: WorkspaceDiffFileEntry["status"]): string {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "?":
      return "untracked";
    default:
      return "modified";
  }
}

function buildTree(files: WorkspaceDiffFileEntry[]): TreeNode[] {
  type Mutable = {
    name: string;
    path: string;
    kind: "dir" | "file";
    status?: WorkspaceDiffFileEntry["status"];
    children: Map<string, Mutable>;
  };

  const root: Mutable = {
    name: "",
    path: "",
    kind: "dir",
    children: new Map(),
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: acc,
          kind: isFile ? "file" : "dir",
          children: new Map(),
          ...(isFile ? { status: file.status } : {}),
        };
        node.children.set(part, child);
      } else if (isFile) {
        child.kind = "file";
        child.status = file.status;
      }
      node = child;
    }
  }

  function toNodes(map: Map<string, Mutable>): TreeNode[] {
    return [...map.values()]
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => ({
        name: n.name,
        path: n.path,
        kind: n.kind,
        ...(n.status ? { status: n.status } : {}),
        ...(n.kind === "dir"
          ? { children: toNodes(n.children) }
          : {}),
      }));
  }

  return toNodes(root.children);
}

/** Parse a unified diff patch into display lines (GitHub-style). */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  if (!patch.trim()) return [];
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split("\n")) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename from") ||
      raw.startsWith("rename to")
    ) {
      out.push({ type: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      out.push({ type: "meta", text: raw });
      continue;
    }
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s@@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ type: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ type: "add", text: raw.slice(1), newNo });
      newNo += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ type: "del", text: raw.slice(1), oldNo });
      oldNo += 1;
      continue;
    }
    if (raw.startsWith("\\")) {
      out.push({ type: "meta", text: raw });
      continue;
    }
    // context (leading space or empty)
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    out.push({ type: "ctx", text, oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }
  return out;
}

function TreeRows(props: {
  nodes: TreeNode[];
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const { nodes, depth, selected, expanded, onToggle, onOpen } = props;
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === "dir") {
          const open = expanded.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                className="diff-nav-row is-dir"
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => onToggle(node.path)}
              >
                <span className="diff-nav-chevron" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
                <span className="diff-nav-name">{node.name}</span>
              </button>
              {open && node.children?.length ? (
                <ul className="diff-nav-list">
                  <TreeRows
                    nodes={node.children}
                    depth={depth + 1}
                    selected={selected}
                    expanded={expanded}
                    onToggle={onToggle}
                    onOpen={onOpen}
                  />
                </ul>
              ) : null}
            </li>
          );
        }
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`diff-nav-row is-file ${selected === node.path ? "is-selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onOpen(node.path)}
            >
              <span
                className={`diff-nav-badge status-${
                  node.status === "?" ? "U" : (node.status ?? "M")
                }`}
                title={statusLabel(node.status ?? "M")}
              >
                {node.status === "?" ? "U" : (node.status ?? "M")}
              </span>
              <span className="diff-nav-name">{node.name}</span>
            </button>
          </li>
        );
      })}
    </>
  );
}

export function DiffNavigator(props: {
  workspaceRoot: string | null | undefined;
  refreshToken?: number | string;
}) {
  const { workspaceRoot, refreshToken } = props;
  const [files, setFiles] = useState<WorkspaceDiffFileEntry[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string>("");
  const [patchError, setPatchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const tree = useMemo(() => buildTree(files), [files]);
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch]);

  const refresh = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.workspace.diffFiles || !workspaceRoot) {
      setFiles([]);
      setBase(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await bridge.workspace.diffFiles();
      if (res.error) {
        setError(res.error.userMessage);
        setFiles([]);
      } else {
        setFiles(res.files);
        setBase(res.base);
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const f of res.files) {
            const parts = f.path.split("/");
            let acc = "";
            for (let i = 0; i < parts.length - 1; i++) {
              acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
              next.add(acc);
            }
          }
          return next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    setSelected(null);
    setPatch("");
    setPatchError(null);
  }, [workspaceRoot]);

  async function openFile(path: string) {
    setSelected(path);
    setPatchError(null);
    const bridge = getBridge();
    if (!bridge?.workspace.diffFile) return;
    try {
      const res = await bridge.workspace.diffFile(path);
      if (res.error) {
        setPatchError(res.error.userMessage);
        setPatch("");
        return;
      }
      setPatch(res.patch);
      if (!res.patch.trim()) {
        setPatchError("No textual diff for this file (binary or empty).");
      }
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : String(err));
      setPatch("");
    }
  }

  function closePreview() {
    setSelected(null);
    setPatch("");
    setPatchError(null);
  }

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePreview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!workspaceRoot) {
    return (
      <div className="empty-state verify-empty">
        <strong>Branch diff</strong>
        <p>Open a workspace to browse git changes on this branch.</p>
      </div>
    );
  }

  return (
    <div
      className={`diff-navigator ${selected ? "diff-navigator-split" : "diff-navigator-full"}`}
    >
      <div className="diff-nav">
        <div className="diff-nav-toolbar">
          <div className="build-cockpit-section-label">Diff</div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
        <p className="diff-nav-hint">
          {loading
            ? "Loading…"
            : `${files.length} file${files.length === 1 ? "" : "s"}`}
          {base ? ` · vs ${base.slice(0, 8)}` : " · vs HEAD"}
        </p>
        {error ? <p className="files-error">{error}</p> : null}
        {files.length === 0 && !loading && !error ? (
          <p className="diff-nav-empty">No changes on this branch yet.</p>
        ) : (
          <ul className="diff-nav-list" aria-label="Changed files">
            <TreeRows
              nodes={tree}
              depth={0}
              selected={selected}
              expanded={expanded}
              onToggle={toggleDir}
              onOpen={(p) => void openFile(p)}
            />
          </ul>
        )}
      </div>

      {selected ? (
        <div className="diff-preview">
          <div className="diff-preview-toolbar">
            <span className="diff-preview-path" title={selected}>
              {selected}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={closePreview}
              title="Close · Esc"
            >
              ✕
            </button>
          </div>
          {patchError && !lines.length ? (
            <p className="files-error">{patchError}</p>
          ) : (
            <div className="diff-hunks" role="table" aria-label="File diff">
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`diff-line diff-line-${line.type}`}
                >
                  <span className="diff-gutter diff-gutter-old">
                    {line.oldNo ?? ""}
                  </span>
                  <span className="diff-gutter diff-gutter-new">
                    {line.newNo ?? ""}
                  </span>
                  <span className="diff-sign" aria-hidden>
                    {line.type === "add"
                      ? "+"
                      : line.type === "del"
                        ? "−"
                        : line.type === "hunk"
                          ? "@"
                          : " "}
                  </span>
                  <code className="diff-code">{line.text || " "}</code>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
