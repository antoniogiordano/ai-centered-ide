import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../../..");
const mainEntry = join(root, "apps/desktop/dist/index.js");

function buildDesktop() {
  console.log("Building @ai-ide/desktop…");
  const result = spawnSync(
    "pnpm",
    ["--filter", "@ai-ide/desktop", "build"],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(mainEntry)) {
  buildDesktop();
} else {
  // Always rebuild so source changes are picked up
  buildDesktop();
}

if (!existsSync(mainEntry)) {
  console.error("Desktop build did not produce", mainEntry);
  process.exit(1);
}

console.log("Ensuring native modules match Electron ABI…");
spawnSync("node", [join(root, "scripts/rebuild-native-for-electron.mjs")], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const vite = spawn("pnpm", ["--filter", "@ai-ide/renderer", "dev"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
});

let electronProc = null;

vite.on("spawn", () => {
  setTimeout(() => {
    electronProc = spawn(
      "pnpm",
      ["--filter", "@ai-ide/desktop", "exec", "electron", mainEntry],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          VITE_DEV_SERVER_URL: "http://localhost:5174",
        },
      },
    );
    electronProc.on("exit", (code) => {
      vite.kill();
      process.exit(code ?? 0);
    });
  }, 2500);
});

function shutdown() {
  // Give Electron a chance to persist window bounds before hard-kill.
  if (electronProc && !electronProc.killed) {
    electronProc.kill("SIGTERM");
    const force = setTimeout(() => {
      electronProc?.kill("SIGKILL");
      vite.kill();
      process.exit(0);
    }, 800);
    electronProc.once("exit", () => {
      clearTimeout(force);
      vite.kill();
      process.exit(0);
    });
    return;
  }
  vite.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
