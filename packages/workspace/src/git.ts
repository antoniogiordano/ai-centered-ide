import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
    hasRemote: boolean;
  }> {
    try {
      // Prefer rev-parse: more reliable than checkIsRepo across simple-git versions
      // and when Electron's PATH is thinner than the login shell.
      const inside = (
        await this.git.raw(["rev-parse", "--is-inside-work-tree"])
      ).trim();
      if (inside !== "true") {
        return {
          isRepo: false,
          localBranch: null,
          remoteBranch: null,
          hasRemote: false,
        };
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

      let hasRemote = false;
      try {
        const remotes = await this.git.getRemotes();
        hasRemote = remotes.length > 0;
      } catch {
        hasRemote = false;
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

      return { isRepo: true, localBranch, remoteBranch, hasRemote };
    } catch (error) {
      console.warn(
        "[git] branchInfo failed for",
        this.workspaceRoot,
        error instanceof Error ? error.message : error,
      );
      return {
        isRepo: false,
        localBranch: null,
        remoteBranch: null,
        hasRemote: false,
      };
    }
  }

  async diff(staged = false): Promise<string> {
    return staged ? this.git.diff(["--cached"]) : this.git.diff();
  }

  /**
   * Best base for "what changed on this branch":
   * upstream → origin/main → origin/master → main → master → null (fall back to HEAD).
   */
  async resolveBranchDiffBase(): Promise<string | null> {
    const candidates: string[] = [];
    try {
      const upstream = (
        await this.git.raw([
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{u}",
        ])
      ).trim();
      if (upstream && upstream !== "@{u}") candidates.push(upstream);
    } catch {
      /* no upstream */
    }
    candidates.push("origin/main", "origin/master", "main", "master");

    for (const ref of candidates) {
      try {
        await this.git.raw(["rev-parse", "--verify", `${ref}^{commit}`]);
        const mergeBase = (
          await this.git.raw(["merge-base", "HEAD", ref])
        ).trim();
        if (mergeBase) return mergeBase;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /**
   * Files changed on this branch vs merge-base (working tree included),
   * plus untracked files.
   */
  async listBranchChangedFiles(): Promise<
    { path: string; status: "A" | "M" | "D" | "R" | "?" }[]
  > {
    const byPath = new Map<
      string,
      { path: string; status: "A" | "M" | "D" | "R" | "?" }
    >();

    const applyNameStatus = (raw: string) => {
      for (const line of raw.split("\n")) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        const parts = trimmed.split("\t");
        const code = (parts[0] ?? "").trim();
        if (!code) continue;
        const letter = code[0] ?? "";
        if (letter === "R" || letter === "C") {
          const dest = parts[2] ?? parts[1];
          if (dest) byPath.set(dest, { path: dest, status: "R" });
          continue;
        }
        const path = parts[1];
        if (!path) continue;
        if (letter === "A" || letter === "M" || letter === "D") {
          byPath.set(path, { path, status: letter });
        }
      }
    };

    const base = await this.resolveBranchDiffBase();
    try {
      if (base) {
        applyNameStatus(await this.git.raw(["diff", "--name-status", base]));
      } else {
        applyNameStatus(await this.git.raw(["diff", "--name-status", "HEAD"]));
        applyNameStatus(
          await this.git.raw(["diff", "--name-status", "--cached"]),
        );
      }
    } catch {
      /* ignore */
    }

    try {
      const untracked = await this.git.raw([
        "ls-files",
        "--others",
        "--exclude-standard",
      ]);
      for (const line of untracked.split("\n")) {
        const path = line.trim();
        if (!path) continue;
        if (!byPath.has(path)) byPath.set(path, { path, status: "?" });
      }
    } catch {
      /* ignore */
    }

    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Unified diff for one path against the branch merge-base (or HEAD). */
  async fileDiffAgainstBase(relativePath: string): Promise<{
    base: string | null;
    patch: string;
    untracked: boolean;
  }> {
    assertInsideWorkspace(this.workspaceRoot, relativePath);
    const base = await this.resolveBranchDiffBase();

    try {
      const tracked = (
        await this.git.raw(["ls-files", "--", relativePath])
      ).trim();
      if (!tracked) {
        // Untracked: synthesize an all-additions patch from file contents.
        const abs = join(this.workspaceRoot, relativePath);
        let content = "";
        try {
          content = readFileSync(abs, "utf8");
        } catch {
          return { base, patch: "", untracked: true };
        }
        const lines = content.split("\n");
        const body = lines.map((l) => `+${l}`).join("\n");
        const patch = [
          `diff --git a/${relativePath} b/${relativePath}`,
          "new file mode 100644",
          `--- /dev/null`,
          `+++ b/${relativePath}`,
          `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
          body,
        ].join("\n");
        return { base, patch, untracked: true };
      }
    } catch {
      /* fall through to normal diff */
    }

    try {
      const range = base ?? "HEAD";
      const patch = await this.git.diff([range, "--", relativePath]);
      return { base, patch, untracked: false };
    } catch {
      return { base, patch: "", untracked: false };
    }
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

  /** Local branch short names (refs/heads). */
  async listLocalBranches(): Promise<string[]> {
    const detailed = await this.listLocalBranchesDetailed();
    return detailed.map((b) => b.name);
  }

  /** Local heads with last commit time (newest first). */
  async listLocalBranchesDetailed(): Promise<
    Array<{ name: string; lastCommitAt: string }>
  > {
    try {
      const out = await this.git.raw([
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:iso-strict)",
        "refs/heads",
      ]);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          if (tab < 0) {
            return { name: line, lastCommitAt: new Date(0).toISOString() };
          }
          return {
            name: line.slice(0, tab),
            lastCommitAt: line.slice(tab + 1) || new Date(0).toISOString(),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Names that must not be reused for a new local branch:
   * local heads + remote-tracking short names (origin/feat/x → feat/x).
   */
  async listTakenBranchNames(): Promise<string[]> {
    const taken = new Set(await this.listLocalBranches());
    try {
      const remotes = await this.git.raw([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes",
      ]);
      for (const line of remotes.split("\n")) {
        const ref = line.trim();
        if (!ref) continue;
        const slash = ref.indexOf("/");
        if (slash < 0) continue;
        taken.add(ref.slice(slash + 1));
      }
    } catch {
      /* ignore */
    }
    return [...taken];
  }

  async branchNameTaken(name: string): Promise<boolean> {
    const taken = await this.listTakenBranchNames();
    return taken.includes(name);
  }

  async localBranchExists(name: string): Promise<boolean> {
    const locals = await this.listLocalBranches();
    return locals.includes(name);
  }

  /**
   * Create and checkout a new branch.
   * When `base` is set, create from that ref; otherwise from current HEAD.
   */
  async createAndCheckoutBranch(name: string, base?: string): Promise<void> {
    if (base && base.trim()) {
      await this.git.raw(["checkout", "-b", name, base.trim()]);
      return;
    }
    await this.git.checkoutLocalBranch(name);
  }

  async isDirty(): Promise<boolean> {
    const status = await this.git.status();
    return Boolean(
      status.modified.length ||
        status.not_added.length ||
        status.created.length ||
        status.deleted.length ||
        status.conflicted.length ||
        status.renamed.length,
    );
  }

  async dirtyFileCount(): Promise<number> {
    const status = await this.git.status();
    return new Set([
      ...status.modified,
      ...status.not_added,
      ...status.created,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
      ...status.conflicted,
    ]).size;
  }

  async stashPush(message: string): Promise<void> {
    // Include untracked so the worktree is clean for checkout.
    await this.git.stash(["push", "-u", "-m", message]);
  }

  async stashPop(): Promise<void> {
    await this.git.stash(["pop"]);
  }

  async checkoutExisting(name: string): Promise<void> {
    await this.git.checkout(name);
  }

  /**
   * Create a feat branch from `base`, handling a dirty worktree via stash or
   * commit-on-base first.
   */
  async createFeatBranchHandlingDirty(opts: {
    name: string;
    base: string;
    dirtyStrategy?: "stash" | "commit_base";
    baseCommitMessage?: string;
  }): Promise<{ stashed: boolean; committedOnBase: boolean }> {
    const dirty = await this.isDirty();
    const info = await this.branchInfo();
    const current = info.localBranch;
    const base = opts.base.trim();

    if (dirty) {
      if (!opts.dirtyStrategy) {
        throw new Error("DIRTY_STRATEGY_REQUIRED");
      }

      if (opts.dirtyStrategy === "stash") {
        await this.stashPush(`ai-ide: before ${opts.name}`);
        if (current && current !== base) {
          await this.checkoutExisting(base);
        }
        await this.git.raw(["checkout", "-b", opts.name]);
        return { stashed: true, committedOnBase: false };
      }

      // commit_base: land changes on base tip, then fork feat from that commit.
      if (current && current !== base) {
        await this.stashPush(`ai-ide: move changes onto ${base}`);
        await this.checkoutExisting(base);
        await this.stashPop();
      } else if (current !== base) {
        await this.checkoutExisting(base);
      }
      const staged = await this.stageAllChanges();
      if (staged.length === 0) {
        // Race: became clean — still create the branch.
        await this.git.raw(["checkout", "-b", opts.name]);
        return { stashed: false, committedOnBase: false };
      }
      const message =
        opts.baseCommitMessage?.trim() ||
        `chore: checkpoint before ${opts.name}`;
      await this.commit(message);
      await this.git.raw(["checkout", "-b", opts.name]);
      return { stashed: false, committedOnBase: true };
    }

    if (current && current !== base) {
      await this.git.raw(["checkout", "-b", opts.name, base]);
    } else {
      await this.git.checkoutLocalBranch(opts.name);
    }
    return { stashed: false, committedOnBase: false };
  }

  /** Stage all modified + untracked paths currently visible to git status. */
  async stageAllChanges(): Promise<string[]> {
    const status = await this.git.status();
    const paths = [
      ...status.modified,
      ...status.not_added,
      ...status.created,
      ...status.deleted,
      ...status.renamed.map((r) => r.to),
    ].filter(Boolean);
    const unique = [...new Set(paths)];
    if (unique.length === 0) return [];
    await this.git.add(["-A"]);
    return unique;
  }

  /** Initialize a new repository with default branch `main`. */
  async init(): Promise<void> {
    await this.git.raw(["init", "-b", "main"]);
  }

  async hasRemote(name: string): Promise<boolean> {
    const remotes = await this.git.getRemotes();
    return remotes.some((r) => r.name === name);
  }

  async addRemote(name: string, url: string): Promise<void> {
    if (await this.hasRemote(name)) {
      await this.git.remote(["set-url", name, url]);
      return;
    }
    await this.git.addRemote(name, url);
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    await this.git.remote(["set-url", name, url]);
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
