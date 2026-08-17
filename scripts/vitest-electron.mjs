#!/usr/bin/env node
/**
 * Runs vitest inside Electron's own Node (ELECTRON_RUN_AS_NODE=1), for the
 * packages that load native addons (better-sqlite3, keytar, node-pty).
 *
 * Those addons are compiled against the Electron ABI (MODULE 135 for Electron
 * 36) because that is what the app needs at runtime; system Node 22 is MODULE
 * 127 and refuses to load them. Rebuilding them for Node before tests — the
 * previous approach — left the desktop app broken until the next rebuild, so
 * the tests come to the ABI instead of the ABI moving for the tests.
 *
 * Falls back to plain Node when the Electron binary is missing, so a checkout
 * without the ~100 MB download still runs everything that is ABI-independent.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { resolveElectronBinary } from "./electron-path.mjs";

const args = process.argv.slice(2);
const require = createRequire(join(process.cwd(), "package.json"));

let vitestCli;
try {
  vitestCli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
} catch {
  console.error(`vitest is not installed in ${process.cwd()}`);
  process.exit(1);
}

const electron = resolveElectronBinary();
if (!electron) {
  console.warn(
    "[vitest-electron] Electron binary not found — falling back to system Node.\n" +
      "  Native-addon tests will fail with a NODE_MODULE_VERSION mismatch.\n" +
      "  Run `pnpm install` (postinstall downloads Electron) to fix.",
  );
}

const result = spawnSync(electron ?? process.execPath, [vitestCli, ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    // Turns the Electron binary into a plain Node process: no window, no app
    // lifecycle. Inherited by the vitest workers, which respawn execPath.
    ELECTRON_RUN_AS_NODE: "1",
  },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
