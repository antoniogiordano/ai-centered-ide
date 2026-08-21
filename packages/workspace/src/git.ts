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
    return (await this.listDirtyFiles()).length;
  }

  async listDirtyFiles(): Promise<string[]> {
    const status = await this.git.status();
    return [
      ...new Set([
        ...status.modified,
        ...status.not_added,
        ...status.created,
        ...status.deleted,
        ...status.renamed.map((r) => r.to),
        ...status.conflicted,
      ]),
    ].filter(Boolean);
  }

  /**
   * File list + a truncated patch for the AI to name a stash or commit.
   * Untracked files appear by name only (no content).
   */
  async changeSummary(maxChars = 6_000): Promise<{
    files: string[];
    diff: string;
  }> {
    const files = await this.listDirtyFiles();
    let diff = "";
    try {
      diff = await this.git.diff(["HEAD"]);
    } catch {
      diff = "";
    }
    const clipped =
      diff.length > maxChars
        ? `${diff.slice(0, maxChars)}\n…\n[${diff.length - maxChars} more characters hidden]`
        : diff;
    return { files, diff: clipped };
  }

  async stashPush(message: string): Promise<void> {
    // Include untracked so the worktree is clean for checkout.
    await this.git.stash(["push", "-u", "-m", message]);
  }

  async listStashes(): Promise<Array<{ index: number; ref: string; message: string }>> {
    try {
      const out = await this.git.raw(["stash", "list", "--format=%gd\t%s"]);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const ref = tab >= 0 ? line.slice(0, tab) : line;
          const message = tab >= 0 ? line.slice(tab + 1) : "";
          const match = /stash@\{(\d+)\}/.exec(ref);
          return {
            index: match ? Number(match[1]) : 0,
            ref,
            message,
          };
        });
    } catch {
      return [];
    }
  }

  async stashCount(): Promise<number> {
    return (await this.listStashes()).length;
  }

  async stashPop(index?: number): Promise<void> {
    if (typeof index === "number") {
      await this.git.stash(["pop", `stash@{${index}}`]);
      return;
    }
    await this.git.stash(["pop"]);
  }

  async commitWorktree(message: string): Promise<{ sha: string; files: string[] }> {
    const files = await this.stageAllChanges();
    if (files.length === 0) {
      throw new Error("NOTHING_TO_COMMIT");
    }
    const sha = await this.commit(message);
    return { sha, files };
  }

  async checkoutExisting(name: string): Promise<void> {
    await this.git.checkout(name);
  }

  /**
   * After the human confirms discard: leave the feat branch, checkout the
   * remembered base (force if the worktree is dirty — discard already said
   * uncommitted work goes away), then delete the local feat/* branch.
   * Never touches main/master/develop or a remote.
   */
  async discardLocalFeatBranch(opts: {
    branch: string;
    checkout: string;
  }): Promise<void> {
    const branch = opts.branch.trim();
    const checkout = opts.checkout.trim();
    if (!branch.startsWith("feat/")) {
      throw new Error("NOT_FEAT_BRANCH");
    }
    if (!checkout || checkout === branch) {
      throw new Error("INVALID_CHECKOUT_TARGET");
    }
    const protectedNames = new Set(["main", "master", "develop", "trunk"]);
    if (protectedNames.has(branch)) {
      throw new Error("PROTECTED_BRANCH");
    }
    const info = await this.branchInfo();
    if (info.localBranch === branch) {
      await this.git.raw(["checkout", "-f", checkout]);
    }
    await this.git.raw(["branch", "-D", branch]);
  }

  /** Merge `head` into current branch (caller should checkout the base first). */
  async mergeBranch(head: string, message?: string): Promise<void> {
    if (message?.trim()) {
      await this.git.merge([head, "-m", message.trim()]);
      return;
    }
    await this.git.merge([head, "--no-edit"]);
  }

  /**
   * Checkout `base`, merge `head` into it. Fails if the worktree is dirty.
   */
  async mergeIntoBase(opts: {
    base: string;
    head: string;
    message?: string;
  }): Promise<void> {
    if (await this.isDirty()) {
      throw new Error("DIRTY_WORKTREE");
    }
    await this.checkoutExisting(opts.base);
    await this.mergeBranch(opts.head, opts.message);
  }

  /** Push current branch to origin, setting upstream when missing. */
  async pushCurrentUpstream(remote = "origin"): Promise<void> {
    const info = await this.branchInfo();
    const branch = info.localBranch;
    if (!branch) throw new Error("DETACHED_HEAD");
    const status = await this.git.status();
    if (status.tracking) {
      await this.git.push(remote, branch);
      return;
    }
    await this.git.raw(["push", "-u", remote, branch]);
  }

  async listRemotes(): Promise<string[]> {
    try {
      const remotes = await this.git.getRemotes();
      return remotes.map((r) => r.name).filter(Boolean);
    } catch {
      return [];
    }
  }

  async conflictedFiles(): Promise<string[]> {
    try {
      const status = await this.git.status();
      return [...new Set(status.conflicted.filter(Boolean))];
    } catch {
      return [];
    }
  }

  /**
   * Ahead/behind vs `remote/branch`. Missing remote ref means unknown (nulls).
   */
  async aheadBehind(
    remote: string,
    branch: string,
  ): Promise<{ ahead: number | null; behind: number | null; compareRef: string | null }> {
    const ref = `${remote}/${branch}`;
    try {
      const exists = (
        await this.git.raw(["rev-parse", "--verify", "--quiet", ref])
      ).trim();
      if (!exists) {
        return { ahead: null, behind: null, compareRef: null };
      }
      const counts = (
        await this.git.raw(["rev-list", "--left-right", "--count", `HEAD...${ref}`])
      ).trim();
      const [left, right] = counts.split(/\s+/);
      const ahead = Number(left);
      const behind = Number(right);
      return {
        ahead: Number.isFinite(ahead) ? ahead : null,
        behind: Number.isFinite(behind) ? behind : null,
        compareRef: ref,
      };
    } catch {
      return { ahead: null, behind: null, compareRef: null };
    }
  }

  async fetchRemote(remote: string): Promise<void> {
    await this.git.fetch([remote]);
  }

  /**
   * Fetch + merge `remote/current`. Returns conflicted paths when the merge stops.
   */
  async pullFrom(remote: string): Promise<{
    ok: boolean;
    conflicted: string[];
    detail?: string;
  }> {
    const info = await this.branchInfo();
    const branch = info.localBranch;
    if (!branch) return { ok: false, conflicted: [], detail: "DETACHED_HEAD" };
    try {
      await this.fetchRemote(remote);
    } catch (error) {
      return {
        ok: false,
        conflicted: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const ref = `${remote}/${branch}`;
    try {
      await this.git.raw(["rev-parse", "--verify", "--quiet", ref]);
    } catch {
      return { ok: false, conflicted: [], detail: "NO_REMOTE_REF" };
    }
    try {
      await this.git.merge([ref]);
      return { ok: true, conflicted: [] };
    } catch (error) {
      const conflicted = await this.conflictedFiles();
      return {
        ok: false,
        conflicted,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Checkout a local head, or create a local tracking branch from a remote.
   * Dirty trees need `stash` or `force` (force discards uncommitted work).
   */
  async checkoutBranch(
    name: string,
    dirtyStrategy?: "stash" | "force",
  ): Promise<void> {
    const branch = name.trim();
    if (!branch) throw new Error("EMPTY_BRANCH");
    const current = await this.branchInfo();
    if (current.localBranch === branch) return;
    const dirty = await this.isDirty();
    if (dirty) {
      if (!dirtyStrategy) throw new Error("DIRTY_STRATEGY_REQUIRED");
      if (dirtyStrategy === "stash") {
        await this.stashPush(`ai-ide: checkout ${branch}`);
      } else if (dirtyStrategy === "force") {
        await this.git.raw(["reset", "--hard"]);
        await this.git.raw(["clean", "-fd"]);
      }
    }
    const local = await this.localBranchExists(branch);
    if (local) {
      await this.checkoutExisting(branch);
      return;
    }
    const remotes = await this.listRemotes();
    for (const remote of remotes) {
      const ref = `${remote}/${branch}`;
      try {
        const exists = (
          await this.git.raw(["rev-parse", "--verify", "--quiet", ref])
        ).trim();
        if (!exists) continue;
        await this.git.raw(["checkout", "-b", branch, "--track", ref]);
        return;
      } catch {
        /* try next remote */
      }
    }
    throw new Error("BRANCH_NOT_FOUND");
  }

  async listRemoteHeads(): Promise<
    Array<{ remote: string; name: string; lastCommitAt: string }>
  > {
    try {
      const out = await this.git.raw([
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)\t%(committerdate:iso-strict)",
        "refs/remotes",
      ]);
      const heads: Array<{ remote: string; name: string; lastCommitAt: string }> =
        [];
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tab = trimmed.indexOf("\t");
        const ref = tab < 0 ? trimmed : trimmed.slice(0, tab);
        const lastCommitAt =
          tab < 0 ? new Date(0).toISOString() : trimmed.slice(tab + 1);
        const slash = ref.indexOf("/");
        if (slash < 0) continue;
        const remote = ref.slice(0, slash);
        const name = ref.slice(slash + 1);
        if (!remote || !name || name === "HEAD") continue;
        heads.push({ remote, name, lastCommitAt });
      }
      return heads;
    } catch {
      return [];
    }
  }

  /**
   * HUD snapshot: local branch, remotes, ahead/behind vs a chosen remote,
   * dirty/conflicted. Does not fetch — remote counts use last-known refs.
   */
  async syncSnapshot(compareRemote?: string | null): Promise<{
    isRepo: boolean;
    localBranch: string | null;
    remoteBranch: string | null;
    hasRemote: boolean;
    remotes: string[];
    compareRemote: string | null;
    compareRef: string | null;
    ahead: number | null;
    behind: number | null;
    dirty: boolean;
    dirtyFileCount: number;
    stashCount: number;
    conflicted: string[];
  }> {
    const info = await this.branchInfo();
    if (!info.isRepo) {
      return {
        ...info,
        remotes: [],
        compareRemote: null,
        compareRef: null,
        ahead: null,
        behind: null,
        dirty: false,
        dirtyFileCount: 0,
        stashCount: 0,
        conflicted: [],
      };
    }
    const remotes = await this.listRemotes();
    const trackingRemote = info.remoteBranch?.includes("/")
      ? info.remoteBranch.slice(0, info.remoteBranch.indexOf("/"))
      : null;
    const picked =
      (compareRemote && remotes.includes(compareRemote) && compareRemote) ||
      (trackingRemote && remotes.includes(trackingRemote) && trackingRemote) ||
      remotes[0] ||
      null;
    const branch =
      info.localBranch && info.localBranch !== "detached HEAD"
        ? info.localBranch
        : null;
    const ab =
      picked && branch
        ? await this.aheadBehind(picked, branch)
        : { ahead: null, behind: null, compareRef: null };
    const dirty = await this.isDirty();
    const conflicted = await this.conflictedFiles();
    return {
      ...info,
      remotes,
      compareRemote: picked,
      compareRef: ab.compareRef,
      ahead: ab.ahead,
      behind: ab.behind,
      dirty,
      dirtyFileCount: dirty ? await this.dirtyFileCount() : 0,
      stashCount: await this.stashCount(),
      conflicted,
    };
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
