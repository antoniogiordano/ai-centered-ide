/**
 * Spike PTY — throwaway discovery (Phase 1.1)
 * Demonstrates: interactive shell, continuous output, resize, process-tree kill, high-volume stress.
 */
import { spawn as nodeSpawn, execSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const shell =
  platform() === "win32"
    ? process.env.COMSPEC || "powershell.exe"
    : process.env.SHELL || "/bin/zsh";

type Chunk = { stream: "stdout"; ts: number; data: string };

function createPty(cols = 80, rows = 24) {
  return pty.spawn(shell, platform() === "win32" ? [] : ["-l"], {
    name: "xterm-color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
}

/** node-pty merges streams; we tag chunks with timestamps for the audit trail. */
function attachCapture(term: pty.IPty, label: string): Chunk[] {
  const chunks: Chunk[] = [];
  term.onData((data) => {
    chunks.push({ stream: "stdout", ts: Date.now(), data });
    process.stdout.write(`[${label}] ${data}`);
  });
  return chunks;
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
    // Negative PID = process group on POSIX when started in its own session.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    // Fallback: pkill children
    try {
      execSync(`pkill -KILL -P ${pid}`, { stdio: "ignore" });
    } catch {
      /* none */
    }
  }
}

function listDescendants(pid: number): string {
  if (platform() === "win32") {
    try {
      return execSync(
        `wmic process where (ParentProcessId=${pid}) get ProcessId,Name /FORMAT:CSV`,
        { encoding: "utf8" },
      );
    } catch {
      return "(none)";
    }
  }
  try {
    return execSync(`pgrep -P ${pid} || true`, { encoding: "utf8" }).trim() || "(none)";
  } catch {
    return "(none)";
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runStream(): Promise<void> {
  console.log("=== STREAM: 60s continuous output ===");
  const term = createPty();
  const chunks = attachCapture(term, "stream");
  const start = Date.now();
  // Emit a line every 100ms for ~60s
  const cmd =
    platform() === "win32"
      ? `for ($i=0; $i -lt 600; $i++) { Write-Output \"tick $i $(Get-Date -Format o)\"; Start-Sleep -Milliseconds 100 }\r`
      : `for i in $(seq 0 599); do echo "tick $i $(date -Iseconds)"; sleep 0.1; done\n`;
  term.write(cmd);
  await sleep(62_000);
  term.kill();
  const elapsed = Date.now() - start;
  const bytes = chunks.reduce((n, c) => n + Buffer.byteLength(c.data), 0);
  console.log(`\nStream done: ${chunks.length} chunks, ${bytes} bytes in ${elapsed}ms`);
  if (chunks.length === 0) throw new Error("No output captured");
}

async function runKillTree(): Promise<void> {
  console.log("=== KILL-TREE: spawn children then terminate entire tree ===");
  const term = createPty();
  attachCapture(term, "kill");
  const pid = term.pid;
  console.log(`PTY pid=${pid}`);

  const spawnChildren =
    platform() === "win32"
      ? `Start-Process notepad -PassThru | Out-Null; ping -t 127.0.0.1\r`
      : `sleep 300 & sleep 300 & sleep 300 & echo children-started; sleep 120\n`;

  term.write(spawnChildren);
  await sleep(1500);
  const before = listDescendants(pid);
  console.log(`Descendants before kill:\n${before}`);

  killProcessTree(pid);
  try {
    term.kill();
  } catch {
    /* ok */
  }
  await sleep(500);
  const after = listDescendants(pid);
  console.log(`Descendants after kill:\n${after}`);
  if (after !== "(none)" && after.trim().length > 0) {
    console.warn("WARNING: possible orphan processes remain — inspect manually");
  } else {
    console.log("OK: no child processes remain");
  }
}

async function runStress(): Promise<void> {
  console.log("=== STRESS: ~50k lines/sec without blocking event loop ===");
  const term = createPty();
  let lines = 0;
  let bytes = 0;
  let eventLoopOk = true;
  const heartbeat = setInterval(() => {
    /* if this fires regularly, event loop is not blocked */
  }, 10);
  const loopCheck = setInterval(() => {
    const t0 = Date.now();
    setImmediate(() => {
      if (Date.now() - t0 > 50) eventLoopOk = false;
    });
  }, 100);

  term.onData((data) => {
    bytes += Buffer.byteLength(data);
    lines += data.split("\n").length - 1;
  });

  // Burst of lines via a tight shell loop writing to the PTY
  const cmd =
    platform() === "win32"
      ? `1..50000 | ForEach-Object { \"L$_\" }\r`
      : `python3 -c 'import sys; sys.stdout.write(\"\\n\".join(f\"L{i}\" for i in range(50000))+\"\\n\")'\n`;

  const t0 = Date.now();
  term.write(cmd);
  await sleep(8000);
  clearInterval(heartbeat);
  clearInterval(loopCheck);
  term.kill();
  const elapsed = (Date.now() - t0) / 1000;
  const rate = lines / elapsed;
  console.log(
    `Stress: ${lines} lines, ${bytes} bytes in ${elapsed.toFixed(2)}s → ${rate.toFixed(0)} lines/s; eventLoopOk=${eventLoopOk}`,
  );
  if (lines < 10_000) throw new Error(`Too few lines captured: ${lines}`);
}

async function runResize(): Promise<void> {
  console.log("=== RESIZE: change cols/rows mid-session ===");
  const term = createPty(40, 10);
  attachCapture(term, "resize");
  term.write(`echo COLUMNS=$COLUMNS LINES=$LINES\n`);
  await sleep(500);
  term.resize(120, 40);
  term.write(`echo AFTER COLUMNS=$COLUMNS LINES=$LINES\n`);
  await sleep(500);
  term.kill();
  console.log("Resize completed (verify COLUMNS/LINES changed in output above)");
}

async function main() {
  const mode = process.argv[2] ?? "all";
  const logPath = path.join(__dirname, "spike-output.log");
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} mode=${mode} os=${platform()} ---\n`);

  try {
    if (mode === "stream" || mode === "all") await runStream();
    if (mode === "kill-tree" || mode === "all") await runKillTree();
    if (mode === "stress" || mode === "all") await runStress();
    if (mode === "resize" || mode === "all") await runResize();
    console.log("\nSpike PTY finished OK");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    log.end();
  }
}

main();
