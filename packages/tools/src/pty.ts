import { spawn } from "node:child_process";
import { platform } from "node:os";
import { enrichShellEnv, wrapUnixLoginCommand } from "./shell-env.js";

export type PtyRunOptions = {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type PtyRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  pid: number | undefined;
  truncated?: boolean;
};

/** Hard cap while collecting so a runaway `ls -R` cannot OOM the process. */
const COLLECT_CAP_CHARS = 512_000;

/**
 * One-shot command runner with process-tree kill on timeout.
 * Product PTY interactive sessions can wrap node-pty; this covers tool gateway needs.
 */
export async function runCommand(options: PtyRunOptions): Promise<PtyRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const shell = platform() === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash";
  const command =
    platform() === "win32"
      ? options.command
      : wrapUnixLoginCommand(options.command, options.cwd);
  const args =
    platform() === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];
  const env = enrichShellEnv(options.cwd, {
    ...process.env,
    ...options.env,
  });

  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let collectTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const next = chunk.toString("utf8");
      if (target === "stdout") {
        if (stdout.length >= COLLECT_CAP_CHARS) {
          collectTruncated = true;
          return;
        }
        stdout += next;
        if (stdout.length > COLLECT_CAP_CHARS) {
          stdout = stdout.slice(0, COLLECT_CAP_CHARS);
          collectTruncated = true;
        }
      } else {
        if (stderr.length >= COLLECT_CAP_CHARS) {
          collectTruncated = true;
          return;
        }
        stderr += next;
        if (stderr.length > COLLECT_CAP_CHARS) {
          stderr = stderr.slice(0, COLLECT_CAP_CHARS);
          collectTruncated = true;
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    child.on("close", (code) => {
      clearTimeout(timer);
      // Keep full collected streams for the IDE log. Model context is compacted
      // later via formatToolResultForModel (sanitize + size cap).
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        pid: child.pid,
        truncated: collectTruncated,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + String(err),
        exitCode: 1,
        timedOut,
        pid: child.pid,
        truncated: collectTruncated,
      });
    });
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (platform() === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already exited */
  }
}
