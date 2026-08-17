import { AppError } from "@ai-ide/shared";
import {
  assertHttpsForRemote,
  chatContentText,
  DEFAULT_TIMEOUT_MS,
  providerUrl,
  withRetry,
  type AiProvider,
  type AssistantToolCall,
  type ChatChunk,
  type ChatMessage,
  type ChatOptions,
  type ContentPart,
  type ModelInfo,
} from "./types.js";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type OpenAiProviderConfig = {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  /** DeepSeek-style thinking / chain-of-thought. */
  thinking?: boolean;
  /** Effort when thinking is enabled. */
  reasoningEffort?: ReasoningEffort;
};

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

export class OpenAiCompatibleProvider implements AiProvider {
  private abortController: AbortController | null = null;
  /** Cached after first vision rejection — skip image_url on later turns. */
  private visionSupported: boolean | null = null;

  constructor(private readonly config: OpenAiProviderConfig) {
    assertHttpsForRemote(config.baseUrl);
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = providerUrl(this.config.baseUrl, "/v1/models");
    const response = await withRetry(() =>
      this.fetchWithTimeout(url, { method: "GET" }),
    );
    if (!response.ok) {
      throw await this.httpError(response);
    }
    const body = (await response.json()) as {
      data?: unknown[];
      models?: unknown[];
    };
    const raw = body.data ?? body.models ?? [];
    const byId = new Map<string, ModelInfo>();
    for (const entry of raw) {
      const parsed = parseModelListEntry(entry);
      if (!parsed) continue;
      const prior = byId.get(parsed.id);
      if (!prior) {
        byId.set(parsed.id, parsed);
        continue;
      }
      // Prefer the entry that includes a context window.
      if (
        parsed.contextWindowTokens != null &&
        prior.contextWindowTokens == null
      ) {
        byId.set(parsed.id, parsed);
      }
    }
    return [...byId.values()];
  }

  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    this.abortController = new AbortController();
    const signal = options?.signal ?? this.abortController.signal;
    const url = providerUrl(this.config.baseUrl, "/v1/chat/completions");
    const model = options?.model ?? this.config.defaultModel ?? "gpt-4o-mini";

    const hasVision = messagesHaveVision(messages);
    const tryVision = hasVision && this.visionSupported !== false;
    let activeMessages =
      hasVision && !tryVision ? flattenVisionToText(messages) : messages;
    let body = this.buildChatBody(activeMessages, model, options);

    let response: Response;
    try {
      response = await withRetry(() =>
        this.fetchWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (error) {
      yield { type: "error", error: this.toAppError(error) };
      return;
    }

    if (!response.ok && tryVision) {
      const errText = await response.text();
      if (isVisionUnsupportedError(response.status, errText)) {
        this.visionSupported = false;
        activeMessages = flattenVisionToText(messages);
        body = this.buildChatBody(activeMessages, model, options);
        try {
          response = await withRetry(() =>
            this.fetchWithTimeout(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal,
            }),
          );
        } catch (error) {
          yield { type: "error", error: this.toAppError(error) };
          return;
        }
      } else {
        yield {
          type: "error",
          error: new AppError({
            code: "PROVIDER_ERROR",
            userMessage: formatHttpUserMessage(response.status, errText),
            technicalDetail: `HTTP ${response.status}: ${errText.slice(0, 4000)}`,
          }),
        };
        return;
      }
    } else if (tryVision && response.ok) {
      this.visionSupported = true;
    }

    if (!response.ok) {
      yield { type: "error", error: await this.httpError(response) };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: new AppError({
          code: "PROVIDER_ERROR",
          userMessage: "Provider returned an empty response.",
          technicalDetail: "Missing response body for streaming chat.",
        }),
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let finishReason = "stop";
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            for (const [index, call] of toolCalls) {
              yield {
                type: "tool_call",
                id: call.id || `call_${index}`,
                name: call.name,
                argumentsDelta: "",
                index,
              };
            }
            yield {
              type: "done",
              finishReason,
              ...(usage ? { usage } : {}),
            };
            return;
          }
          try {
            const parsed = JSON.parse(payload) as {
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                input_tokens?: number;
                output_tokens?: number;
              };
              choices?: Array<{
                finish_reason?: string | null;
                delta?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };
            if (parsed.usage) {
              const u = parsed.usage;
              usage = {
                inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
                outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
              };
            }
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta;
            if (delta?.reasoning_content) {
              yield { type: "reasoning", delta: delta.reasoning_content };
            }
            if (delta?.content) yield { type: "content", delta: delta.content };
            for (const tc of delta?.tool_calls ?? []) {
              const index = tc.index ?? 0;
              const current = toolCalls.get(index) ?? {
                id: "",
                name: "",
                arguments: "",
              };
              if (tc.id) current.id = tc.id;
              if (tc.function?.name) current.name += tc.function.name;
              if (tc.function?.arguments) {
                current.arguments += tc.function.arguments;
                yield {
                  type: "tool_call",
                  id: current.id || `call_${index}`,
                  name: current.name,
                  argumentsDelta: tc.function.arguments,
                  index,
                };
              } else if (tc.function?.name || tc.id) {
                toolCalls.set(index, current);
                yield {
                  type: "tool_call",
                  id: current.id || `call_${index}`,
                  name: current.name,
                  argumentsDelta: "",
                  index,
                };
              }
              toolCalls.set(index, current);
            }
          } catch {
            /* skip malformed chunk */
          }
        }
      }
      yield {
        type: "done",
        finishReason,
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      yield { type: "error", error: this.toAppError(error) };
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  private buildChatBody(
    messages: ChatMessage[],
    model: string,
    options?: ChatOptions,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: expandMessagesForOpenAi(messages),
      stream: true,
    };
    // Many local servers reject unknown fields; cloud OpenAI-compatible APIs
    // need this to emit a final usage chunk on the stream.
    try {
      const host = new URL(this.config.baseUrl).hostname;
      const local =
        host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!local) {
        body.stream_options = { include_usage: true };
      }
    } catch {
      body.stream_options = { include_usage: true };
    }
    applyProviderThinkingFields(body, {
      ...(this.config.thinking !== undefined
        ? { thinking: this.config.thinking }
        : {}),
      ...(this.config.reasoningEffort !== undefined
        ? { reasoningEffort: this.config.reasoningEffort }
        : {}),
      model,
      hasTools: Boolean(options?.tools?.length),
    });
    if (options?.tools?.length) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }
    return body;
  }

  private fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signals = [controller.signal];
    if (init.signal) signals.push(init.signal);

    const combined = AbortSignal.any(signals);
    const headers: Record<string, string> = {
      ...this.config.extraHeaders,
      ...(init.headers as Record<string, string> | undefined),
    };
    // Local servers (Ollama, etc.) often need no key; omit Bearer when empty.
    const key = this.config.apiKey.trim();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }

    return fetch(url, {
      ...init,
      signal: combined,
      headers,
    }).finally(() => clearTimeout(timeout));
  }

  private async httpError(response: Response): Promise<AppError> {
    const text = await response.text();
    return new AppError({
      code: "PROVIDER_ERROR",
      userMessage: formatHttpUserMessage(response.status, text),
      technicalDetail: `HTTP ${response.status}: ${text.slice(0, 4000)}`,
    });
  }

  private toAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    if (error instanceof Error && error.name === "AbortError") {
      return new AppError({
        code: "PROVIDER_TIMEOUT",
        userMessage: "The AI provider request timed out.",
        technicalDetail: error.message,
        cause: error,
      });
    }
    return new AppError({
      code: "PROVIDER_ERROR",
      userMessage: "The AI provider request failed.",
      technicalDetail: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

function formatHttpUserMessage(status: number, body: string): string {
  const providerMessage = extractProviderErrorMessage(body);
  const statusHint = httpStatusHint(status);
  return providerMessage
    ? `Provider error (HTTP ${status}): ${providerMessage}`
    : `Provider error (HTTP ${status})${statusHint ? `: ${statusHint}` : "."}`;
}

/** True when any message carries image pixels (user/system parts or tool images). */
export function messagesHaveVision(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (m.role === "tool") {
      if (m.images?.length) return true;
      continue;
    }
    if (m.role !== "user" && m.role !== "system") continue;
    if (typeof m.content === "string") continue;
    if (m.content.some((p) => p.type === "image_url")) return true;
  }
  return false;
}

/** Drop image parts; keep text + a note so the agent can import_attachment. */
export function flattenVisionToText(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      if (!m.images?.length) return m;
      const note = `\n\n[IDE] This tool returned ${m.images.length} image(s), but this model/endpoint cannot view images (no vision). The pixels were NOT sent to you. Rely on the text output, or ask the user to describe the image.`;
      return {
        role: "tool",
        tool_call_id: m.tool_call_id,
        content: `${m.content}${note}`,
      };
    }
    if (m.role !== "user" && m.role !== "system") return m;
    if (typeof m.content === "string") return m;
    const imageCount = m.content.filter((p) => p.type === "image_url").length;
    const text = chatContentText(m.content);
    if (imageCount === 0) return { ...m, content: text };
    const note = `\n\n[IDE] ${imageCount} image(s) were attached but this model/endpoint cannot view images (no vision). The pixels were NOT sent to you — only this text. Ask the user to describe the screenshot, or use import_attachment if you need the file bytes in the workspace.`;
    return { role: m.role, content: `${text}${note}` };
  });
}

/**
 * Expand internal messages into wire messages.
 *
 * OpenAI-compatible endpoints reject images on non-user roles ("Image URLs are
 * only allowed for messages with role 'user'"), so a tool message carrying
 * images becomes two wire messages: the text-only tool result, then a synthetic
 * user message holding the pixels. Order matters — the images must follow the
 * tool result they belong to.
 */
export function expandMessagesForOpenAi(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    out.push(toOpenAiMessage(message));
    if (message.role !== "tool" || !message.images?.length) continue;
    const labels = message.images
      .map((img, index) => img.label ?? `image ${index + 1}`)
      .join(", ");
    const parts: ContentPart[] = [
      {
        type: "text",
        text: `[IDE] Images returned by the previous tool call (${labels}). Look at them and continue — the user did not send these, the tool did.`,
      },
    ];
    for (const img of message.images) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${img.mime || "image/png"};base64,${img.dataBase64}`,
        },
      });
    }
    out.push({ role: "user", content: parts });
  }
  return out;
}

export function isVisionUnsupportedError(
  status: number,
  body: string,
): boolean {
  if (status !== 400 && status !== 422) return false;
  const b = body.toLowerCase();
  if (b.includes("image_url") && b.includes("unknown variant")) return true;
  if (b.includes("image_url") && b.includes("expected") && b.includes("text")) {
    return true;
  }
  if (
    (b.includes("vision") || b.includes("image")) &&
    (b.includes("not support") ||
      b.includes("unsupported") ||
      b.includes("does not support"))
  ) {
    return true;
  }
  return false;
}

function extractProviderErrorMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const json = JSON.parse(trimmed) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
      message?: unknown;
    };
    const nested = json.error;
    if (nested && typeof nested === "object") {
      const parts: string[] = [];
      if (typeof nested.message === "string" && nested.message.trim()) {
        parts.push(nested.message.trim());
      }
      if (typeof nested.code === "string" && nested.code.trim()) {
        parts.push(`code=${nested.code.trim()}`);
      } else if (typeof nested.type === "string" && nested.type.trim()) {
        parts.push(nested.type.trim());
      }
      if (parts.length) return parts.join(" · ");
    }
    if (typeof json.message === "string" && json.message.trim()) {
      return json.message.trim();
    }
  } catch {
    /* plain text body */
  }
  const oneLine = trimmed.replace(/\s+/g, " ");
  return oneLine.length > 280 ? `${oneLine.slice(0, 277)}…` : oneLine;
}

function httpStatusHint(status: number): string | null {
  switch (status) {
    case 401:
      return "Unauthorized — check API key";
    case 403:
      return "Forbidden — key or model access denied";
    case 404:
      return "Not found — check base URL / model id";
    case 429:
      return "Rate limited — retry later";
    default:
      return status >= 500 ? "Upstream server error" : null;
  }
}

/** Models that default to reasoning and cannot mix tools + reasoning on chat/completions. */
export function requiresReasoningEffortNoneWithTools(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  return (
    m.startsWith("gpt-5") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4") ||
    m.includes("luna") ||
    m.includes("reasoning")
  );
}

/**
 * Mutates chat body with DeepSeek-style thinking and/or gpt-5 tools workaround.
 * Only sets thinking fields when enabled (avoid 400s on non-DeepSeek endpoints).
 */
export function applyProviderThinkingFields(
  body: Record<string, unknown>,
  opts: {
    thinking?: boolean;
    reasoningEffort?: ReasoningEffort;
    model: string;
    hasTools: boolean;
  },
): void {
  if (opts.thinking) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = opts.reasoningEffort ?? "high";
    return;
  }
  // gpt-5 / reasoning models reject tools unless reasoning_effort is none
  // on /v1/chat/completions (otherwise they require /v1/responses).
  if (opts.hasTools && requiresReasoningEffortNoneWithTools(opts.model)) {
    body.reasoning_effort = "none";
  }
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const out: Record<string, unknown> = {
      role: "assistant",
      content: message.content,
    };
    if (message.tool_calls?.length) {
      out.tool_calls = message.tool_calls.map((tc: AssistantToolCall) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    if (message.reasoning_content) {
      out.reasoning_content = message.reasoning_content;
    }
    return out;
  }
  return { role: message.role, content: message.content };
}

/** @internal exported for tests */
export { toOpenAiMessage };

function coerceContextTokens(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    // Ignore tiny values — those are usually completion caps, not windows.
    if (n >= 4_000 && n <= 10_000_000) return n;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return coerceContextTokens(Number(value.trim()));
  }
  return undefined;
}

/**
 * Pull a context-window hint from heterogeneous OpenAI-compatible /models
 * payloads (OpenRouter, Groq, vLLM, LM Studio, Together, …).
 */
export function extractContextWindowTokens(
  entry: Record<string, unknown>,
): number | undefined {
  const directKeys = [
    "context_length",
    "context_window",
    "contextWindow",
    "context_window_tokens",
    "max_model_len",
    "max_input_tokens",
    "max_seq_len",
    "n_ctx",
    "n_ctx_train",
  ] as const;
  for (const key of directKeys) {
    const n = coerceContextTokens(entry[key]);
    if (n != null) return n;
  }

  // max_tokens is ambiguous (often completion-only). Accept only large values.
  const maxTokens = coerceContextTokens(entry.max_tokens);
  if (maxTokens != null && maxTokens >= 16_000) return maxTokens;

  for (const nestKey of ["meta", "architecture", "top_provider", "limits", "parameters"] as const) {
    const nest = entry[nestKey];
    if (nest && typeof nest === "object" && !Array.isArray(nest)) {
      const nested = extractContextWindowTokens(nest as Record<string, unknown>);
      if (nested != null) return nested;
    }
  }
  return undefined;
}

export function parseModelListEntry(entry: unknown): ModelInfo | null {
  if (typeof entry === "string" && entry.trim()) {
    return { id: entry.trim() };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const obj = entry as Record<string, unknown>;
  const id =
    (typeof obj.id === "string" && obj.id.trim()) ||
    (typeof obj.name === "string" && obj.name.trim()) ||
    "";
  if (!id) return null;
  const contextWindowTokens = extractContextWindowTokens(obj);
  return contextWindowTokens != null
    ? { id, contextWindowTokens }
    : { id };
}

export function parseSseDataLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0 && l !== "[DONE]");
}
