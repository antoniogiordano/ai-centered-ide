#!/usr/bin/env node
/**
 * Internal build helper (Phase 10.8) — compiles packages then packages Electron for the host OS.
 * No code signing / auto-update in MVP.
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

console.log(`Building AI-Centered IDE for ${platform()}…`);
execSync("pnpm -r build", { stdio: "inherit" });
console.log("Compile OK. Electron packaging (electron-builder) can be wired here for CI artifacts.");
console.log("MVP ships unsigned internal builds only.");
