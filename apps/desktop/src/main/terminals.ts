import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import pty from "node-pty";
import type { LiveTerminal } from "@ai-ide/shared";

const MAX_BUFFER_CHARS = 200_000;
const PREVIEW_CHARS = 4_000;

export type TerminalChunkListener = (event: {
  terminalId: string;
  data: string;
  sequence: number;
}) => void;

export type TerminalChangeListener = () => void;

type Session = {
  id: string;
  title: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  pid: number | null;
  buffer: string;
  sequence: number;
  term: pty.IPty | null;
};

function defaultShell(): { file: string; args: string[] } {
  if (platform() === "win32") {
    return { file: process.env.ComSpec || "powershell.exe", args: [] };
  }
  return { file: process.env.SHELL || "/bin/zsh", args: ["-l"] };
}

function killProcessTree(pid: number): void {
  if (platform() === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      execSync(`pkill -KILL -P ${pid}`, { stdio: "ignore" });
    } catch {
      /* none */
    }
  }
}

/**
 * Main-process multi-PTY manager. Never expose raw PTY handles to the renderer.
 */
export class TerminalManager {
  private sessions = new Map<string, Session>();
  private chunkListeners = new Set<TerminalChunkListener>();
  private changeListeners = new Set<TerminalChangeListener>();
  private titleCounter = 0;

  onChunk(listener: TerminalChunkListener): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  onChange(listener: TerminalChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  private append(session: Session, data: string): void {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      session.buffer = session.buffer.slice(-MAX_BUFFER_CHARS);
    }
    session.sequence += 1;
    const event = {
      terminalId: session.id,
      data,
      sequence: session.sequence,
    };
    for (const listener of this.chunkListeners) listener(event);
    this.emitChange();
  }

  open(opts: { cwd: string; title?: string; cols?: number; rows?: number }): LiveTerminal {
    const id = randomUUID();
    this.titleCounter += 1;
    const title = opts.title?.trim() || `Terminal ${this.titleCounter}`;
    const cwd = opts.cwd;
    const { file, args } = defaultShell();
    const term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });

    const session: Session = {
      id,
      title,
      cwd,
      status: "running",
      exitCode: null,
      pid: term.pid,
      buffer: "",
      sequence: 0,
      term,
    };
    this.sessions.set(id, session);

    term.onData((data) => this.append(session, data));
    term.onExit(({ exitCode }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.pid = null;
      session.term = null;
      this.emitChange();
    });

    this.emitChange();
    return this.toLive(session);
  }

  list(): LiveTerminal[] {
    return [...this.sessions.values()].map((s) => this.toLive(s));
  }

  get(id: string): LiveTerminal | null {
    const session = this.sessions.get(id);
    return session ? this.toLive(session) : null;
  }

  read(id: string, maxChars = 24_000): {
    id: string;
    status: "running" | "exited";
    output: string;
    exitCode: number | null;
    byteLength: number;
  } {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown terminal: ${id}`);
    }
    const output =
      session.buffer.length > maxChars
        ? session.buffer.slice(-maxChars)
        : session.buffer;
    return {
      id,
      status: session.status,
      output,
      exitCode: session.exitCode,
      byteLength: Buffer.byteLength(session.buffer, "utf8"),
    };
  }

  /** Direct write — no soft-confirm (used after confirm / user hybrid input). */
  writeRaw(id: string, text: string): void {
    const session = this.sessions.get(id);
    if (!session?.term || session.status !== "running") {
      throw new Error(`Terminal not writable: ${id}`);
    }
    session.term.write(text);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session?.term) return;
    session.term.resize(cols, rows);
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.term && session.pid) {
      killProcessTree(session.pid);
      try {
        session.term.kill();
      } catch {
        /* ok */
      }
    }
    session.status = "exited";
    session.term = null;
    session.pid = null;
    this.sessions.delete(id);
    this.emitChange();
    return true;
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
    this.titleCounter = 0;
  }

  resolveCwd(workspaceRoot: string, cwdRel?: string): string {
    const rel = (cwdRel ?? ".").trim() || ".";
    if (rel === ".") return workspaceRoot;
    return join(workspaceRoot, rel);
  }

  private toLive(session: Session): LiveTerminal {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      pid: session.pid,
      cwd: session.cwd,
      lastOutput:
        session.buffer.length > PREVIEW_CHARS
          ? session.buffer.slice(-PREVIEW_CHARS)
          : session.buffer,
      exitCode: session.exitCode,
    };
  }
}
