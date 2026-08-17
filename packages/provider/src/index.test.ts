import { describe, expect, it } from "vitest";
import { AppError } from "@ai-ide/shared";
import {
  MockProvider,
  parseSseDataLines,
  requiresReasoningEffortNoneWithTools,
  extractContextWindowTokens,
  parseModelListEntry,
} from "./index.js";
import {
  assertHttpsForRemote,
  classifyProviderError,
  isRetryable,
} from "./types.js";

describe("provider", () => {
  it("parses SSE data lines", () => {
    const lines = parseSseDataLines(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n',
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toHaveProperty("choices");
  });

  it("streams mock content", async () => {
    const provider = new MockProvider({
      name: "test",
      steps: [{ type: "content", text: "ok" }],
    });
    const chunks = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.type === "content" && c.delta === "ok")).toBe(true);
  });

  it("requires HTTPS for remote hosts", () => {
    expect(() => assertHttpsForRemote("http://api.example.com/v1")).toThrow(AppError);
    expect(() => assertHttpsForRemote("http://localhost:8080/v1")).not.toThrow();
  });

  it("classifies retryable errors", () => {
    expect(isRetryable(classifyProviderError(new Error("HTTP 429")))).toBe(true);
    expect(isRetryable(classifyProviderError(new Error("HTTP 401")))).toBe(false);
  });

  it("flags gpt-5 / luna models for reasoning_effort none with tools", () => {
    expect(requiresReasoningEffortNoneWithTools("gpt-5.6-luna")).toBe(true);
    expect(requiresReasoningEffortNoneWithTools("gpt-5.2")).toBe(true);
    expect(requiresReasoningEffortNoneWithTools("o3-mini")).toBe(true);
    expect(requiresReasoningEffortNoneWithTools("gpt-4o-mini")).toBe(false);
  });

  it("applies DeepSeek thinking fields and skips gpt-5 none when thinking on", async () => {
    const { applyProviderThinkingFields, toOpenAiMessage } = await import(
      "./openai.js"
    );
    const withThinking: Record<string, unknown> = {};
    applyProviderThinkingFields(withThinking, {
      thinking: true,
      reasoningEffort: "max",
      model: "deepseek-reasoner",
      hasTools: true,
    });
    expect(withThinking).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });

    const gpt5Tools: Record<string, unknown> = {};
    applyProviderThinkingFields(gpt5Tools, {
      thinking: false,
      model: "gpt-5.2",
      hasTools: true,
    });
    expect(gpt5Tools.reasoning_effort).toBe("none");

    const gpt5Thinking: Record<string, unknown> = {};
    applyProviderThinkingFields(gpt5Thinking, {
      thinking: true,
      reasoningEffort: "high",
      model: "gpt-5.2",
      hasTools: true,
    });
    expect(gpt5Thinking.reasoning_effort).toBe("high");
    expect(gpt5Thinking.thinking).toEqual({ type: "enabled" });

    expect(
      toOpenAiMessage({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", name: "read_file", arguments: "{}" }],
        reasoning_content: "step by step",
      }),
    ).toMatchObject({
      role: "assistant",
      reasoning_content: "step by step",
    });
  });
});

describe("vision fallback helpers", () => {
  it("detects vision messages and flattens to text", async () => {
    const { messagesHaveVision, flattenVisionToText, isVisionUnsupportedError } =
      await import("./openai.js");
    const messages = [
      { role: "system" as const, content: "sys" },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "see this" },
          {
            type: "image_url" as const,
            image_url: { url: "data:image/png;base64,xx" },
          },
        ],
      },
    ];
    expect(messagesHaveVision(messages)).toBe(true);
    const flat = flattenVisionToText(messages);
    expect(flat[1]?.role).toBe("user");
    expect(typeof flat[1]?.content).toBe("string");
    expect(String(flat[1]?.content)).toContain("see this");
    expect(String(flat[1]?.content)).toContain("import_attachment");
    expect(
      isVisionUnsupportedError(
        400,
        'unknown variant `image_url`, expected `text`',
      ),
    ).toBe(true);
  });

  it("extracts context_length from heterogeneous /models entries", () => {
    expect(
      extractContextWindowTokens({ context_length: 128_000 }),
    ).toBe(128_000);
    expect(
      extractContextWindowTokens({
        meta: { context_length: 65_536 },
      }),
    ).toBe(65_536);
    expect(
      extractContextWindowTokens({ max_model_len: 32_768 }),
    ).toBe(32_768);
    expect(
      extractContextWindowTokens({
        architecture: { context_length: 200_000 },
      }),
    ).toBe(200_000);
    // Small max_tokens is treated as completion cap, not window.
    expect(extractContextWindowTokens({ max_tokens: 4096 })).toBeUndefined();
    expect(extractContextWindowTokens({ max_tokens: 32_768 })).toBe(32_768);

    const parsed = parseModelListEntry({
      id: "deepseek-chat",
      context_length: 128000,
    });
    expect(parsed).toEqual({
      id: "deepseek-chat",
      contextWindowTokens: 128000,
    });
  });
});
