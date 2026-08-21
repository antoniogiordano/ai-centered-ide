import { describe, expect, it } from "vitest";
import {
  SessionStateSchema,
  validateIpcRequest,
  IPC_CHANNELS,
  ProviderFetchPricingProgressSchema,
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
    expect(state.contextSummary).toBeNull();
    expect(state.contextCompactionCount).toBe(0);
    expect(state.agentHistoryPath).toBeNull();
    expect(state.notices).toEqual([]);
  });

  it("accepts a drafted git stash or commit message", () => {
    const stash = validateIpcRequest(IPC_CHANNELS.SESSION_DRAFT_GIT_MESSAGE, {
      kind: "stash",
    });
    expect(stash.kind).toBe("stash");
    const commit = validateIpcRequest(IPC_CHANNELS.WORKSPACE_GIT_COMMIT, {
      message: "feat: switch the header selects",
    });
    expect(commit.message).toContain("header");
  });

  it("accepts dismissing a session notice", () => {
    const req = validateIpcRequest(IPC_CHANNELS.SESSION_DISMISS_NOTICE, {
      noticeId: "harness:vision-downgrade",
    });
    expect(req.noticeId).toBe("harness:vision-downgrade");
  });

  it("rejects invalid IPC payloads", () => {
    expect(() =>
      validateIpcRequest(IPC_CHANNELS.SESSION_SEND_MESSAGE, { content: "" }),
    ).toThrow();
  });

  it("accepts a new session starting on a branch", () => {
    const req = validateIpcRequest(IPC_CHANNELS.SESSION_CREATE, {
      branch: "main",
      dirtyStrategy: "stash",
    });
    expect(req.branch).toBe("main");
    expect(req.dirtyStrategy).toBe("stash");
  });

  it("accepts git pull/push/checkout payloads", () => {
    const checkout = validateIpcRequest(IPC_CHANNELS.WORKSPACE_GIT_CHECKOUT, {
      branch: "main",
      dirtyStrategy: "force",
    });
    expect(checkout.branch).toBe("main");
    expect(
      validateIpcRequest(IPC_CHANNELS.WORKSPACE_GIT_PULL, { remote: "origin" })
        .remote,
    ).toBe("origin");
    expect(
      validateIpcRequest(IPC_CHANNELS.WORKSPACE_GIT_SET_REMOTE, {
        remote: "upstream",
      }).remote,
    ).toBe("upstream");
  });

  it("accepts attachment-only send messages", () => {
    const req = validateIpcRequest(IPC_CHANNELS.SESSION_SEND_MESSAGE, {
      content: "",
      attachments: [
        {
          id: "a1",
          kind: "image",
          name: "shot.png",
          mime: "image/png",
          dataBase64: "YWJj",
        },
      ],
    });
    expect(req.attachments?.[0]?.id).toBe("a1");
  });

  it("accepts a pricing fetch with an explicit lookup model", () => {
    const req = validateIpcRequest(IPC_CHANNELS.PROVIDER_FETCH_PRICING, {
      lookupProviderId: "prov-1",
      lookupModel: "deepseek-v4-pro",
      target: { baseUrl: "https://api.deepseek.com/v1" },
    });
    expect(req.lookupProviderId).toBe("prov-1");
    expect(req.lookupModel).toBe("deepseek-v4-pro");
  });
});

describe("pricing fetch progress", () => {
  it("accepts a per-model catalog delta", () => {
    const ev = ProviderFetchPricingProgressSchema.parse({
      message: "Model 1/2: gpt-4o",
      at: new Date().toISOString(),
      modelId: "gpt-4o",
      index: 1,
      total: 2,
      models: [{ id: "gpt-4o", vision: true, tools: true, source: "fetched" }],
      pricing: { byModel: { "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 } } },
    });
    expect(ev.models?.[0]?.id).toBe("gpt-4o");
    expect(ev.pricing?.byModel?.["gpt-4o"]?.inputPer1M).toBe(2.5);
  });
});
