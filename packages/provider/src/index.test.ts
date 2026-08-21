import { describe, expect, it } from "vitest";
import { AppError, isAnthropicHost } from "@ai-ide/shared";
import {
  ANTHROPIC_VERSION,
  authHeadersFor,
  MockProvider,
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
});

describe("anthropic auth", () => {
  it("sends x-api-key instead of Bearer for anthropic hosts", () => {
    expect(isAnthropicHost("https://api.anthropic.com/v1")).toBe(true);
    expect(isAnthropicHost("https://api.openai.com/v1")).toBe(false);
    // A lookalike host must not receive the key in Anthropic's shape.
    expect(isAnthropicHost("https://anthropic.com.evil.test/v1")).toBe(false);

    expect(authHeadersFor("https://api.anthropic.com/v1", "sk-ant-x")).toEqual({
      "x-api-key": "sk-ant-x",
      "anthropic-version": ANTHROPIC_VERSION,
    });
    expect(authHeadersFor("https://api.openai.com/v1", "sk-x")).toEqual({
      Authorization: "Bearer sk-x",
    });
    expect(authHeadersFor("http://localhost:11434/v1", "  ")).toEqual({});
  });
});

describe("vision fallback helpers", () => {
  it("detects vision messages and flattens to text", async () => {
    const { messagesHaveVision, flattenVisionToText, isVisionUnsupportedError } =
      await import("./wire.js");
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

  it("maps llama.cpp / LM Studio n_keep overflow to a clear user message", async () => {
    const {
      isContextOverflowError,
      formatHttpUserMessage,
      CONTEXT_OVERFLOW_USER_MESSAGE,
    } = await import("./wire.js");
    const lmStudio =
      "The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input.";
    expect(isContextOverflowError(lmStudio)).toBe(true);
    expect(isContextOverflowError("HTTP 400: n_keep exceeds context")).toBe(
      true,
    );
    expect(isContextOverflowError("rate limited, try later")).toBe(false);
    expect(formatHttpUserMessage(400, lmStudio)).toBe(
      CONTEXT_OVERFLOW_USER_MESSAGE,
    );
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
    expect(
      extractContextWindowTokens({ max_context_length: 4_096 }),
    ).toBe(4_096);
    expect(
      extractContextWindowTokens({ loaded_context_length: 8_192 }),
    ).toBe(8_192);

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
