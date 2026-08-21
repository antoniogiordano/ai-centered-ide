/**
 * The single transport the IDE uses to talk to models, built on the Vercel AI
 * SDK. One `AiProvider` implementation covers every endpoint; the `kind` on the
 * saved provider decides which SDK provider is instantiated, and that choice
 * carries the auth header, the tool schema shape, how reasoning is expressed on
 * the wire, and whether prompt caching is available.
 *
 * Model discovery is deliberately not delegated: the SDK has no listing API for
 * arbitrary endpoints, so `listModels` stays a plain request against
 * `/v1/models` and reuses the header and parsing helpers in `openai.ts`.
 */
import {
  APICallError,
  jsonSchema,
  streamText,
  tool,
  type FinishReason,
  type JSONSchema7,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type ToolResultPart,
  type ToolSet,
  type UserContent,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  AppError,
  stringifyUnknownError,
  type ProviderKind,
  type ToolResultImage,
} from "@ai-ide/shared";
import {
  authHeadersFor,
  CONTEXT_OVERFLOW_USER_MESSAGE,
  flattenVisionToText,
  formatHttpUserMessage,
  isContextOverflowError,
  isVisionUnsupportedError,
  messagesHaveVision,
  parseModelListBody,
  requiresReasoningEffortNoneWithTools,
  type ReasoningEffort,
} from "./wire.js";
import {
  assertHttpsForRemote,
  chatContentText,
  DEFAULT_TIMEOUT_MS,
  providerUrl,
  withRetry,
  type AiProvider,
  type ChatChunk,
  type ChatMessage,
  type ChatOptions,
  type ModelInfo,
  type ToolFunctionDef,
  type UserOrSystemContent,
  type VisionDowngrade,
} from "./types.js";

const DEFAULT_MODEL = "gpt-4o-mini";

export type AiSdkProviderConfig = {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  /** Ask the model to think before answering, when the endpoint supports it. */
  thinking?: boolean;
  /** Effort when thinking is on. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Confirmed vision for this provider's default model. `false` skips sending
   * pixels; `true` / unset keeps the probe-and-retry behaviour.
   */
  visionSupported?: boolean;
  /**
   * Confirmed tool calling for this provider's default model. `false` omits
   * the tools array so a local / embedding model is not asked to call them.
   */
  toolsSupported?: boolean;
  /** Test seam: replaces the fetch used by both the SDK and `listModels`. */
  fetch?: typeof globalThis.fetch;
};

/** The portable effort scale the SDK translates for each provider. */
export type SdkReasoning =
  | "provider-default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/**
 * Collapse the IDE's thinking settings onto the SDK's portable scale, which
 * each provider then maps to its own wire field: `reasoning_effort` for
 * OpenAI-compatible endpoints, `thinking.budget_tokens` for Anthropic,
 * `thinking` plus effort for DeepSeek.
 */
export function resolveReasoning(opts: {
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  model: string;
  hasTools: boolean;
}): SdkReasoning {
  if (opts.thinking) {
    const effort = opts.reasoningEffort ?? "high";
    // The picker offers `max`, which the portable scale tops out at `xhigh`.
    return effort === "max" ? "xhigh" : effort;
  }
  // gpt-5 / o-series reject tools on chat/completions unless reasoning is off.
  if (opts.hasTools && requiresReasoningEffortNoneWithTools(opts.model)) {
    return "none";
  }
  return "provider-default";
}

/**
 * Time-to-first-byte guard. The timer is cleared once headers arrive, so a slow
 * but healthy generation is never cut off mid-stream.
 */
function withTtfbTimeout(
  base: typeof globalThis.fetch,
  timeoutMs: number,
): typeof globalThis.fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signals = [controller.signal];
    if (init?.signal) signals.push(init.signal);
    try {
      return await base(input, { ...init, signal: AbortSignal.any(signals) });
    } finally {
      clearTimeout(timer);
    }
  };
}

function createLanguageModel(
  config: AiSdkProviderConfig,
  modelId: string,
): LanguageModel {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseFetch = config.fetch ?? globalThis.fetch;
  const shared = {
    baseURL: config.baseUrl,
    ...(config.apiKey.trim() ? { apiKey: config.apiKey.trim() } : {}),
    ...(config.extraHeaders ? { headers: config.extraHeaders } : {}),
    fetch: withTtfbTimeout(baseFetch, timeoutMs),
  };
  switch (config.kind) {
    case "anthropic":
      return createAnthropic(shared)(modelId);
    case "deepseek":
      return createDeepSeek(shared)(modelId);
    default:
      return createOpenAICompatible({
        ...shared,
        name: "openai-compatible",
        // Without stream_options.include_usage an OpenAI-style stream reports no
        // token counts at all, which would silently zero out cost estimates.
        includeUsage: true,
      })(modelId);
  }
}

function toToolSet(defs: ToolFunctionDef[]): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    // No `execute`: the agent loop runs tools itself and feeds results back.
    tools[def.name] = tool({
      description: def.description,
      inputSchema: jsonSchema(def.parameters as JSONSchema7),
    });
  }
  return tools;
}

/**
 * A file part narrow enough to be accepted both in a user message and inside a
 * tool result, where only the tagged data shapes are allowed.
 */
type InlineFilePart = {
  type: "file";
  mediaType: string;
  data: { type: "data"; data: string } | { type: "url"; url: URL };
};

/**
 * Images travel as `file` parts: the older `image` part is deprecated, and the
 * tagged data shape lets each provider decide between inlining the bytes and
 * forwarding a URL.
 */
function toFilePart(url: string): InlineFilePart {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) {
    return {
      type: "file",
      mediaType: match[1] ?? "image",
      data: { type: "data", data: match[2] ?? "" },
    };
  }
  try {
    // Media type is unknown for a bare URL; the top-level segment is allowed.
    return { type: "file", mediaType: "image", data: { type: "url", url: new URL(url) } };
  } catch {
    return { type: "file", mediaType: "image", data: { type: "data", data: url } };
  }
}

function imageFilePart(image: ToolResultImage): InlineFilePart {
  return {
    type: "file",
    mediaType: image.mime || "image/png",
    data: { type: "data", data: image.dataBase64 },
  };
}

function toUserContent(content: UserOrSystemContent): UserContent {
  if (typeof content === "string") return content;
  const parts: Exclude<UserContent, string> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    parts.push(toFilePart(part.image_url.url));
  }
  return parts;
}

function toolResultImagesOutput(
  text: string,
  images: ToolResultImage[],
): ToolResultPart["output"] {
  return {
    type: "content",
    value: [{ type: "text" as const, text }, ...images.map(imageFilePart)],
  };
}

export type ConvertedPrompt = {
  /** Hoisted system messages: v7 refuses them inside `messages`. */
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
};

/**
 * The fixed preamble — tool definitions plus system prompt — is written once and
 * then read by every later request in the session, so the longer TTL earns back
 * its 2x write premium many times over. A session that idles past five minutes
 * (the user reading a diff, answering a question) would otherwise re-pay the
 * whole preamble at full price on the next turn.
 */
const ANTHROPIC_PREAMBLE_CACHE: {
  anthropic: { cacheControl: { type: "ephemeral"; ttl: "1h" } };
} = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
};

/**
 * The conversation breakpoint is rewritten on every request, since the tail it
 * covers grows with each turn. Its entry is only ever read by the request that
 * immediately follows, so the cheaper five-minute write is the right trade —
 * paying the 1h premium here would double the write cost for no extra hit.
 */
const ANTHROPIC_TAIL_CACHE: { type: "ephemeral"; ttl: "5m" } = {
  type: "ephemeral",
  ttl: "5m",
};

/**
 * Place one explicit Anthropic cache breakpoint at the end of the system block.
 * Anthropic orders tool definitions before the system prompt, so a breakpoint
 * there covers the entire fixed preamble in a single cumulative prefix hash.
 *
 * The system prompt is rebuilt every turn from session state, but its text only
 * changes when the phase, the test-gate escalation or a compaction changes it —
 * consecutive turns inside a phase hit the cache.
 *
 * The conversation tail is deliberately *not* pinned here. It is covered by
 * automatic caching instead (see {@link anthropicProviderOptions}), which moves
 * the breakpoint forward on its own as the history grows.
 */
function applyCacheBreakpoints(prompt: ConvertedPrompt): void {
  const lastSystem = prompt.instructions.at(-1);
  if (lastSystem) lastSystem.providerOptions = ANTHROPIC_PREAMBLE_CACHE;
}

/**
 * Top-level `cache_control` turns on Anthropic automatic caching: the API picks
 * the last cacheable block itself and advances the breakpoint as the
 * conversation grows, which is exactly the behaviour an agent loop wants when
 * the tail alternates between assistant tool calls and tool results.
 *
 * It consumes one of the four breakpoint slots, leaving the explicit preamble
 * breakpoint from {@link applyCacheBreakpoints} comfortably within budget.
 */
function anthropicProviderOptions(): {
  anthropic: { cacheControl: { type: "ephemeral"; ttl: "5m" } };
} {
  return { anthropic: { cacheControl: ANTHROPIC_TAIL_CACHE } };
}

/**
 * Translate the IDE's message shape into the SDK's prompt.
 *
 * Two provider-specific details are decided by `nativeToolImages`: endpoints
 * that accept media inside a tool result get the pixels there, while everyone
 * else gets the text result followed by a synthetic user message carrying the
 * images, because OpenAI-compatible APIs reject images on non-user roles.
 *
 * Those synthetic user messages wait for the whole run of tool results to be on
 * the wire. A user message that lands between an assistant's tool calls and the
 * results of its siblings makes the SDK reject the prompt with
 * `MissingToolResultsError`, so a batch where the first call returns a
 * screenshot and the second one reads a file would never reach the model.
 */
export function toPrompt(
  messages: ChatMessage[],
  opts: { nativeToolImages: boolean; cacheBreakpoints?: boolean },
): ConvertedPrompt {
  const instructions: SystemModelMessage[] = [];
  const out: ModelMessage[] = [];
  // Tool results must name their tool, which our message shape does not carry.
  const toolNameByCallId = new Map<string, string>();
  const hoistedImages: ModelMessage[] = [];
  const flushHoistedImages = (): void => {
    if (hoistedImages.length === 0) return;
    out.push(...hoistedImages);
    hoistedImages.length = 0;
  };

  for (const message of messages) {
    // Checked first: a positive test is what narrows this union down to the
    // tool member, since its other member covers both system and user.
    if (message.role === "tool") {
      const toolName = toolNameByCallId.get(message.tool_call_id) ?? "unknown";
      const images = message.images ?? [];
      const native = opts.nativeToolImages && images.length > 0;
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id,
            toolName,
            output: native
              ? toolResultImagesOutput(message.content, images)
              : { type: "text", value: message.content },
          },
        ],
      });
      if (native || images.length === 0) continue;

      const labels = images
        .map((img, index) => img.label ?? `image ${index + 1}`)
        .join(", ");
      hoistedImages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[IDE] Images returned by an earlier tool call in this batch (${labels}). Look at them and continue — the user did not send these, the tool did.`,
          },
          ...images.map(imageFilePart),
        ],
      });
      continue;
    }

    flushHoistedImages();

    if (message.role === "assistant") {
      const parts: Extract<
        ModelMessage,
        { role: "assistant" }
      >["content"] = [];
      if (message.reasoning_content) {
        parts.push({ type: "reasoning", text: message.reasoning_content });
      }
      if (message.content) {
        parts.push({ type: "text", text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        toolNameByCallId.set(call.id, call.name);
        parts.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          input: safeParseToolInput(call.arguments),
        });
      }
      out.push({ role: "assistant", content: parts });
      continue;
    }

    if (message.role === "system") {
      instructions.push({
        role: "system",
        content: chatContentText(message.content),
      });
      continue;
    }

    out.push({ role: "user", content: toUserContent(message.content) });
  }

  flushHoistedImages();

  const prompt: ConvertedPrompt = { instructions, messages: out };
  if (opts.cacheBreakpoints) applyCacheBreakpoints(prompt);
  return prompt;
}

function safeParseToolInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // The model produced invalid JSON; hand it over verbatim so the provider
    // (or the tool gateway) reports the real problem instead of a parse crash.
    return { __raw: raw };
  }
}

/** Keep the OpenAI-style vocabulary the transcript and tests already speak. */
export function toFinishReason(reason: FinishReason): string {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "content-filter":
      return "content_filter";
    default:
      return reason;
  }
}

export function toChatUsage(usage: LanguageModelUsage): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
} {
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

export class AiSdkProvider implements AiProvider {
  private abortController: AbortController | null = null;
  /**
   * Models that rejected image parts, so later turns skip the pixels instead of
   * burning a round trip. Keyed by model because a provider usually serves both
   * kinds, and a latch on the whole endpoint would blind a vision model just
   * because a text-only sibling was tried first.
   */
  private visionUnsupportedModels = new Set<string>();
  /** Set while mapping an error, read by the vision retry in `chat`. */
  private lastErrorWasVisionUnsupported = false;
  private lastVisionRejection: string | null = null;
  private pendingVisionDowngrade: VisionDowngrade | null = null;

  constructor(private readonly config: AiSdkProviderConfig) {
    assertHttpsForRemote(config.baseUrl);
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = providerUrl(this.config.baseUrl, "/v1/models");
    const doFetch = this.config.fetch ?? globalThis.fetch;
    const response = await withRetry(() =>
      withTtfbTimeout(doFetch, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS)(
        url,
        {
          method: "GET",
          headers: {
            ...this.config.extraHeaders,
            ...authHeadersFor(this.config.baseUrl, this.config.apiKey),
          },
        },
      ),
    );
    if (!response.ok) {
      const text = await response.text();
      throw new AppError({
        code: "PROVIDER_ERROR",
        userMessage: formatHttpUserMessage(response.status, text),
        technicalDetail: `HTTP ${response.status}: ${text.slice(0, 4000)}`,
      });
    }
    return parseModelListBody(await response.json());
  }

  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    const model = options?.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
    const chatOptions = ((): ChatOptions | undefined => {
      if (this.config.toolsSupported === false && options?.tools?.length) {
        const { tools: _omit, ...rest } = options;
        return rest;
      }
      return options;
    })();
    const hasVision = messagesHaveVision(messages);
    if (hasVision && this.config.visionSupported === false) {
      this.visionUnsupportedModels.add(model);
    }
    const mayTryVision = hasVision && !this.visionUnsupportedModels.has(model);
    const first =
      hasVision && !mayTryVision ? flattenVisionToText(messages) : messages;
    if (hasVision && !mayTryVision) {
      this.pendingVisionDowngrade = {
        model,
        detail:
          this.lastVisionRejection ??
          "this model rejected images earlier in this session",
      };
    }

    let sawOutput = false;
    let retryWithoutVision = false;
    for await (const chunk of this.runOnce(first, model, chatOptions)) {
      if (
        chunk.type === "error" &&
        !sawOutput &&
        mayTryVision &&
        this.lastErrorWasVisionUnsupported
      ) {
        retryWithoutVision = true;
        break;
      }
      if (chunk.type !== "error") sawOutput = true;
      yield chunk;
    }
    if (!retryWithoutVision) return;

    this.visionUnsupportedModels.add(model);
    this.pendingVisionDowngrade = {
      model,
      detail: this.lastVisionRejection ?? "the endpoint rejected image parts",
    };
    yield* this.runOnce(flattenVisionToText(messages), model, chatOptions);
  }

  /**
   * Whether the last turn had its pixels stripped. Read once and cleared: the
   * caller is expected to tell the human, because an agent that answers "I
   * cannot see the screenshot" is otherwise indistinguishable from a model that
   * simply refuses to look.
   */
  takeVisionDowngrade(): VisionDowngrade | null {
    const downgrade = this.pendingVisionDowngrade;
    this.pendingVisionDowngrade = null;
    return downgrade;
  }

  cancel(): void {
    this.abortController?.abort();
  }

  private async *runOnce(
    messages: ChatMessage[],
    model: string,
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    this.abortController = new AbortController();
    const signal = options?.signal ?? this.abortController.signal;
    const hasTools = Boolean(options?.tools?.length);
    const anthropic = this.config.kind === "anthropic";
    const { instructions, messages: modelMessages } = toPrompt(messages, {
      nativeToolImages: anthropic,
      cacheBreakpoints: anthropic,
    });

    // Index by tool call id: the transcript addresses streamed argument deltas
    // by position, while the SDK addresses them by id.
    const indexByCallId = new Map<string, number>();
    let nextIndex = 0;
    const indexFor = (id: string): number => {
      const existing = indexByCallId.get(id);
      if (existing !== undefined) return existing;
      const index = nextIndex++;
      indexByCallId.set(id, index);
      return index;
    };
    const nameByCallId = new Map<string, string>();

    let finishReason = "stop";
    let doneUsage:
      | { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
      | undefined;

    try {
      const result = streamText({
        model: createLanguageModel(this.config, model),
        ...(instructions.length ? { instructions } : {}),
        messages: modelMessages,
        abortSignal: signal,
        reasoning: resolveReasoning({
          ...(this.config.thinking !== undefined
            ? { thinking: this.config.thinking }
            : {}),
          ...(this.config.reasoningEffort !== undefined
            ? { reasoningEffort: this.config.reasoningEffort }
            : {}),
          model,
          hasTools,
        }),
        ...(hasTools ? { tools: toToolSet(options!.tools!) } : {}),
        ...(anthropic ? { providerOptions: anthropicProviderOptions() } : {}),
        // Errors travel as chunks to the caller; the SDK default logs them.
        onError: () => {},
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            if (part.text) yield { type: "content", delta: part.text };
            break;
          case "reasoning-delta":
            if (part.text) yield { type: "reasoning", delta: part.text };
            break;
          case "tool-input-start":
            nameByCallId.set(part.id, part.toolName);
            yield {
              type: "tool_call",
              id: part.id,
              name: part.toolName,
              argumentsDelta: "",
              index: indexFor(part.id),
            };
            break;
          case "tool-input-delta":
            yield {
              type: "tool_call",
              id: part.id,
              name: nameByCallId.get(part.id) ?? "",
              argumentsDelta: part.delta,
              index: indexFor(part.id),
            };
            break;
          case "tool-call": {
            // Providers that deliver arguments in one piece never emit deltas.
            if (indexByCallId.has(part.toolCallId)) break;
            yield {
              type: "tool_call",
              id: part.toolCallId,
              name: part.toolName,
              argumentsDelta: JSON.stringify(part.input ?? {}),
              index: indexFor(part.toolCallId),
            };
            break;
          }
          case "finish":
            finishReason = toFinishReason(part.finishReason);
            doneUsage = toChatUsage(part.totalUsage);
            break;
          case "abort":
            finishReason = "abort";
            break;
          case "error":
            yield { type: "error", error: this.toAppError(part.error) };
            return;
          default:
            break;
        }
      }

      yield {
        type: "done",
        finishReason,
        ...(doneUsage ? { usage: doneUsage } : {}),
      };
    } catch (error) {
      yield { type: "error", error: this.toAppError(error) };
    } finally {
      this.abortController = null;
    }
  }

  private toAppError(error: unknown): AppError {
    this.lastErrorWasVisionUnsupported = false;
    if (error instanceof AppError) return error;

    if (APICallError.isInstance(error)) {
      const status = error.statusCode ?? 0;
      const body = error.responseBody ?? error.message;
      this.lastErrorWasVisionUnsupported = isVisionUnsupportedError(
        status,
        body,
      );
      if (this.lastErrorWasVisionUnsupported) {
        this.lastVisionRejection = `HTTP ${status}: ${body.slice(0, 300)}`;
      }
      return new AppError({
        code: "PROVIDER_ERROR",
        userMessage: formatHttpUserMessage(status, body),
        technicalDetail: `HTTP ${status}: ${body.slice(0, 4000)}`,
        cause: error,
      });
    }

    if (error instanceof Error && error.name === "AbortError") {
      return new AppError({
        code: "PROVIDER_TIMEOUT",
        userMessage: "The AI provider request timed out.",
        technicalDetail: error.message,
        cause: error,
      });
    }

    if (
      error instanceof Error &&
      /Tool result.*missing for tool call/i.test(error.message)
    ) {
      return new AppError({
        code: "PROVIDER_ERROR",
        userMessage:
          "The AI provider rejected the conversation: a tool call had no matching result (often after context compaction). Press Resume · Enter to retry.",
        technicalDetail: error.message,
        cause: error,
      });
    }

    const httpish = duckTypeHttpError(error);
    if (httpish) {
      this.lastErrorWasVisionUnsupported = isVisionUnsupportedError(
        httpish.status,
        httpish.body,
      );
      if (this.lastErrorWasVisionUnsupported) {
        this.lastVisionRejection = `HTTP ${httpish.status}: ${httpish.body.slice(0, 300)}`;
      }
      return new AppError({
        code: "PROVIDER_ERROR",
        userMessage: formatHttpUserMessage(httpish.status, httpish.body),
        technicalDetail: `HTTP ${httpish.status}: ${httpish.body.slice(0, 4000)}`,
        cause: error,
      });
    }

    const detail =
      stringifyUnknownError(error) || "No error detail from the provider.";
    if (isContextOverflowError(detail)) {
      return new AppError({
        code: "PROVIDER_ERROR",
        userMessage: CONTEXT_OVERFLOW_USER_MESSAGE,
        technicalDetail: detail,
        cause: error,
      });
    }
    return new AppError({
      code: "PROVIDER_ERROR",
      userMessage: "The AI provider request failed.",
      technicalDetail: detail,
      cause: error,
    });
  }
}

function duckTypeHttpError(
  error: unknown,
): { status: number; body: string } | null {
  if (!error || typeof error !== "object") return null;
  const rec = error as Record<string, unknown>;
  const status =
    typeof rec.statusCode === "number"
      ? rec.statusCode
      : typeof rec.status === "number"
        ? rec.status
        : 0;
  const body =
    (typeof rec.responseBody === "string" && rec.responseBody) ||
    stringifyUnknownError(error);
  if (!body) return null;
  if (status >= 400) return { status, body };
  return null;
}
