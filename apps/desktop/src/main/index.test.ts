import { describe, expect, it } from "vitest";
import { createEmptySessionState } from "@ai-ide/shared";

describe("desktop session contract", () => {
  it("uses shared session shape", () => {
    const state = createEmptySessionState("desktop-test");
    expect(state.status).toBe("idle");
  });
});
