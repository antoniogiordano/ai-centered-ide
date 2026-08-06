import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import {
  suiteResultFromRun,
  TEST_LOG_CHUNK_CHARS,
  type TestRunSpec,
  type TestSuiteResult,
} from "@ai-ide/shared";
import { enrichShellEnv, wrapUnixLoginCommand } from "./shell-env.js";

export type TestRunnerOptions = {
  workspaceRoot: string;
  specs: TestRunSpec[];
  /** Default true: kill siblings when one suite fails. */
  failFast?: boolean;
  chunkSize?: number;
  onSuiteStart?: (spec: TestRunSpec) => void;
  onSuiteEnd?: (result: TestSuiteResult) => void;
  signal?: AbortSignal;
};

export type TestRunnerOutcome = {
  suites: TestSuiteResult[];
  logs: Map<string, string>;
  failed: boolean;
};

type LiveChild = {
  pid: number | undefined;
  kill: () => void;
};

function killProcessTree(pid: number | undefined): void {
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

function runSuiteCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}> {
  const shell = platform() === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash";
  const command =
    platform() === "win32"
      ? input.command
      : wrapUnixLoginCommand(input.command, input.cwd);
  const args =
    platform() === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];
  const env = enrichShellEnv(input.cwd, { ...process.env });

  return new Promise((resolve) => {
    if (input.signal?.aborted) {
      resolve({
        stdout: "",
        stderr: "Aborted",
        exitCode: null,
        timedOut: false,
        cancelled: true,
      });
      return;
    }

    const child = spawn(shell, args, {
      cwd: input.cwd,
      env,
      detached: platform() !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode, timedOut, cancelled });
    };

    const kill = () => killProcessTree(child.pid);
    const live: LiveChild = { pid: child.pid, kill };

    const onAbort = () => {
      cancelled = true;
      kill();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = chunk.toString("utf8");
      if (target === "stdout") stdout += next;
      else stderr += next;
      // Soft cap — full log still bounded for memory.
      if (stdout.length > 512_000) stdout = stdout.slice(0, 512_000);
      if (stderr.length > 512_000) stderr = stderr.slice(0, 512_000);
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      stderr += String(err);
      finish(1);
    });

    // Expose kill via closure for fail-fast (pid may arrive async).
    void live;
  });
}

/**
 * Run verification suites in parallel. On first failure (failFast), abort the rest.
 */
export async function runTestSuites(
  options: TestRunnerOptions,
): Promise<TestRunnerOutcome> {
  const failFast = options.failFast !== false;
  const chunkSize = options.chunkSize ?? TEST_LOG_CHUNK_CHARS;
  const logs = new Map<string, string>();
  const suites: TestSuiteResult[] = [];
  const abort = new AbortController();
  const linkParent = () => {
    if (options.signal?.aborted) abort.abort();
  };
  options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  linkParent();

  let failed = false;
  const pending = options.specs.map(async (spec) => {
    if (abort.signal.aborted && failFast) {
      const { result, log } = suiteResultFromRun({
        spec,
        status: "cancelled",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        chunkSize,
      });
      logs.set(spec.id, log);
      options.onSuiteEnd?.(result);
      return result;
    }

    options.onSuiteStart?.(spec);
    const cwd = spec.cwd
      ? join(options.workspaceRoot, spec.cwd)
      : options.workspaceRoot;
    const started = Date.now();
    const run = await runSuiteCommand({
      command: spec.command,
      cwd,
      timeoutMs: spec.timeoutMs ?? 180_000,
      signal: abort.signal,
    });
    const durationMs = Date.now() - started;

    let status: TestSuiteResult["status"] = "passed";
    if (run.cancelled && abort.signal.aborted) status = "cancelled";
    else if (run.timedOut) status = "timed_out";
    else if ((run.exitCode ?? 1) !== 0) status = "failed";

    if (status === "failed" || status === "timed_out") {
      failed = true;
      if (failFast) abort.abort();
    }

    const { result, log } = suiteResultFromRun({
      spec,
      status,
      exitCode: run.exitCode,
      durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      timedOut: run.timedOut,
      chunkSize,
    });
    logs.set(spec.id, log);
    options.onSuiteEnd?.(result);
    return result;
  });

  const settled = await Promise.all(pending);
  suites.push(...settled);
  return { suites, logs, failed };
}
