import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInsideWorkspace, FilesystemService, CheckpointService } from "./index.js";

describe("threat model: workspace perimeter", () => {
  it("rejects path traversal and absolute escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    expect(() => assertInsideWorkspace(root, "../outside")).toThrow();
    expect(() => assertInsideWorkspace(root, "/etc/passwd")).toThrow();
  });

  it("rejects symlink that escapes the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const outside = mkdtempSync(join(tmpdir(), "out-"));
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      // Some CI environments disallow symlinks — skip
      return;
    }
    expect(() => assertInsideWorkspace(root, "link.txt")).toThrow();
  });

  it("never checkpoints .env files", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    const store = mkdtempSync(join(tmpdir(), "cp-"));
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, "ok.txt"), "ok");
    const cp = new CheckpointService(root, store);
    const record = cp.create("c1", [".env", "ok.txt"]);
    expect(record.paths).toEqual(["ok.txt"]);
    expect(record.paths).not.toContain(".env");
  });

  it("filesystem write stays inside workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(root, "src"));
    const fs = new FilesystemService(root);
    fs.write("src/a.ts", "export {}");
    expect(() => fs.write("../escape.ts", "nope")).toThrow();
  });
});
