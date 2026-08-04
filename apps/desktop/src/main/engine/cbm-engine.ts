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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.push({ phase: "error", error: message, indexed: false });
    }
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
      projects?: Array<{ name?: string; project?: string; path?: string; root?: string }>;
    };
    const projects = listed.projects ?? [];
    const match = projects.find((p) => {
      const name = p.name ?? p.project ?? "";
      const path = p.path ?? p.root ?? "";
      return (
        name === project ||
        path === root ||
        (typeof path === "string" && resolve(path) === resolve(root))
      );
    });

    if (!match) {
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
      })) as { status?: string; state?: string; ready?: boolean };
      const ready =
        status.ready === true ||
        status.status === "ready" ||
        status.status === "indexed" ||
        status.state === "ready" ||
        status.state === "indexed" ||
        true; // presence in list_projects is enough
      this.push({
        projectName: name,
        indexed: Boolean(ready),
        phase: ready ? "indexed" : "ready",
        indexMessage: ready ? "Index ready." : "Index present but not ready.",
      });
      if (ready) {
        await this.refreshArchitectureCache();
      }
    } catch {
      this.push({
        projectName: name,
        indexed: true,
        phase: "indexed",
        indexMessage: "Index ready.",
      });
      await this.refreshArchitectureCache();
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
    this.push({
      phase: "indexing",
      indexed: false,
      projectName: project,
      indexMessage: "Indexing repository…",
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
      this.push({
        indexMessage:
          typeof result === "object" && result && "status" in result
            ? `Index ${String((result as { status: unknown }).status)}`
            : "Index finished.",
      });
      await this.refreshIndexState();
      if (!this.status.indexed) {
        // Some versions return success without list_projects update immediately.
        this.push({ indexed: true, phase: "indexed", indexMessage: "Index ready." });
        await this.refreshArchitectureCache();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.push({
        phase: "error",
        indexed: false,
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
    const compact = compactResult(output);
    return {
      summary: `${name} ok`,
      output: (() => {
        try {
          return JSON.parse(compact) as unknown;
        } catch {
          return compact;
        }
      })(),
    };
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
