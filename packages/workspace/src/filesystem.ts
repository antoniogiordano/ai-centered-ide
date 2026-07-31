import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, join, relative } from "node:path";
import { AppError } from "@ai-ide/shared";
import { assertInsideWorkspace } from "./perimeter.js";

export const DEFAULT_MAX_READ_BYTES = 512 * 1024;
export const DEFAULT_MAX_WRITE_BYTES = 512 * 1024;

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export class FilesystemService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly maxReadBytes = DEFAULT_MAX_READ_BYTES,
    private readonly maxWriteBytes = DEFAULT_MAX_WRITE_BYTES,
  ) {}

  read(relativePath: string): string {
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    const stat = statSync(abs);
    if (stat.size > this.maxReadBytes) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage: "File is too large to read.",
        technicalDetail: `${relativePath} size ${stat.size}`,
      });
    }
    return readFileSync(abs, "utf8");
  }

  list(relativePath = "."): string[] {
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    return readdirSync(abs);
  }

  listDetailed(relativePath = "."): FileEntry[] {
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    return readdirSync(abs).map((name) => {
      const child = join(abs, name);
      const stat = statSync(child);
      return {
        name,
        path: relative(this.workspaceRoot, child),
        isDirectory: stat.isDirectory(),
        size: stat.size,
      };
    });
  }

  write(relativePath: string, content: string): void {
    if (Buffer.byteLength(content, "utf8") > this.maxWriteBytes) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage: "Content is too large to write.",
        technicalDetail: relativePath,
      });
    }
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  patch(relativePath: string, search: string, replace: string): void {
    const content = this.read(relativePath);
    if (!content.includes(search)) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "Could not find the text to replace.",
        technicalDetail: relativePath,
      });
    }
    this.write(relativePath, content.replace(search, replace));
  }

  delete(relativePath: string): void {
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    unlinkSync(abs);
  }
}

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "release",
]);

function loadGitignore(workspaceRoot: string): Set<string> {
  const ignore = new Set(DEFAULT_IGNORE);
  try {
    const content = readFileSync(join(workspaceRoot, ".gitignore"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      ignore.add(trimmed.replace(/\/$/, ""));
    }
  } catch {
    /* no gitignore */
  }
  return ignore;
}

function shouldIgnore(name: string, ignore: Set<string>): boolean {
  return ignore.has(name) || name.startsWith(".env");
}

export function searchText(
  workspaceRoot: string,
  query: string,
  options?: { maxResults?: number },
): SearchMatch[] {
  const ignore = loadGitignore(workspaceRoot);
  const max = options?.maxResults ?? 100;
  const matches: SearchMatch[] = [];

  function walk(dir: string): void {
    if (matches.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (shouldIgnore(name, ignore)) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.size > DEFAULT_MAX_READ_BYTES) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(query)) {
          matches.push({
            path: relative(workspaceRoot, full),
            line: i + 1,
            text: lines[i]!.trim(),
          });
          if (matches.length >= max) return;
        }
      }
    }
  }

  walk(workspaceRoot);
  return matches;
}

export function isEnvFile(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}
