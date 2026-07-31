#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function resolveElectronPkg() {
  const candidates = [
    join(root, "apps/desktop"),
    root,
  ];
  for (const base of candidates) {
    try {
      const require = createRequire(join(base, "package.json"));
      return dirname(require.resolve("electron/package.json"));
    } catch {
      /* try next */
    }
  }
  const pnpm = join(root, "node_modules/.pnpm");
  if (existsSync(pnpm)) {
    const hit = readdirSync(pnpm).find((n) => n.startsWith("electron@"));
    if (hit) {
      return join(pnpm, hit, "node_modules/electron");
    }
  }
  return null;
}

const pkg = resolveElectronPkg();
if (!pkg) {
  console.warn("Electron package not found — skip ensure");
  process.exit(0);
}

const pathTxt = join(pkg, "path.txt");
if (existsSync(pathTxt)) {
  console.log("Electron binary OK");
  process.exit(0);
}

console.log("Electron binary missing — running install.js…");
const result = spawnSync(process.execPath, [join(pkg, "install.js")], {
  cwd: pkg,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
