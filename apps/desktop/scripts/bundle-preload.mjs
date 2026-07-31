#!/usr/bin/env node
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, "..");

await build({
  entryPoints: [join(root, "src/preload/index.ts")],
  outfile: join(root, "dist/preload/index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
});

console.log("Preload bundled → dist/preload/index.cjs");
