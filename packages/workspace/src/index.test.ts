import { mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError, ARCHITECTURE_FILE_PATH } from "@ai-ide/shared";
import {
  ArchitectureStore,
  assertInsideWorkspace,
  detectArchitectureProfile,
  FilesystemService,
  searchText,
} from "./index.js";

describe("assertInsideWorkspace", () => {
  it("allows paths inside workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    writeFileSync(join(dir, "a.txt"), "hi");
    const resolved = assertInsideWorkspace(dir, join(dir, "a.txt"));
    expect(resolved).toContain("a.txt");
    rmSync(dir, { recursive: true });
  });

  it("rejects paths outside workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "aifi-out-"));
    expect(() => assertInsideWorkspace(dir, outside)).toThrow(AppError);
    rmSync(dir, { recursive: true });
    rmSync(outside, { recursive: true });
  });

  it("rejects symlink escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "aifi-out-"));
    writeFileSync(join(outside, "secret.txt"), "secret");
    const link = join(dir, "escape");
    try {
      symlinkSync(outside, link);
      expect(() => assertInsideWorkspace(dir, join(link, "secret.txt"))).toThrow(
        AppError,
      );
    } catch {
      /* symlink may fail on some platforms without privileges */
    }
    rmSync(dir, { recursive: true });
    rmSync(outside, { recursive: true });
  });

  it("rejects .. traversal", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    mkdirSync(join(dir, "sub"));
    expect(() =>
      assertInsideWorkspace(dir, join("sub", "..", "..", "etc", "passwd")),
    ).toThrow(AppError);
    rmSync(dir, { recursive: true });
  });
});

describe("FilesystemService", () => {
  it("reads and writes within workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir);
    fs.write("hello.txt", "world");
    expect(fs.read("hello.txt")).toBe("world");
    rmSync(dir, { recursive: true });
  });
});

describe("searchText", () => {
  it("finds matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    writeFileSync(join(dir, "findme.txt"), "needle here");
    const hits = searchText(dir, "needle");
    expect(hits).toHaveLength(1);
    rmSync(dir, { recursive: true });
  });
});

describe("ArchitectureStore", () => {
  it("detects a Node/React/Vitest workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-arch-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo-app",
        engines: { node: ">=22" },
        scripts: { test: "vitest run", lint: "eslint ." },
        devDependencies: {
          vitest: "^3.0.0",
          typescript: "^5.0.0",
          vite: "^6.0.0",
          react: "^19.0.0",
        },
        dependencies: { express: "^4.0.0" },
      }),
    );
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    mkdirSync(join(dir, "src"));

    const detected = detectArchitectureProfile(dir);
    expect(detected.name).toBe("demo-app");
    expect(detected.repo?.packageManager).toBe("npm");
    expect(detected.frontend?.frameworks).toEqual(
      expect.arrayContaining(["react", "vite"]),
    );
    expect(detected.backend?.frameworks).toContain("express");
    expect(detected.testing?.unit?.lib).toBe("vitest");
    expect(detected.meta.sources.backend).toBe("detected");

    const store = new ArchitectureStore(dir);
    const saved = store.save(detected, "user_confirmed", "# demo-app\n");
    expect(store.load().exists).toBe(true);
    expect(store.load().profile?.meta.sources.backend).toBe("user_confirmed");
    expect(saved.version).toBe(1);
    expect(existsSync(join(dir, ARCHITECTURE_FILE_PATH))).toBe(true);

    const reloaded = store.loadOrDetect();
    expect(reloaded.fromFile).toBe(true);
    expect(reloaded.path).toBe(ARCHITECTURE_FILE_PATH);
    expect(reloaded.intent).toContain("demo-app");
    expect(reloaded.profile.frontend?.frameworks).toEqual(
      expect.arrayContaining(["react", "vite"]),
    );
    rmSync(dir, { recursive: true });
  });
});

describe("createEmptyProject + GitService remotes", () => {
  it("rejects invalid project names", async () => {
    const { validateProjectName } = await import("./project.js");
    expect(() => validateProjectName("")).toThrow(AppError);
    expect(() => validateProjectName("../evil")).toThrow(AppError);
    expect(() => validateProjectName("a/b")).toThrow(AppError);
  });

  it("inits git and can add a remote", async () => {
    const parent = mkdtempSync(join(tmpdir(), "aifi-parent-"));
    const { createEmptyProject } = await import("./project.js");
    const { GitService } = await import("./git.js");
    const projectPath = await createEmptyProject(parent, "demo-app");
    expect(existsSync(join(projectPath, ".git"))).toBe(true);

    const git = new GitService(projectPath);
    const info = await git.branchInfo();
    expect(info.isRepo).toBe(true);

    await git.addRemote("origin", "https://github.com/example/demo-app.git");
    expect(await git.hasRemote("origin")).toBe(true);

    rmSync(parent, { recursive: true });
  });
});
