import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Enrich PATH for Electron-hosted shells (often thinner than Terminal.app).
 * Prefer an explicit project pin (.nvmrc / .node-version) when present under cwd.
 */
export function enrichShellEnv(
  cwd: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (platform() === "win32") return env;

  const home = env.HOME || homedir();
  const extras: string[] = [
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".local", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".fnm", "current", "bin"),
  ];

  const pinned = resolvePinnedNodeBin(cwd, home);
  if (pinned) extras.unshift(pinned);

  const nvmDefault = resolveNvmDefaultBin(home);
  if (nvmDefault && nvmDefault !== pinned) extras.push(nvmDefault);

  const current = (env.PATH ?? "").split(":").filter(Boolean);
  const merged = [...extras, ...current];
  const seen = new Set<string>();
  env.PATH = merged.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  }).join(":");

  if (!env.NVM_DIR) {
    const nvmDir = join(home, ".nvm");
    if (existsSync(nvmDir)) env.NVM_DIR = nvmDir;
  }
  if (!env.TERM) env.TERM = "xterm-256color";

  return env;
}

/**
 * Unix one-shot wrapper: source nvm/fnm when available and honor .nvmrc in cwd.
 * Keeps agent commands working even when Electron PATH lacks the right node.
 */
export function wrapUnixLoginCommand(command: string, cwd: string): string {
  if (platform() === "win32") return command;
  const home = process.env.HOME || homedir();
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const hasPin =
    existsSync(join(cwd, ".nvmrc")) || existsSync(join(cwd, ".node-version"));

  const lines = [
    'export NVM_DIR="${NVM_DIR:-' + shellSingleQuote(nvmDir) + '}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    'command -v fnm >/dev/null 2>&1 && eval "$(fnm env)" >/dev/null 2>&1 || true',
  ];
  if (hasPin) {
    lines.push(
      'command -v nvm >/dev/null 2>&1 && nvm use >/dev/null 2>&1 || true',
      'command -v fnm >/dev/null 2>&1 && fnm use >/dev/null 2>&1 || true',
    );
  }
  lines.push(command);
  return lines.join("; ");
}

/** Snippet written once into a new interactive PTY so nvm/node stick for the session. */
export function interactiveToolchainBootstrap(cwd: string): string {
  if (platform() === "win32") return "";
  const home = process.env.HOME || homedir();
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const hasPin =
    existsSync(join(cwd, ".nvmrc")) || existsSync(join(cwd, ".node-version"));
  const parts = [
    `export NVM_DIR=${shellSingleQuote(nvmDir)}`,
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    'command -v fnm >/dev/null 2>&1 && eval "$(fnm env)"',
  ];
  if (hasPin) {
    parts.push(
      'command -v nvm >/dev/null 2>&1 && nvm use',
      'command -v fnm >/dev/null 2>&1 && fnm use',
    );
  }
  parts.push('command -v node >/dev/null 2>&1 && echo "[ai-ide] node $(node -v)"');
  return `${parts.join("; ")}\n`;
}

function resolvePinnedNodeBin(cwd: string, home: string): string | null {
  const pin =
    readPinVersion(join(cwd, ".nvmrc")) ??
    readPinVersion(join(cwd, ".node-version"));
  if (!pin) return null;
  const versionsRoot = join(home, ".nvm", "versions", "node");
  if (!existsSync(versionsRoot)) return null;

  const exact = join(versionsRoot, pin.startsWith("v") ? pin : `v${pin}`, "bin");
  if (existsSync(join(exact, "node"))) return exact;

  // Prefix match: "18" → highest v18.*
  const want = pin.replace(/^v/, "");
  let best: string | null = null;
  for (const name of safeReaddir(versionsRoot)) {
    const ver = name.replace(/^v/, "");
    if (ver === want || ver.startsWith(`${want}.`)) {
      const bin = join(versionsRoot, name, "bin");
      if (existsSync(join(bin, "node"))) {
        if (!best || name > best) best = name;
      }
    }
  }
  return best ? join(versionsRoot, best, "bin") : null;
}

function resolveNvmDefaultBin(home: string): string | null {
  const versionsRoot = join(home, ".nvm", "versions", "node");
  if (!existsSync(versionsRoot)) return null;
  const names = safeReaddir(versionsRoot).filter((n) =>
    existsSync(join(versionsRoot, n, "bin", "node")),
  );
  if (names.length === 0) return null;
  names.sort();
  const latest = names[names.length - 1]!;
  return join(versionsRoot, latest, "bin");
}

function readPinVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? "";
    if (!raw || raw.startsWith("#")) return null;
    return raw;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
