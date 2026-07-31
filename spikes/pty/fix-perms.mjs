#!/usr/bin/env node
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { arch, platform } from "node:os";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("node-pty/package.json"));
const helper = path.join(root, "prebuilds", `${platform()}-${arch()}`, "spawn-helper");
if (existsSync(helper)) {
  chmodSync(helper, 0o755);
  console.log("chmod +x", helper);
}
