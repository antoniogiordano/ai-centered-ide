import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEnvFile } from "@ai-ide/workspace";

export type EnvKeyInfo = {
  key: string;
  hasValue: boolean;
  gitignored: boolean;
};

export class EnvService {
  constructor(private readonly workspaceRoot: string) {}

  listKeys(envPath = ".env"): EnvKeyInfo[] {
    const abs = join(this.workspaceRoot, envPath);
    let content = "";
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      return [];
    }
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const [key] = line.split("=", 2);
        return {
          key: key ?? line,
          hasValue: line.includes("=") && line.split("=", 2)[1]!.length > 0,
          gitignored: isEnvFile(envPath),
        };
      });
  }

  setKey(envPath: string, key: string, value: string): void {
    if (!isEnvFile(envPath)) {
      throw new Error("Can only write gitignored .env.* files");
    }
    const abs = join(this.workspaceRoot, envPath);
    let lines: string[] = [];
    try {
      lines = readFileSync(abs, "utf8").split("\n");
    } catch {
      lines = [];
    }
    const prefix = `${key}=`;
    const idx = lines.findIndex((l) => l.startsWith(prefix) || l.startsWith(`${key} =`));
    const entry = `${key}=${value}`;
    if (idx >= 0) lines[idx] = entry;
    else lines.push(entry);
    writeFileSync(abs, lines.filter((l, i, arr) => !(i === arr.length - 1 && l === "")).join("\n") + "\n");
  }

  /** Agent must never read secret values — only key names. */
  readValue(_envPath: string, _key: string): never {
    throw new Error("Reading env values is forbidden for the agent");
  }
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function redactObject(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = /secret|password|token|key/i.test(k) ? "[REDACTED]" : redactObject(v);
    }
    return result;
  }
  return value;
}
