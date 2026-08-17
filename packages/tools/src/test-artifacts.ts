import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Where e2e runners drop failure screenshots. Cypress and Playwright both write
 * them next to the project root by default, and neither surfaces them in stdout
 * — so a failed run leaves the single most diagnostic artifact on disk with
 * nobody looking at it.
 */
export const E2E_SCREENSHOT_DIRS = [
  "cypress/screenshots",
  "test-results",
  "playwright-report",
  "e2e/screenshots",
  "tests/screenshots",
];

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Keep the prompt affordable: screenshots cost ~1k tokens each. */
export const DEFAULT_MAX_SCREENSHOTS = 3;
export const DEFAULT_MAX_SCREENSHOT_BYTES = 1_500_000;
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ENTRIES = 2_000;

export type E2eScreenshot = {
  /** Workspace-relative path, so the agent can re-read it with read_image. */
  path: string;
  mime: string;
  dataBase64: string;
  modifiedAtMs: number;
};

function extensionMime(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_EXTENSIONS[name.slice(dot).toLowerCase()] ?? null;
}

function collectFiles(
  root: string,
  dir: string,
  depth: number,
  budget: { entries: number },
  out: Array<{ abs: string; rel: string; mime: string; modifiedAtMs: number }>,
): void {
  if (depth > MAX_SCAN_DEPTH || budget.entries >= MAX_SCAN_ENTRIES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (budget.entries >= MAX_SCAN_ENTRIES) return;
    budget.entries += 1;
    const abs = join(dir, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectFiles(root, abs, depth + 1, budget, out);
      continue;
    }
    const mime = extensionMime(name);
    if (!mime) continue;
    out.push({
      abs,
      rel: relative(root, abs).split(sep).join("/"),
      mime,
      modifiedAtMs: stat.mtimeMs,
    });
  }
}

/**
 * Find screenshots an e2e run just produced, newest first.
 *
 * `sinceMs` matters: e2e directories are rarely cleaned, so without it a green
 * run would hand the model stale failures from a previous session.
 */
export function discoverE2eScreenshots(options: {
  workspaceRoot: string;
  sinceMs: number;
  maxImages?: number;
  maxBytesEach?: number;
  dirs?: string[];
}): E2eScreenshot[] {
  const root = resolve(options.workspaceRoot);
  const maxImages = options.maxImages ?? DEFAULT_MAX_SCREENSHOTS;
  const maxBytes = options.maxBytesEach ?? DEFAULT_MAX_SCREENSHOT_BYTES;
  const dirs = options.dirs ?? E2E_SCREENSHOT_DIRS;

  const found: Array<{
    abs: string;
    rel: string;
    mime: string;
    modifiedAtMs: number;
  }> = [];
  const budget = { entries: 0 };
  for (const dir of dirs) {
    const abs = resolve(root, dir);
    if (!abs.startsWith(root)) continue;
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    collectFiles(root, abs, 0, budget, found);
  }

  const fresh = found
    .filter((f) => f.modifiedAtMs >= options.sinceMs)
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(0, maxImages);

  const out: E2eScreenshot[] = [];
  for (const file of fresh) {
    let bytes: Buffer;
    try {
      if (statSync(file.abs).size > maxBytes) continue;
      bytes = readFileSync(file.abs);
    } catch {
      continue;
    }
    out.push({
      path: file.rel,
      mime: file.mime,
      dataBase64: bytes.toString("base64"),
      modifiedAtMs: file.modifiedAtMs,
    });
  }
  return out;
}
