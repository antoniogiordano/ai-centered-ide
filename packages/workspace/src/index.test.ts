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

  it("patch replaces a unique substring", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir);
    fs.write("a.ts", "const x = 1;\nconst y = 2;\n");
    expect(fs.patch("a.ts", "const y = 2;", "const y = 3;")).toEqual({
      matches: 1,
    });
    expect(fs.read("a.ts")).toBe("const x = 1;\nconst y = 3;\n");
    rmSync(dir, { recursive: true });
  });

  it("patch rejects ambiguous search unless replaceAll", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir);
    fs.write("a.ts", "foo\nfoo\n");
    expect(() => fs.patch("a.ts", "foo", "bar")).toThrow(/matched 2 times/);
    expect(fs.patch("a.ts", "foo", "bar", { replaceAll: true })).toEqual({
      matches: 2,
    });
    expect(fs.read("a.ts")).toBe("bar\nbar\n");
    rmSync(dir, { recursive: true });
  });

  it("patch does not interpret $ in replace", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir);
    fs.write("a.ts", "price");
    fs.patch("a.ts", "price", "$1.00");
    expect(fs.read("a.ts")).toBe("$1.00");
    rmSync(dir, { recursive: true });
  });

  it("writeBinary writes attachment bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeBinary("shot.png", bytes);
    expect(existsSync(join(dir, "shot.png"))).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it("readWindow pages lines and reports nextStartLine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir);
    const body = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    fs.write("big.txt", body);

    const first = await fs.readWindow("big.txt", {
      startLine: 1,
      maxLines: 10,
    });
    expect(first.content.split("\n")).toHaveLength(10);
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(10);
    expect(first.truncated).toBe(true);
    expect(first.nextStartLine).toBe(11);
    expect(first.totalLines).toBe(40);

    const second = await fs.readWindow("big.txt", {
      startLine: 11,
      maxLines: 10,
    });
    expect(second.content.startsWith("line-11")).toBe(true);
    expect(second.endLine).toBe(20);

    const last = await fs.readWindow("big.txt", {
      startLine: 35,
      maxLines: 20,
    });
    expect(last.truncated).toBe(false);
    expect(last.nextStartLine).toBeNull();
    expect(last.endLine).toBe(40);

    rmSync(dir, { recursive: true });
  });

  it("readWindow streams files larger than maxReadBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-ws-"));
    const fs = new FilesystemService(dir, 2_000);
    // ~4KB of lines → above 2KB cap for full read(), but windowed stream works.
    const lines = Array.from({ length: 200 }, (_, i) => `row-${i + 1}-${"x".repeat(16)}`);
    writeFileSync(join(dir, "huge.txt"), lines.join("\n"), "utf8");

    expect(() => fs.read("huge.txt")).toThrow(/too large|startLine/i);

    const window = await fs.readWindow("huge.txt", {
      startLine: 50,
      maxLines: 5,
    });
    expect(window.content).toContain("row-50-");
    expect(window.startLine).toBe(50);
    expect(window.endLine).toBe(54);
    expect(window.truncated).toBe(true);
    expect(window.nextStartLine).toBe(55);
    // Streamed truncated windows skip a full line count.
    expect(window.totalLines).toBeNull();

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

  it("detects the cypress e2e command from a test:e2e script", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-arch-e2e-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "e2e-app",
        scripts: {
          test: "jest",
          "test:e2e":
            'start-server-and-test dev http://localhost:3000 "cypress run"',
        },
        devDependencies: { cypress: "^15.0.0", jest: "^29.0.0" },
      }),
    );
    mkdirSync(join(dir, "cypress"));

    const detected = detectArchitectureProfile(dir);
    expect(detected.testing?.e2e?.lib).toBe("cypress");
    expect(detected.testing?.e2e?.command).toBe("npm run test:e2e");
    expect(detected.testing?.e2e?.roots).toEqual(["cypress"]);
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
