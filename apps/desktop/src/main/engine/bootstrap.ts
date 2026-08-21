import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rm, stat, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { app } from "electron";
import {
  CBM_VERSION,
  isPlatformSupported,
  resolveTarget,
  targetKey,
} from "./targets.js";

const execFileAsync = promisify(execFile);

export class UnsupportedPlatformError extends Error {
  constructor(key: string) {
    super(`Codebase engine is not supported on ${key}.`);
    this.name = "UnsupportedPlatformError";
  }
}

export class ChecksumMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Checksum mismatch: expected ${expected}, got ${actual}`);
    this.name = "ChecksumMismatchError";
  }
}

export type ProgressFn = (received: number, total: number | null) => void;

export function installDir(): string {
  return join(app.getPath("userData"), "engine", CBM_VERSION);
}

export function binaryPath(): string {
  const t = resolveTarget();
  if (!t) throw new UnsupportedPlatformError(targetKey());
  return join(installDir(), t.binaryName);
}

export function cacheDir(): string {
  return join(app.getPath("userData"), "engine-cache", CBM_VERSION);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function probeVersion(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 15_000 }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(String(stdout).includes("0.9.0") || String(stdout).includes("codebase-memory"));
    });
  });
}

export async function isBinaryReady(): Promise<boolean> {
  if (!isPlatformSupported()) return false;
  const bin = binaryPath();
  try {
    await stat(bin);
  } catch {
    return false;
  }
  return probeVersion(bin);
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const t = resolveTarget();
  if (!t) throw new UnsupportedPlatformError(targetKey());
  await mkdir(destDir, { recursive: true });

  if (t.archiveName.endsWith(".zip")) {
    if (process.platform === "win32") {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { timeout: 120_000 },
      );
    } else {
      await execFileAsync("unzip", ["-o", archivePath, "-d", destDir], {
        timeout: 120_000,
      });
    }
  } else {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir], {
      timeout: 120_000,
    });
  }
}

async function locateExtractedBinary(extractRoot: string): Promise<string> {
  const t = resolveTarget();
  if (!t) throw new UnsupportedPlatformError(targetKey());
  const candidate = join(extractRoot, t.binaryName);
  try {
    await stat(candidate);
    return candidate;
  } catch {
    /* walk one level */
  }
  // Some archives nest the binary; try common layout.
  const nested = join(extractRoot, "codebase-memory-mcp", t.binaryName);
  try {
    await stat(nested);
    return nested;
  } catch {
    throw new Error(`Extracted binary not found (${t.binaryName}).`);
  }
}

/**
 * Ensure the pinned binary is on disk and executable.
 * Downloads the release archive, verifies SHA-256, extracts — never runs upstream install.sh.
 */
export async function ensureBinary(onProgress?: ProgressFn): Promise<string> {
  const t = resolveTarget();
  if (!t) throw new UnsupportedPlatformError(targetKey());

  if (await isBinaryReady()) return binaryPath();

  await mkdir(installDir(), { recursive: true });
  const tmpArchive = join(tmpdir(), `cbm-${CBM_VERSION}-${Date.now()}-${t.archiveName}`);
  const extractRoot = join(tmpdir(), `cbm-extract-${CBM_VERSION}-${Date.now()}`);

  try {
    await rm(tmpArchive, { force: true });
    await rm(extractRoot, { recursive: true, force: true });
    await mkdir(extractRoot, { recursive: true });

    const res = await fetch(t.archiveUrl, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }

    const total = Number(res.headers.get("content-length")) || null;
    let received = 0;
    const src = Readable.fromWeb(res.body as WebReadableStream);
    src.on("data", (chunk: Buffer) => {
      received += chunk.length;
      onProgress?.(received, total);
    });
    await pipeline(src, createWriteStream(tmpArchive));

    const digest = await sha256File(tmpArchive);
    if (digest !== t.archiveSha256) {
      throw new ChecksumMismatchError(t.archiveSha256, digest);
    }

    await extractArchive(tmpArchive, extractRoot);
    const extracted = await locateExtractedBinary(extractRoot);
    const dest = binaryPath();
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    await copyFile(extracted, dest);
    if (process.platform !== "win32") {
      await chmod(dest, 0o755);
    }

    if (!(await probeVersion(dest))) {
      throw new Error("Binary is not executable after install.");
    }
    return dest;
  } finally {
    await rm(tmpArchive, { force: true }).catch(() => undefined);
    await rm(extractRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function engineUnsupportedMessage(): string {
  return `Indexing engine is not available on ${targetKey()}. AI code-read tools fall back to basic filesystem access.`;
}
