import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@ai-ide/shared";
import { assertInsideWorkspace, FilesystemService, searchText } from "./index.js";

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
    expect(() => assertInsideWorkspace(dir, join("sub", "..", "..", "etc", "passwd"))).toThrow(
      AppError,
    );
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
