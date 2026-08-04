import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const STDERR_RING = 400;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal MCP JSON-RPC 2.0 client over stdio.
 * stdout is protocol-only; stderr is buffered for diagnostics.
 */
export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private stderrLines: string[] = [];
  private toolsCache: McpToolInfo[] = [];
  private started = false;

  constructor(
    private readonly options: {
      command: string;
      args?: string[];
      env: NodeJS.ProcessEnv;
      cwd?: string;
    },
  ) {}

  get stderrTail(): string {
    return this.stderrLines.join("\n");
  }

  get listedTools(): McpToolInfo[] {
    return this.toolsCache;
  }

  isRunning(): boolean {
    return Boolean(this.proc && !this.proc.killed && this.started);
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;

    this.proc = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc.on("error", (err) => {
      this.failAll(err);
    });
    this.proc.on("exit", (code, signal) => {
      this.started = false;
      this.failAll(
        new Error(`MCP process exited (code=${code}, signal=${signal})`),
      );
      this.proc = null;
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onStdoutLine(line));

    createInterface({ input: this.proc.stderr }).on("line", (line) => {
      this.stderrLines.push(line);
      if (this.stderrLines.length > STDERR_RING) {
        this.stderrLines.splice(0, this.stderrLines.length - STDERR_RING);
      }
    });

    const init = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ai-first-ide", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } };

    this.notify("notifications/initialized", {});
    this.started = true;

    try {
      const listed = (await this.request("tools/list", {})) as {
        tools?: McpToolInfo[];
      };
      this.toolsCache = listed.tools ?? [];
    } catch {
      this.toolsCache = [];
    }

    void init;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.isRunning()) {
      throw new Error("MCP client is not running.");
    }
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    )) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    };

    if (result?.structuredContent !== undefined) {
      return result.structuredContent;
    }
    const texts = (result?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    const joined = texts.join("\n");
    if (!joined) return result;
    try {
      return JSON.parse(joined) as unknown;
    } catch {
      return joined;
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.started = false;
    this.failAll(new Error("MCP client stopped."));
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ok */
        }
        resolve();
      }, 3_000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.proc = null;
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: number | string;
      result?: unknown;
      error?: { message?: string; code?: number };
      method?: string;
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(
        new Error(msg.error.message ?? `MCP error ${msg.error.code ?? ""}`),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    const proc = this.proc;
    if (!proc?.stdin.writable) {
      return Promise.reject(new Error("MCP stdin is not writable."));
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      proc.stdin.write(`${payload}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const proc = this.proc;
    if (!proc?.stdin.writable) return;
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
