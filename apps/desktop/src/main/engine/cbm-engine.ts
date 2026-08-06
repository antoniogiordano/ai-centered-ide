import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  binaryPath,
  cacheDir,
  ensureBinary,
  engineUnsupportedMessage,
  isBinaryReady,
} from "./bootstrap.js";
import { isPlatformSupported } from "./targets.js";
import { McpStdioClient } from "./mcp-client.js";
import { CBM_VERSION } from "./targets.js";

export type EnginePhase =
  | "unsupported"
  | "missing"
  | "downloading"
  | "ready"
  | "starting"
  | "indexing"
  | "indexed"
  | "error";

export type EngineStatus = {
  version: string;
  platformSupported: boolean;
  phase: EnginePhase;
  binaryReady: boolean;
  indexed: boolean;
  projectName: string | null;
  workspaceRoot: string | null;
  downloadReceived: number;
  downloadTotal: number | null;
  indexMessage: string | null;
  error: string | null;
  /** Compact architecture summary for prompt pre-seed (cached). */
  architectureSummary: string | null;
};

export type EngineListener = (status: EngineStatus) => void;

const MODEL_TOOLS = new Set([
  "search_graph",
  "trace_path",
  "get_code_snippet",
  "get_architecture",
  "search_code",
  "get_graph_schema",
  "detect_changes",
]);

const FS_FALLBACK_TOOLS = new Set(["list_dir", "read_file", "search_text"]);

/**
 * Stub / failed indexes only keep Project + Branch (~2 nodes).
 * A useful TS/JS app index is typically dozens–thousands of nodes.
 */
const MIN_USEFUL_INDEX_NODES = 8;

/** Skip back-to-back auto reindexes for the same workspace (ms). */
const AUTO_INDEX_DEBOUNCE_MS = 20_000;

function projectNameFromRoot(root: string): string {
  return basename(root).replace(/[^\w.-]+/g, "_") || "project";
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sanitizeArgs(
  root: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of ["repo_path", "path", "file", "file_path", "cwd"]) {
    const value = out[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = normalize(value);
    if (!isPathInsideRoot(root, normalized)) {
      throw new Error(`Path escapes workspace: ${value}`);
    }
    // Prefer absolute under allowed root for index_repository.
    if (key === "repo_path") {
      out[key] = resolve(root, normalized === "." ? "" : normalized);
    }
  }
  return out;
}

function compactResult(value: unknown, maxChars = 12_000): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 0);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

export class CbmEngine {
  private status: EngineStatus = {
    version: CBM_VERSION,
    platformSupported: isPlatformSupported(),
    phase: isPlatformSupported() ? "missing" : "unsupported",
    binaryReady: false,
    indexed: false,
    projectName: null,
    workspaceRoot: null,
    downloadReceived: 0,
    downloadTotal: null,
    indexMessage: null,
    error: null,
    architectureSummary: null,
  };
  private listeners = new Set<EngineListener>();
  private client: McpStdioClient | null = null;
  private ensurePromise: Promise<void> | null = null;
  private indexAbort: AbortController | null = null;
  private restartAttempts = 0;
  /** Last known graph node count from index_status / list_projects. */
  private lastNodeCount = 0;
  private lastAutoIndexAt = 0;
  private lastAutoIndexRoot: string | null = null;
  private autoIndexPromise: Promise<void> | null = null;

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  getStatus(): EngineStatus {
    return { ...this.status };
  }

  isIndexed(): boolean {
    return this.status.indexed && this.client?.isRunning() === true;
  }

  shouldExposeFsTools(): boolean {
    return !this.isIndexed();
  }

  modelToolNames(): string[] {
    return [...MODEL_TOOLS];
  }

  isFsFallbackTool(name: string): boolean {
    return FS_FALLBACK_TOOLS.has(name);
  }

  isModelCbmTool(name: string): boolean {
    return MODEL_TOOLS.has(name);
  }

  private push(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.getStatus());
  }

  async refreshBinaryFlag(): Promise<void> {
    if (!this.status.platformSupported) {
      this.push({
        phase: "unsupported",
        binaryReady: false,
        error: engineUnsupportedMessage(),
      });
      return;
    }
    const ready = await isBinaryReady();
    this.push({
      binaryReady: ready,
      phase: ready
        ? this.status.indexed
          ? "indexed"
          : this.client?.isRunning()
            ? "ready"
            : "ready"
        : "missing",
      error: ready ? null : this.status.error,
    });
  }

  async ensureInstalled(): Promise<void> {
    if (!this.status.platformSupported) {
      this.push({
        phase: "unsupported",
        error: engineUnsupportedMessage(),
      });
      throw new Error(engineUnsupportedMessage());
    }
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = (async () => {
      try {
        if (await isBinaryReady()) {
          this.push({ binaryReady: true, phase: "ready", error: null });
          return;
        }
        this.push({
          phase: "downloading",
          downloadReceived: 0,
          downloadTotal: null,
          error: null,
        });
        await ensureBinary((received, total) => {
          this.push({
            phase: "downloading",
            downloadReceived: received,
            downloadTotal: total,
          });
        });
        this.push({
          binaryReady: true,
          phase: "ready",
          downloadReceived: 0,
          downloadTotal: null,
          error: null,
        });
        if (this.status.workspaceRoot && !this.client?.isRunning()) {
          await this.startClient(this.status.workspaceRoot);
          await this.refreshIndexState();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.push({
          phase: "error",
          binaryReady: false,
          error: message,
        });
        throw error;
      } finally {
        this.ensurePromise = null;
      }
    })();
    return this.ensurePromise;
  }

  async attachWorkspace(workspaceRoot: string): Promise<void> {
    await this.detachWorkspace();
    this.push({
      workspaceRoot,
      projectName: projectNameFromRoot(workspaceRoot),
      indexed: false,
      architectureSummary: null,
      indexMessage: null,
      error: null,
    });

    if (!this.status.platformSupported) {
      this.push({ phase: "unsupported", error: engineUnsupportedMessage() });
      return;
    }

    try {
      await this.ensureInstalled();
      await this.startClient(workspaceRoot);
      await this.refreshIndexState();
      // Always refresh the graph on workspace open (fire-and-forget).
      void this.ensureFreshIndex("attach");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.push({ phase: "error", error: message, indexed: false });
    }
  }

  /**
   * Ensure the codebase graph is present and up to date.
   * Triggered on workspace attach / app boot and on new chat.
   */
  async ensureFreshIndex(
    reason: "attach" | "chat" | "boot",
    opts?: { mode?: string },
  ): Promise<void> {
    if (!this.status.workspaceRoot || !this.status.platformSupported) return;
    if (this.status.phase === "indexing" || this.status.phase === "downloading") {
      return;
    }
    if (this.autoIndexPromise) return this.autoIndexPromise;

    this.autoIndexPromise = (async () => {
      try {
        await this.ensureInstalled();
        if (!this.client?.isRunning()) {
          await this.startClient(this.status.workspaceRoot!);
        }
        await this.refreshIndexState();

        const root = this.status.workspaceRoot!;
        const stub = this.lastNodeCount > 0 && this.lastNodeCount < MIN_USEFUL_INDEX_NODES;
        const missing = !this.status.indexed || this.lastNodeCount === 0;
        const recentlyIndexed =
          this.lastAutoIndexRoot === root &&
          Date.now() - this.lastAutoIndexAt < AUTO_INDEX_DEBOUNCE_MS &&
          this.status.indexed &&
          !stub;

        if (recentlyIndexed && !missing && !stub) {
          return;
        }

        // attach/boot/chat: reindex. Stub/missing always reindex.
        if (missing || stub || reason === "attach" || reason === "boot" || reason === "chat") {
          this.push({
            indexMessage: stub
              ? `Index incomplete (${this.lastNodeCount} nodes) — reindexing…`
              : reason === "chat"
                ? "Refreshing index for new chat…"
                : "Indexing repository…",
          });
          await this.startIndexing({ mode: opts?.mode ?? "fast" });
          this.lastAutoIndexAt = Date.now();
          this.lastAutoIndexRoot = root;
        }
      } catch {
        /* status/error already pushed by startIndexing / ensureInstalled */
      } finally {
        this.autoIndexPromise = null;
      }
    })();

    return this.autoIndexPromise;
  }

  async detachWorkspace(): Promise<void> {
    this.indexAbort?.abort();
    this.indexAbort = null;
    if (this.client) {
      await this.client.stop().catch(() => undefined);
      this.client = null;
    }
    this.restartAttempts = 0;
    this.push({
      workspaceRoot: null,
      projectName: null,
      indexed: false,
      architectureSummary: null,
      indexMessage: null,
      phase: this.status.binaryReady ? "ready" : this.status.phase,
    });
  }

  private async startClient(workspaceRoot: string): Promise<void> {
    this.push({ phase: "starting", error: null });
    const bin = binaryPath();
    const client = new McpStdioClient({
      command: bin,
      env: {
        ...process.env,
        CBM_ALLOWED_ROOT: workspaceRoot,
        CBM_CACHE_DIR: cacheDir(),
        CBM_LOG_LEVEL: "warn",
      },
      cwd: workspaceRoot,
    });
    await client.start();
    this.client = client;
    this.restartAttempts = 0;
    this.push({ phase: "ready", binaryReady: true });
  }

  private async ensureClient(): Promise<McpStdioClient> {
    const root = this.status.workspaceRoot;
    if (!root) throw new Error("No workspace attached to codebase engine.");
    if (this.client?.isRunning()) return this.client;
    if (this.restartAttempts >= 3) {
      throw new Error(
        `Codebase engine failed repeatedly. stderr:\n${this.client?.stderrTail ?? "(none)"}`,
      );
    }
    this.restartAttempts += 1;
    await this.startClient(root);
    if (!this.client) throw new Error("Failed to start codebase engine.");
    return this.client;
  }

  async refreshIndexState(): Promise<void> {
    const root = this.status.workspaceRoot;
    const project = this.status.projectName;
    if (!root || !project) return;
    const client = await this.ensureClient();
    const listed = (await client.callTool("list_projects", {})) as {
      projects?: Array<{
        name?: string;
        project?: string;
        path?: string;
        root?: string;
        root_path?: string;
        nodes?: number;
      }>;
    };
    const projects = listed.projects ?? [];
    const match = projects.find((p) => {
      const name = p.name ?? p.project ?? "";
      const path = p.path ?? p.root ?? p.root_path ?? "";
      return (
        name === project ||
        path === root ||
        (typeof path === "string" && resolve(path) === resolve(root))
      );
    });

    if (!match) {
      this.lastNodeCount = 0;
      this.push({
        indexed: false,
        phase: "ready",
        indexMessage: "Project is not indexed yet.",
      });
      return;
    }

    const name = String(match.name ?? match.project ?? project);
    try {
      const status = (await client.callTool("index_status", {
        project: name,
      })) as {
        status?: string;
        state?: string;
        ready?: boolean;
        nodes?: number;
      };
      const nodes = Number(status.nodes ?? match.nodes ?? 0);
      this.lastNodeCount = Number.isFinite(nodes) ? nodes : 0;
      const statusReady =
        status.ready === true ||
        status.status === "ready" ||
        status.status === "indexed" ||
        status.state === "ready" ||
        status.state === "indexed";
      // Never treat Project+Branch stubs as a usable index.
      const useful = this.lastNodeCount >= MIN_USEFUL_INDEX_NODES;
      const ready = statusReady && useful;
      this.push({
        projectName: name,
        indexed: ready,
        phase: ready ? "indexed" : "ready",
        indexMessage: ready
          ? `Index ready (${this.lastNodeCount} nodes).`
          : this.lastNodeCount > 0
            ? `Index incomplete (${this.lastNodeCount} nodes) — reindex needed.`
            : "Index present but not ready.",
      });
      if (ready) {
        await this.refreshArchitectureCache();
      }
    } catch {
      const nodes = Number(match.nodes ?? 0);
      this.lastNodeCount = Number.isFinite(nodes) ? nodes : 0;
      const useful = this.lastNodeCount >= MIN_USEFUL_INDEX_NODES;
      this.push({
        projectName: name,
        indexed: useful,
        phase: useful ? "indexed" : "ready",
        indexMessage: useful
          ? `Index ready (${this.lastNodeCount} nodes).`
          : `Index incomplete (${this.lastNodeCount} nodes) — reindex needed.`,
      });
      if (useful) {
        await this.refreshArchitectureCache();
      }
    }
  }

  async startIndexing(opts?: { mode?: string }): Promise<void> {
    const root = this.status.workspaceRoot;
    if (!root) throw new Error("Open a workspace first.");
    await this.ensureInstalled();
    const client = await this.ensureClient();
    this.indexAbort?.abort();
    this.indexAbort = new AbortController();
    const project = projectNameFromRoot(root);
    // Keep serving a previous good index while a refresh runs.
    const keepServing =
      this.status.indexed && this.lastNodeCount >= MIN_USEFUL_INDEX_NODES;
    this.push({
      phase: "indexing",
      indexed: keepServing,
      projectName: project,
      indexMessage: keepServing
        ? "Refreshing index…"
        : "Indexing repository…",
      error: null,
    });

    try {
      const result = await client.callTool(
        "index_repository",
        {
          repo_path: root,
          name: project,
          mode: opts?.mode ?? "fast",
        },
        600_000,
      );
      const resultNodes =
        typeof result === "object" &&
        result &&
        "nodes" in result &&
        typeof (result as { nodes: unknown }).nodes === "number"
          ? (result as { nodes: number }).nodes
          : null;
      if (resultNodes !== null) {
        this.lastNodeCount = resultNodes;
      }
      this.push({
        indexMessage:
          typeof result === "object" && result && "status" in result
            ? `Index ${String((result as { status: unknown }).status)}${
                resultNodes !== null ? ` (${resultNodes} nodes)` : ""
              }`
            : "Index finished.",
      });
      await this.refreshIndexState();
      if (!this.status.indexed && resultNodes !== null && resultNodes >= MIN_USEFUL_INDEX_NODES) {
        this.push({
          indexed: true,
          phase: "indexed",
          indexMessage: `Index ready (${resultNodes} nodes).`,
        });
        await this.refreshArchitectureCache();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.push({
        phase: "error",
        indexed: keepServing,
        error: message,
        indexMessage: "Indexing failed.",
      });
      throw error;
    } finally {
      this.indexAbort = null;
    }
  }

  cancelIndexing(): void {
    this.indexAbort?.abort();
    this.indexAbort = null;
    // Best-effort: stop and restart client to abort in-flight tool.
    void (async () => {
      const root = this.status.workspaceRoot;
      if (this.client) await this.client.stop().catch(() => undefined);
      this.client = null;
      if (root) {
        try {
          await this.startClient(root);
          this.push({
            phase: "ready",
            indexed: false,
            indexMessage: "Indexing cancelled.",
          });
        } catch (error) {
          this.push({
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  }

  async callModelTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ summary: string; output: unknown }> {
    if (!MODEL_TOOLS.has(name)) {
      throw new Error(`Tool not exposed to the model: ${name}`);
    }
    const root = this.status.workspaceRoot;
    if (!root) throw new Error("No workspace.");
    if (!this.isIndexed()) {
      throw new Error("Codebase index is not ready. Index the project first.");
    }
    const client = await this.ensureClient();
    const project = this.status.projectName ?? projectNameFromRoot(root);
    const merged = sanitizeArgs(root, {
      project,
      ...args,
    });
    const output = await client.callTool(name, merged, 30_000);
    // Keep full engine payload for the IDE tool log; the agent loop compacts
    // via formatToolResultForModel before sending to the provider.
    try {
      const raw =
        typeof output === "string" ? output : JSON.stringify(output, null, 2);
      if (raw.length > 512_000) {
        return {
          summary: `${name} ok (output capped for storage)`,
          output: `${raw.slice(0, 512_000)}\n… [capped for storage; ${raw.length - 512_000} chars omitted]`,
        };
      }
      return { summary: `${name} ok`, output };
    } catch {
      return { summary: `${name} ok`, output };
    }
  }

  async architecturePreseed(): Promise<string | null> {
    if (!this.isIndexed()) return null;
    if (this.status.architectureSummary) return this.status.architectureSummary;
    await this.refreshArchitectureCache();
    return this.status.architectureSummary;
  }

  private async refreshArchitectureCache(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const root = this.status.workspaceRoot;
      if (!root) return;
      const project = this.status.projectName ?? projectNameFromRoot(root);
      const arch = await client.callTool("get_architecture", { project }, 30_000);
      const compact = compactResult(arch, 4_000);
      this.push({ architectureSummary: compact });
    } catch {
      /* ignore cache failures */
    }
  }

  getStderrTail(): string {
    return this.client?.stderrTail ?? "";
  }
}
