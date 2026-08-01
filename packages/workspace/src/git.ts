import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { assertInsideWorkspace } from "./perimeter.js";
import { isEnvFile } from "./filesystem.js";

function resolveGitBinary(): string {
  const candidates = [
    process.env.GIT_BINARY,
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "git",
  ].filter((v): v is string => Boolean(v));
  for (const candidate of candidates) {
    if (candidate === "git") return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return "git";
}

export class GitService {
  private readonly git;

  constructor(private readonly workspaceRoot: string) {
    this.git = simpleGit({
      baseDir: workspaceRoot,
      binary: resolveGitBinary(),
    });
  }

  async status(): Promise<{ current: string; modified: string[]; not_added: string[] }> {
    const result = await this.git.status();
    return {
      current: result.current ?? "HEAD",
      modified: result.modified,
      not_added: result.not_added,
    };
  }

  /** Local branch + upstream tracking branch (e.g. origin/main), if any. */
  async branchInfo(): Promise<{
    isRepo: boolean;
    localBranch: string | null;
    remoteBranch: string | null;
  }> {
    try {
      // Prefer rev-parse: more reliable than checkIsRepo across simple-git versions
      // and when Electron's PATH is thinner than the login shell.
      const inside = (
        await this.git.raw(["rev-parse", "--is-inside-work-tree"])
      ).trim();
      if (inside !== "true") {
        return { isRepo: false, localBranch: null, remoteBranch: null };
      }

      let localBranch: string | null = null;
      try {
        localBranch = (
          await this.git.raw(["branch", "--show-current"])
        ).trim() || null;
      } catch {
        localBranch = null;
      }
      if (!localBranch) {
        try {
          localBranch = (
            await this.git.raw(["rev-parse", "--abbrev-ref", "HEAD"])
          ).trim() || null;
          if (localBranch === "HEAD") localBranch = "detached HEAD";
        } catch {
          localBranch = "HEAD";
        }
      }

      let remoteBranch: string | null = null;
      try {
        const upstream = (
          await this.git.raw([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
          ])
        ).trim();
        if (upstream && upstream !== "@{u}") remoteBranch = upstream;
      } catch {
        // No upstream configured.
        remoteBranch = null;
      }

      return { isRepo: true, localBranch, remoteBranch };
    } catch (error) {
      console.warn(
        "[git] branchInfo failed for",
        this.workspaceRoot,
        error instanceof Error ? error.message : error,
      );
      return { isRepo: false, localBranch: null, remoteBranch: null };
    }
  }

  async diff(staged = false): Promise<string> {
    return staged ? this.git.diff(["--cached"]) : this.git.diff();
  }

  async stage(paths: string[]): Promise<void> {
    for (const p of paths) {
      assertInsideWorkspace(this.workspaceRoot, p);
    }
    await this.git.add(paths);
  }

  async unstage(paths: string[]): Promise<void> {
    for (const p of paths) {
      assertInsideWorkspace(this.workspaceRoot, p);
    }
    await this.git.reset(["HEAD", ...paths]);
  }

  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message);
    return result.commit;
  }
}

export type CheckpointRecord = {
  id: string;
  label?: string;
  paths: string[];
  createdAt: string;
};

export class CheckpointService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly storageDir: string,
  ) {}

  create(id: string, touchedPaths: string[], label?: string): CheckpointRecord {
    const checkpointDir = join(this.storageDir, id);
    mkdirSync(checkpointDir, { recursive: true });
    const stored: string[] = [];

    for (const rel of touchedPaths) {
      if (isEnvFile(rel)) continue;
      const abs = assertInsideWorkspace(this.workspaceRoot, rel);
      if (!existsSync(abs)) continue;
      const dest = join(checkpointDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(abs, dest);
      stored.push(rel);
    }

    const record: CheckpointRecord = {
      id,
      paths: stored,
      createdAt: new Date().toISOString(),
    };
    if (label !== undefined) record.label = label;
    return record;
  }

  restore(record: CheckpointRecord): void {
    const checkpointDir = join(this.storageDir, record.id);
    for (const rel of record.paths) {
      const src = join(checkpointDir, rel);
      const dest = assertInsideWorkspace(this.workspaceRoot, rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
  }

  delete(id: string): void {
    const checkpointDir = join(this.storageDir, id);
    if (existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  }
}
