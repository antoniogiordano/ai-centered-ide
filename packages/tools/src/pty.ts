import { spawn } from "node:child_process";
import { platform } from "node:os";

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
};

/**
 * One-shot command runner with process-tree kill on timeout.
 * Product PTY interactive sessions can wrap node-pty; this covers tool gateway needs.
 */
export async function runCommand(options: PtyRunOptions): Promise<PtyRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const shell = platform() === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash";
  const args =
    platform() === "win32"
      ? ["/d", "/s", "/c", options.command]
      : ["-lc", options.command];

  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        pid: child.pid,
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
