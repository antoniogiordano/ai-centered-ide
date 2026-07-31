import { describe, expect, it } from "vitest";
import { createEmptySessionState } from "@ai-ide/shared";

describe("renderer session view model", () => {
  it("starts idle", () => {
    expect(createEmptySessionState("r1").status).toBe("idle");
  });
});
