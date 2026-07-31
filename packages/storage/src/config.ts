import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export type ConfigLevel = "global" | "workspace" | "project";

export const ConfigSchema = z.record(z.unknown());
export type ConfigData = z.infer<typeof ConfigSchema>;

export function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

export class ConfigStore {
  constructor(
    private readonly paths: {
      global: string;
      workspace?: string;
      project?: string;
    },
  ) {}

  read(): ConfigData {
    const merged: ConfigData = {};
    const paths = [this.paths.global, this.paths.workspace, this.paths.project];

    for (const path of paths) {
      if (!path || !existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      Object.assign(merged, raw);
    }
    return merged;
  }

  write(level: ConfigLevel, data: ConfigData): void {
    const path = this.resolvePath(level);
    if (!path) {
      throw new Error(`Config level ${level} is not configured`);
    }
    atomicWriteJson(path, data);
  }

  get<T>(key: string, schema: z.ZodType<T>): T | undefined {
    const merged = this.read();
    if (!(key in merged)) return undefined;
    return schema.parse(merged[key]);
  }

  set(level: ConfigLevel, key: string, value: unknown): void {
    const path = this.resolvePath(level);
    if (!path) throw new Error(`Config level ${level} is not configured`);
    const current = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as ConfigData)
      : {};
    current[key] = value;
    atomicWriteJson(path, current);
  }

  resolvePath(level: ConfigLevel): string | undefined {
    switch (level) {
      case "global":
        return this.paths.global;
      case "workspace":
        return this.paths.workspace;
      case "project":
        return this.paths.project;
    }
  }
}

export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.backup.${Date.now()}`;
  copyFileSync(path, backup);
  return backup;
}
