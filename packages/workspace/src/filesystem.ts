import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, basename, join, relative } from "node:path";
import { AppError } from "@ai-ide/shared";
import { assertInsideWorkspace } from "./perimeter.js";

export const DEFAULT_MAX_READ_BYTES = 512 * 1024;
export const DEFAULT_MAX_WRITE_BYTES = 512 * 1024;
/** Default window size for agent `read_file` (lines). */
export const DEFAULT_READ_WINDOW_LINES = 250;
/** Hard cap per `read_file` call — agent pages with startLine. */
export const HARD_MAX_READ_WINDOW_LINES = 800;
/** Cap a single returned window by characters (very long lines). */
export const DEFAULT_READ_WINDOW_MAX_CHARS = 120_000;

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type FileReadWindow = {
  path: string;
  content: string;
  /** 1-based inclusive start of the returned window. */
  startLine: number;
  /** 1-based inclusive end of the returned window. */
  endLine: number;
  maxLines: number;
  /** Total lines when known; null for huge streamed files after a truncated window. */
  totalLines: number | null;
  totalBytes: number;
  /** True when more lines exist after endLine. */
  truncated: boolean;
  /** Next startLine to request, or null if exhausted. */
  nextStartLine: number | null;
  /** True when content was clipped by the char budget. */
  contentTruncated: boolean;
};

export class FilesystemService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly maxReadBytes = DEFAULT_MAX_READ_BYTES,
    private readonly maxWriteBytes = DEFAULT_MAX_WRITE_BYTES,
  ) {}

  /**
   * Full-file read for small UTF-8 texts (internal helpers, patches).
   * Prefer {@link readWindow} for agent-facing reads — large files hard-fail here.
   */
  read(relativePath: string): string {
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    const stat = statSync(abs);
    if (stat.size > this.maxReadBytes) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage:
          "File is too large to read in one shot. Use read_file with startLine/maxLines.",
        technicalDetail: `${relativePath} size ${stat.size}`,
      });
    }
    return readFileSync(abs, "utf8");
  }

  /**
   * Read a line window from a UTF-8 text file. Works for files larger than
   * {@link DEFAULT_MAX_READ_BYTES} by streaming; the agent pages via startLine.
   */
  async readWindow(
    relativePath: string,
    options?: {
      startLine?: number;
      maxLines?: number;
      maxChars?: number;
    },
  ): Promise<FileReadWindow> {
    const abs = assertInsideWorkspace(this.workspaceRoot, relativePath);
    const stat = statSync(abs);
    const startLine = Math.max(1, Math.floor(options?.startLine ?? 1));
    const maxLines = Math.min(
      HARD_MAX_READ_WINDOW_LINES,
      Math.max(1, Math.floor(options?.maxLines ?? DEFAULT_READ_WINDOW_LINES)),
    );
    const maxChars = Math.max(
      1_000,
      Math.floor(options?.maxChars ?? DEFAULT_READ_WINDOW_MAX_CHARS),
    );

    if (stat.size <= this.maxReadBytes) {
      const text = readFileSync(abs, "utf8");
      return sliceLineWindow(relativePath, text, stat.size, startLine, maxLines, maxChars);
    }

    return readWindowStreaming(
      relativePath,
      abs,
      stat.size,
      startLine,
      maxLines,
      maxChars,
    );
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

function sliceLineWindow(
  relativePath: string,
  text: string,
  totalBytes: number,
  startLine: number,
  maxLines: number,
  maxChars: number,
): FileReadWindow {
  const lines = text.split("\n");
  // Trailing empty from final \n is a real last empty line — keep as-is.
  const totalLines = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
  if (totalLines === 0) {
    return {
      path: relativePath,
      content: "",
      startLine: 1,
      endLine: 0,
      maxLines,
      totalLines: 0,
      totalBytes,
      truncated: false,
      nextStartLine: null,
      contentTruncated: false,
    };
  }
  const from = Math.min(startLine, totalLines + 1);
  const slice = lines.slice(from - 1, from - 1 + maxLines);
  const endLine = slice.length === 0 ? from - 1 : from + slice.length - 1;
  const truncated = endLine < totalLines;
  let content = slice.join("\n");
  let contentTruncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    contentTruncated = true;
  }
  return {
    path: relativePath,
    content,
    startLine: slice.length === 0 ? from : from,
    endLine,
    maxLines,
    totalLines,
    totalBytes,
    truncated,
    nextStartLine: truncated ? endLine + 1 : null,
    contentTruncated,
  };
}

async function readWindowStreaming(
  relativePath: string,
  absPath: string,
  totalBytes: number,
  startLine: number,
  maxLines: number,
  maxChars: number,
): Promise<FileReadWindow> {
  const collected: string[] = [];
  let lineNo = 0;
  let hasMore = false;

  const stream = createReadStream(absPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < startLine) continue;
      if (collected.length < maxLines) {
        collected.push(line);
      } else {
        hasMore = true;
        // Stop early — do not scan the rest of a multi‑MB file for a line count.
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const endLine =
    collected.length === 0 ? startLine - 1 : startLine + collected.length - 1;
  let content = collected.join("\n");
  let contentTruncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    contentTruncated = true;
  }

  return {
    path: relativePath,
    content,
    startLine,
    endLine,
    maxLines,
    totalLines: hasMore ? null : lineNo,
    totalBytes,
    truncated: hasMore,
    nextStartLine: hasMore ? endLine + 1 : null,
    contentTruncated,
  };
}
