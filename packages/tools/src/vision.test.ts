import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import { createDefaultRegistry } from "./builtins.js";
import type { ToolExecutionContext } from "./gateway.js";
import { discoverE2eScreenshots } from "./test-artifacts.js";
import { sniffImageMime } from "./vision.js";

/** Smallest valid-enough PNG: the magic bytes are what the sniffer reads. */
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngBytes(payload = "pixels"): Buffer {
  return Buffer.concat([PNG_HEADER, Buffer.from(payload)]);
}

function makeCtx(dir: string): ToolExecutionContext {
  return {
    workspaceRoot: dir,
    mode: "agent" as const,
    grants: [],
    fs: new FilesystemService(dir),
    git: new GitService(dir),
    checkpoint: new CheckpointService(dir, join(dir, ".checkpoints")),
    audit: () => undefined,
    redact: (v: unknown) => v,
    approvedCategories: new Set(),
  } satisfies ToolExecutionContext;
}

describe("sniffImageMime", () => {
  it("trusts magic bytes over a misleading extension", () => {
    expect(sniffImageMime(pngBytes(), "shot.jpg")).toBe("image/png");
  });

  it("falls back to the extension when bytes are inconclusive", () => {
    expect(sniffImageMime(Buffer.from("not an image"), "a.webp")).toBe(
      "image/webp",
    );
    expect(sniffImageMime(Buffer.from("not an image"), "a.txt")).toBeNull();
  });
});

describe("read_image", () => {
  it("returns image bytes for the model to look at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-img-"));
    mkdirSync(join(dir, "cypress/screenshots"), { recursive: true });
    writeFileSync(join(dir, "cypress/screenshots/fail.png"), pngBytes());

    const tool = createDefaultRegistry().get("read_image");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { path: "cypress/screenshots/fail.png", reason: "why the click failed" },
      makeCtx(dir),
    );

    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mime).toBe("image/png");
    expect(result.images?.[0]?.label).toBe("fail.png");
    expect(result.images?.[0]?.dataBase64).toBe(pngBytes().toString("base64"));
    rmSync(dir, { recursive: true });
  });

  it("refuses non-image files instead of returning garbage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-img-"));
    writeFileSync(join(dir, "notes.txt"), "plain text");

    const tool = createDefaultRegistry().get("read_image");
    const result = await tool!.execute({ path: "notes.txt" }, makeCtx(dir));

    expect(result.images).toBeUndefined();
    expect(result.summary).toContain("Not a viewable image");
    rmSync(dir, { recursive: true });
  });

  it("is exposed in every phase", () => {
    const tool = createDefaultRegistry().get("read_image");
    expect(tool?.phases).toEqual([
      "planning",
      "checking",
      "building",
      "testing",
    ]);
    expect(tool?.riskLevel).toBe("safe");
  });
});

describe("discoverE2eScreenshots", () => {
  it("finds fresh Cypress screenshots and ignores stale ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-shots-"));
    const shots = join(dir, "cypress/screenshots/spec.cy.ts");
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "fresh.png"), pngBytes("fresh"));
    writeFileSync(join(shots, "stale.png"), pngBytes("stale"));
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(join(shots, "stale.png"), old, old);

    const found = discoverE2eScreenshots({
      workspaceRoot: dir,
      sinceMs: Date.now() - 60_000,
    });

    expect(found.map((f) => f.path)).toEqual([
      "cypress/screenshots/spec.cy.ts/fresh.png",
    ]);
    expect(found[0]?.mime).toBe("image/png");
    rmSync(dir, { recursive: true });
  });

  it("returns nothing when no e2e directory exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-shots-"));
    expect(
      discoverE2eScreenshots({ workspaceRoot: dir, sinceMs: 0 }),
    ).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  it("caps how many screenshots reach the prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-shots-"));
    const shots = join(dir, "test-results");
    mkdirSync(shots, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      writeFileSync(join(shots, `shot-${i}.png`), pngBytes(String(i)));
    }

    const found = discoverE2eScreenshots({
      workspaceRoot: dir,
      sinceMs: Date.now() - 60_000,
      maxImages: 2,
    });

    expect(found).toHaveLength(2);
    rmSync(dir, { recursive: true });
  });
});
