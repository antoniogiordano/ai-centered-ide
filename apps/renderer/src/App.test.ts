import { describe, expect, it } from "vitest";
import { createEmptySessionState } from "@ai-ide/shared";
import {
  formatAheadBehind,
  orderStartBranches,
} from "./lib/gitBranches";

describe("renderer session view model", () => {
  it("starts idle", () => {
    expect(createEmptySessionState("r1").status).toBe("idle");
    expect(createEmptySessionState("r1").notices).toEqual([]);
  });
});

describe("git branch picker order", () => {
  it("puts main first so a feat-branch workspace can start a parallel chat", () => {
    const ordered = orderStartBranches(
      "feat/icons",
      [
        { name: "feat/icons" },
        { name: "main" },
        { name: "feat/old" },
      ],
      [{ name: "develop", remote: "origin" }],
    );
    expect(ordered.map((b) => b.name)).toEqual([
      "main",
      "feat/icons",
      "feat/old",
      "develop",
    ]);
    expect(ordered[0]?.label).toBe("main");
    expect(ordered[1]?.label).toBe("feat/icons (current)");
  });

  it("formats ahead/behind like Cursor", () => {
    expect(formatAheadBehind(2, 1)).toBe("2 ahead · 1 behind");
    expect(formatAheadBehind(0, 3)).toBe("3 behind");
    expect(formatAheadBehind(4, 0)).toBe("4 ahead");
    expect(formatAheadBehind(0, 0)).toBe("even");
    expect(formatAheadBehind(null, null)).toBe("no remote branch");
  });
});
