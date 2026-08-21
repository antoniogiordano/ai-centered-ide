import { describe, expect, it } from "vitest";
import {
  AiSdkProvider,
  resolveReasoning,
  toChatUsage,
  toFinishReason,
  toPrompt,
} from "./ai-sdk.js";
import type { ChatChunk, ChatMessage } from "./types.js";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

type Recorded = { url: string; headers: Record<string, string>; body: unknown };

function recordingFetch(responses: Array<() => Response>): {
  fetch: typeof globalThis.fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

async function collect(
  iterable: AsyncIterable<ChatChunk>,
): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":7}}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ciao"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

describe("reasoning mapping", () => {
  it("maps the IDE thinking settings onto the portable scale", () => {
    expect(
      resolveReasoning({ thinking: true, reasoningEffort: "max", model: "any", hasTools: true }),
    ).toBe("xhigh");
    expect(
      resolveReasoning({ thinking: true, reasoningEffort: "low", model: "any", hasTools: false }),
    ).toBe("low");
    // Thinking off leaves the provider default alone…
    expect(
      resolveReasoning({ thinking: false, model: "claude-opus-4-5", hasTools: true }),
    ).toBe("provider-default");
    // …except for the models that reject tools while reasoning.
    expect(
      resolveReasoning({ thinking: false, model: "gpt-5.2", hasTools: true }),
    ).toBe("none");
  });

  it("maps finish reasons and usage", () => {
    expect(toFinishReason("tool-calls")).toBe("tool_calls");
    expect(toFinishReason("stop")).toBe("stop");
    expect(
      toChatUsage({
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 3, noCacheTokens: 10 },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      }),
    ).toEqual({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 7 });
  });
});

describe("prompt conversion", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", name: "read_image", arguments: '{"path":"a.png"}' }],
      reasoning_content: "thinking",
    },
    {
      role: "tool",
      tool_call_id: "c1",
      content: "read ok",
      images: [{ mime: "image/png", dataBase64: "AAA", label: "a.png" }],
    },
  ];

  it("hoists system messages out of the message list", () => {
    const { instructions, messages: converted } = toPrompt(messages, {
      nativeToolImages: true,
    });
    expect(instructions).toEqual([{ role: "system", content: "sys" }]);
    expect(converted.some((m) => m.role === "system")).toBe(false);
  });

  it("names tool results after the call that produced them", () => {
    const { messages: converted } = toPrompt(messages, { nativeToolImages: true });
    const toolMessage = converted.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_image" }],
    });
  });

  it("puts tool images in the tool result when the provider takes them", () => {
    const { messages: converted } = toPrompt(messages, { nativeToolImages: true });
    const toolMessage = converted.find((m) => m.role === "tool");
    const output = (toolMessage?.content as Array<{ output: unknown }>)[0]?.output;
    expect(output).toMatchObject({ type: "content" });
    // No synthetic user message is needed in this case.
    expect(converted.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("falls back to a synthetic user message when it cannot", () => {
    const { messages: converted } = toPrompt(messages, { nativeToolImages: false });
    const toolMessage = converted.find((m) => m.role === "tool");
    const output = (toolMessage?.content as Array<{ output: unknown }>)[0]?.output;
    expect(output).toMatchObject({ type: "text", value: "read ok" });
    const users = converted.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(JSON.stringify(users[1]?.content)).toContain("image");
  });

  it("keeps DeepSeek reasoning on the assistant turn", () => {
    const { messages: converted } = toPrompt(messages, { nativeToolImages: false });
    const assistant = converted.find((m) => m.role === "assistant");
    expect(assistant?.content).toMatchObject([
      { type: "reasoning", text: "thinking" },
      { type: "tool-call", toolName: "read_image" },
    ]);
  });
});

describe("AiSdkProvider streaming", () => {
  it("streams Anthropic text and reports cache reads", async () => {
    const { fetch, calls } = recordingFetch([() => sseResponse(ANTHROPIC_STREAM)]);
    const provider = new AiSdkProvider({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-x",
      defaultModel: "claude-opus-4-5",
      fetch,
    });

    const chunks = await collect(
      provider.chat([
        { role: "system", content: "sys" },
        { role: "user", content: "ciao" },
      ]),
    );

    expect(chunks).toEqual([
      { type: "content", delta: "ciao" },
      {
        type: "done",
        finishReason: "stop",
        // Anthropic reports cache reads separately; the SDK folds them into
        // inputTokens, which is what the cost estimator expects.
        usage: { inputTokens: 17, outputTokens: 4, cachedInputTokens: 7 },
      },
    ]);
    // The SDK sends the key the way Anthropic wants it, not as a bearer token.
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant-x");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.url).toContain("/v1/messages");
  });

  it("pins the Anthropic preamble for an hour and lets the history cache itself", async () => {
    const { fetch, calls } = recordingFetch([() => sseResponse(ANTHROPIC_STREAM)]);
    const provider = new AiSdkProvider({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-x",
      defaultModel: "claude-opus-4-5",
      fetch,
    });

    await collect(
      provider.chat([
        { role: "system", content: "sys" },
        { role: "user", content: "ciao" },
      ]),
    );

    const body = calls[0]?.body as {
      cache_control?: unknown;
      system?: Array<{ cache_control?: unknown }>;
      messages?: Array<{ content: Array<{ cache_control?: unknown }> }>;
    };
    // Tool definitions precede the system block, so one breakpoint here covers
    // the whole fixed preamble for the rest of the session.
    expect(body.system?.at(-1)?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    // The tail is left to automatic caching: a top-level breakpoint the API
    // advances on its own, at the cheaper write rate it is rewritten at.
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
    expect(body.messages?.at(-1)?.content.at(-1)?.cache_control).toBeUndefined();
  });

  it("leaves cache breakpoints off other transports", async () => {
    const { fetch, calls } = recordingFetch([
      () =>
        sseResponse([
          `data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n`,
          `data: [DONE]\n\n`,
        ]),
    ]);
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      defaultModel: "m",
      fetch,
    });

    await collect(provider.chat([{ role: "user", content: "ciao" }]));
    expect(JSON.stringify(calls[0]?.body)).not.toContain("cache_control");
  });

  it("streams tool call arguments from an OpenAI-compatible endpoint", async () => {
    const stream = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.ts\\"}"}}]}}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const { fetch, calls } = recordingFetch([() => sseResponse(stream)]);
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      defaultModel: "some-model",
      fetch,
    });

    const chunks = await collect(
      provider.chat([{ role: "user", content: "read a.ts" }], {
        tools: [
          {
            name: "read_file",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
    );

    const toolChunks = chunks.filter((c) => c.type === "tool_call");
    expect(toolChunks.every((c) => c.type === "tool_call" && c.index === 0)).toBe(true);
    const args = toolChunks
      .map((c) => (c.type === "tool_call" ? c.argumentsDelta : ""))
      .join("");
    expect(JSON.parse(args)).toEqual({ path: "a.ts" });
    expect(chunks.at(-1)).toEqual({
      type: "done",
      finishReason: "tool_calls",
      usage: { inputTokens: 11, outputTokens: 3 },
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-x");
    // Tools keep the OpenAI function shape on this transport.
    expect(calls[0]?.body).toMatchObject({
      tools: [{ type: "function", function: { name: "read_file" } }],
      // Without this an OpenAI-style stream reports no tokens at all and cost
      // estimates silently read zero.
      stream_options: { include_usage: true },
    });
  });

  it("surfaces DeepSeek reasoning as reasoning chunks", async () => {
    const stream = [
      `data: {"id":"1","choices":[{"index":0,"delta":{"reasoning_content":"penso"}}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"ecco"}}]}\n\n`,
      `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2,"prompt_cache_hit_tokens":6}}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const { fetch } = recordingFetch([() => sseResponse(stream)]);
    const provider = new AiSdkProvider({
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-d",
      defaultModel: "deepseek-reasoner",
      thinking: true,
      reasoningEffort: "high",
      fetch,
    });

    const chunks = await collect(
      provider.chat([{ role: "user", content: "ciao" }]),
    );

    expect(chunks).toEqual([
      { type: "reasoning", delta: "penso" },
      { type: "content", delta: "ecco" },
      {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 9, outputTokens: 2, cachedInputTokens: 6 },
      },
    ]);
  });

  it("retries without images when the endpoint rejects them", async () => {
    const rejection = () =>
      new Response(
        JSON.stringify({
          error: { message: "unknown variant `image_url`, expected `text`" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const success = () =>
      sseResponse([
        `data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n`,
        `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    const { fetch, calls } = recordingFetch([rejection, success]);
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      defaultModel: "blind-model",
      fetch,
    });

    const chunks = await collect(
      provider.chat([
        {
          role: "user",
          content: [
            { type: "text", text: "guarda" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ]),
    );

    expect(chunks.some((c) => c.type === "content" && c.delta === "ok")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]?.body)).toContain("image_url");
    const retried = JSON.stringify(calls[1]?.body);
    expect(retried).not.toContain("image_url");
    expect(retried).toContain("cannot view images");

    // The human must be able to tell "the model would not look" from "the IDE
    // never sent the pixels", so the downgrade is reported exactly once.
    const downgrade = provider.takeVisionDowngrade();
    expect(downgrade?.model).toBe("blind-model");
    expect(downgrade?.detail).toContain("image_url");
    expect(provider.takeVisionDowngrade()).toBeNull();
  });

  it("keeps the rejection on the model that rejected, not the endpoint", async () => {
    const rejection = () =>
      new Response(
        JSON.stringify({
          error: { message: "unknown variant `image_url`, expected `text`" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const success = () =>
      sseResponse([
        `data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n`,
        `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]);
    const { fetch, calls } = recordingFetch([
      rejection,
      success,
      success,
      success,
    ]);
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      defaultModel: "blind-model",
      fetch,
    });
    const shot = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "guarda" },
          {
            type: "image_url" as const,
            image_url: { url: "data:image/png;base64,AAA" },
          },
        ],
      },
    ];

    await collect(provider.chat(shot));
    provider.takeVisionDowngrade();

    // Same endpoint, different model: it never refused anything, so it gets the
    // pixels instead of inheriting a sibling's limitation.
    await collect(provider.chat(shot, { model: "sighted-model" }));
    expect(JSON.stringify(calls[2]?.body)).toContain("image_url");
    expect(provider.takeVisionDowngrade()).toBeNull();

    // The model that did refuse is not asked again.
    await collect(provider.chat(shot, { model: "blind-model" }));
    expect(JSON.stringify(calls[3]?.body)).not.toContain("image_url");
    expect(provider.takeVisionDowngrade()?.model).toBe("blind-model");
  });

  it("accepts a tool batch where an early result carries images", async () => {
    // Regression: the SDK validates that every tool call of a batch is answered
    // before the next user message, so hoisting the pixels straight after the
    // first tool result made the whole turn fail with MissingToolResultsError.
    const { fetch, calls } = recordingFetch([
      () =>
        sseResponse([
          `data: {"id":"1","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n`,
          `data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
          `data: [DONE]\n\n`,
        ]),
    ]);
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      defaultModel: "m",
      fetch,
    });

    const chunks = await collect(
      provider.chat([
        { role: "user", content: "why did the e2e run fail?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_01", name: "read_image", arguments: "{}" },
            { id: "call_02", name: "read_file", arguments: "{}" },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_01",
          content: "shot.png",
          images: [{ mime: "image/png", dataBase64: "AAA", label: "shot.png" }],
        },
        { role: "tool", tool_call_id: "call_02", content: "spec.ts" },
      ]),
    );

    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(chunks.some((c) => c.type === "content" && c.delta === "ok")).toBe(
      true,
    );
    const body = calls[0]?.body as { messages: Array<{ role: string }> };
    expect(body.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
  });

  it("reports provider errors instead of throwing", async () => {
    const { fetch } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({
            error: { message: "Invalid bearer token", type: "authentication_error" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    ]);
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-bad",
      defaultModel: "m",
      fetch,
    });

    const chunks = await collect(
      provider.chat([{ role: "user", content: "ciao" }]),
    );
    const error = chunks.find((c) => c.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.error.userMessage).toContain("401");
      expect(error.error.userMessage).toContain("Invalid bearer token");
    }
  });

  it("surfaces a thrown object instead of [object Object]", async () => {
    const fetchImpl = (async () => {
      throw {
        statusCode: 429,
        responseBody: JSON.stringify({
          error: { message: "Rate limited, retry later" },
        }),
      };
    }) as typeof globalThis.fetch;
    const provider = new AiSdkProvider({
      kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
      defaultModel: "m",
      fetch: fetchImpl,
    });
    const chunks = await collect(
      provider.chat([{ role: "user", content: "ciao" }]),
    );
    const error = chunks.find((c) => c.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.error.userMessage).not.toContain("[object Object]");
      expect(error.error.technicalDetail).not.toBe("[object Object]");
      expect(
        `${error.error.userMessage} ${error.error.technicalDetail}`,
      ).toMatch(/429|Rate limited/i);
    }
  });

  it("lists models over plain HTTP with the host's auth header", async () => {
    const { fetch, calls } = recordingFetch([
      () =>
        new Response(
          JSON.stringify({ data: [{ id: "claude-opus-4-5" }, { id: "claude-haiku-4-5" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]);
    const provider = new AiSdkProvider({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-x",
      fetch,
    });

    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual(["claude-opus-4-5", "claude-haiku-4-5"]);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant-x");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });
});
