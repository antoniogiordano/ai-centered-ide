import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";
import { GitService } from "./git.js";

async function initRepo(dir: string): Promise<void> {
  const git = simpleGit({ baseDir: dir });
  await git.init(["-b", "main"]);
  await git.addConfig("user.name", "AICI Test");
  await git.addConfig("user.email", "aici@example.test");
  writeFileSync(join(dir, "readme.md"), "hello\n");
  await git.add(".");
  await git.commit("init");
}

describe("GitService sync / checkout / pull", () => {
  it("reports ahead/behind vs a chosen remote and checks out another branch", async () => {
    const parent = mkdtempSync(join(tmpdir(), "aici-git-sync-"));
    const repo = join(parent, "repo");
    const bare = join(parent, "origin.git");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo);

    await initRepo(repo);
    const setup = simpleGit({ baseDir: repo });
    await setup.raw(["clone", "--bare", repo, bare]);
    await setup.addRemote("origin", bare);
    await setup.push(["-u", "origin", "main"]);

    await setup.checkoutLocalBranch("feat/icons");
    writeFileSync(join(repo, "readme.md"), "hello\nfeat\n");
    await setup.add(".");
    await setup.commit("feat work");
    await setup.push(["-u", "origin", "feat/icons"]);
    writeFileSync(join(repo, "readme.md"), "hello\nfeat\nmore\n");
    await setup.add(".");
    await setup.commit("local only");

    const git = new GitService(repo);
    const snap = await git.syncSnapshot("origin");
    expect(snap.isRepo).toBe(true);
    expect(snap.localBranch).toBe("feat/icons");
    expect(snap.remotes).toEqual(["origin"]);
    expect(snap.compareRemote).toBe("origin");
    expect(snap.compareRef).toBe("origin/feat/icons");
    expect(snap.ahead).toBe(1);
    expect(snap.behind).toBe(0);

    await git.checkoutBranch("main");
    const after = await git.syncSnapshot("origin");
    expect(after.localBranch).toBe("main");
    expect(after.ahead).toBe(0);
    expect(after.behind).toBe(0);

    rmSync(parent, { recursive: true });
  });

  it("stashes dirty work before checkout and pull reports conflicts", async () => {
    const parent = mkdtempSync(join(tmpdir(), "aici-git-pull-"));
    const repo = join(parent, "repo");
    const other = join(parent, "other");
    const bare = join(parent, "origin.git");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo);

    await initRepo(repo);
    const setup = simpleGit({ baseDir: repo });
    await setup.raw(["clone", "--bare", repo, bare]);
    await setup.addRemote("origin", bare);
    await setup.push(["-u", "origin", "main"]);
    await setup.checkoutLocalBranch("feat/dirty");

    writeFileSync(join(repo, "readme.md"), "local dirty\n");
    const git = new GitService(repo);
    expect(await git.isDirty()).toBe(true);
    await expect(git.checkoutBranch("main")).rejects.toThrow(
      "DIRTY_STRATEGY_REQUIRED",
    );
    await git.checkoutBranch("main", "stash");
    expect(await git.isDirty()).toBe(false);

    await setup.raw(["clone", bare, other]);
    const sibling = simpleGit({ baseDir: other });
    await sibling.addConfig("user.name", "AICI Test");
    await sibling.addConfig("user.email", "aici@example.test");
    writeFileSync(join(other, "readme.md"), "remote change\n");
    await sibling.add(".");
    await sibling.commit("remote");
    await sibling.push("origin", "main");

    writeFileSync(join(repo, "readme.md"), "local change\n");
    await setup.add(".");
    await setup.commit("local");

    const pulled = await git.pullFrom("origin");
    expect(pulled.ok).toBe(false);
    expect(pulled.conflicted).toContain("readme.md");

    rmSync(parent, { recursive: true });
  });

  it("stashes, lists, pops, and commits the worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-git-wt-"));
    await initRepo(dir);
    const git = new GitService(dir);
    writeFileSync(join(dir, "readme.md"), "hello\ndirty\n");
    writeFileSync(join(dir, "extra.txt"), "untracked\n");
    expect(await git.isDirty()).toBe(true);
    expect((await git.listDirtyFiles()).sort()).toEqual(["extra.txt", "readme.md"]);

    await git.stashPush("wip: local edits");
    expect(await git.isDirty()).toBe(false);
    const stashes = await git.listStashes();
    expect(stashes[0]?.message).toContain("wip: local edits");
    expect(await git.stashCount()).toBe(1);

    await git.stashPop(0);
    expect(await git.isDirty()).toBe(true);

    const committed = await git.commitWorktree("chore: park the extras");
    expect(committed.files).toEqual(expect.arrayContaining(["extra.txt", "readme.md"]));
    expect(await git.isDirty()).toBe(false);
    expect((await git.listStashes()).length).toBe(0);

    rmSync(dir, { recursive: true });
  });
});
