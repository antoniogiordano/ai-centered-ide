/**
 * Locating Electron from a workspace package is not a one-liner: `electron` is a
 * dependency of apps/desktop only, and pnpm hides it from the other packages.
 * Shared by ensure-electron, the native rebuild and the Electron test runner.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Directory of the installed `electron` package, or null when absent. */
export function resolveElectronPackageDir() {
  for (const base of [join(repoRoot, "apps/desktop"), repoRoot]) {
    try {
      const require = createRequire(join(base, "package.json"));
      return dirname(require.resolve("electron/package.json"));
    } catch {
      /* try next */
    }
  }
  const pnpm = join(repoRoot, "node_modules/.pnpm");
  if (existsSync(pnpm)) {
    const hit = readdirSync(pnpm).find((n) => n.startsWith("electron@"));
    if (hit) return join(pnpm, hit, "node_modules/electron");
  }
  return null;
}

export function readElectronVersion(fallback = "36.9.5") {
  const pkgDir = resolveElectronPackageDir();
  if (!pkgDir) return fallback;
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
      .version;
  } catch {
    return fallback;
  }
}

/**
 * Path to the Electron executable, or null when the binary was never
 * downloaded (path.txt is written by the package's install.js).
 */
export function resolveElectronBinary() {
  const pkgDir = resolveElectronPackageDir();
  if (!pkgDir) return null;
  const pathFile = join(pkgDir, "path.txt");
  if (!existsSync(pathFile)) return null;
  const rel = readFileSync(pathFile, "utf8").trim();
  if (!rel) return null;
  const bin = process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? join(process.env.ELECTRON_OVERRIDE_DIST_PATH, rel)
    : join(pkgDir, "dist", rel);
  return existsSync(bin) ? bin : null;
}
