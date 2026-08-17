#!/usr/bin/env node
/**
 * Rebuild native modules against the Electron ABI (not system Node).
 * System Node 22 ≈ MODULE 127; Electron 36 ≈ MODULE 135 — they are not interchangeable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { readElectronVersion, repoRoot as root } from "./electron-path.mjs";

const stampPath = join(root, "node_modules/.cache/electron-native-abi");
const electronVersion = readElectronVersion();

const force = process.argv.includes("--force");
const stamp = `electron@${electronVersion}:better-sqlite3,keytar,node-pty`;

if (!force && existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === stamp) {
  console.log(`Native modules already built for Electron ${electronVersion}`);
  process.exit(0);
}

console.log(`Rebuilding native modules for Electron ${electronVersion}…`);

function rebuild(moduleDir, only) {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "electron-rebuild",
      "-f",
      "-v",
      electronVersion,
      "-m",
      moduleDir,
      "-o",
      only,
      "--build-from-source",
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );
}

let result = rebuild("packages/storage", "better-sqlite3");
if (result.status !== 0) {
  result = rebuild(".", "better-sqlite3,keytar,node-pty");
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  const desktop = rebuild("apps/desktop", "keytar,node-pty");
  if (desktop.status !== 0) process.exit(desktop.status ?? 1);
}

mkdirSync(dirname(stampPath), { recursive: true });
writeFileSync(stampPath, stamp);
console.log("Native modules ready for Electron");
