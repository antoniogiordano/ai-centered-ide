import { describe, expect, it } from "vitest";
import {
  SessionStateSchema,
  validateIpcRequest,
  IPC_CHANNELS,
} from "./index.js";

describe("shared schemas", () => {
  it("validates session state", () => {
    const state = SessionStateSchema.parse({
      sessionId: "s1",
      sequence: 0,
      workspace: null,
      mode: "ask",
      turns: [],
      planSteps: [],
      pendingApprovals: [],
      approvalGrants: [],
      activeToolCallId: null,
      status: "idle",
      partialAssistantText: null,
      activityLabel: null,
      liveTools: [],
      error: null,
    });
    expect(state.sessionId).toBe("s1");
    expect(state.planPhases).toEqual([]);
    expect(state.planStatus).toBe("drafting");
    expect(state.testingConfirmedAt).toBeNull();
  });

  it("rejects invalid IPC payloads", () => {
    expect(() =>
      validateIpcRequest(IPC_CHANNELS.SESSION_SEND_MESSAGE, { content: "" }),
    ).toThrow();
  });
});
