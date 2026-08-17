#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveElectronPackageDir } from "./electron-path.mjs";

const pkg = resolveElectronPackageDir();
if (!pkg) {
  console.warn("Electron package not found — skip ensure");
  process.exit(0);
}

if (existsSync(join(pkg, "path.txt"))) {
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
