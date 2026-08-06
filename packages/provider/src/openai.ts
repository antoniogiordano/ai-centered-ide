import { AppError } from "@ai-ide/shared";
import {
  assertHttpsForRemote,
  DEFAULT_TIMEOUT_MS,
  providerUrl,
  withRetry,
  type AiProvider,
  type AssistantToolCall,
  type ChatChunk,
  type ChatMessage,
  type ChatOptions,
  type ModelInfo,
} from "./types.js";

export type OpenAiProviderConfig = {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
};

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

export class OpenAiCompatibleProvider implements AiProvider {
  private abortController: AbortController | null = null;

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
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ id?: string; name?: string } | string>;
    };
    const raw = body.data ?? body.models ?? [];
    const ids: string[] = [];
    for (const entry of raw) {
      if (typeof entry === "string" && entry.trim()) {
        ids.push(entry.trim());
        continue;
      }
      if (entry && typeof entry === "object") {
        const id =
          (typeof entry.id === "string" && entry.id.trim()) ||
          (typeof entry.name === "string" && entry.name.trim()) ||
          "";
        if (id) ids.push(id);
      }
    }
    return [...new Set(ids)].map((id) => ({ id }));
  }

  async *chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    this.abortController = new AbortController();
    const signal = options?.signal ?? this.abortController.signal;
    const url = providerUrl(this.config.baseUrl, "/v1/chat/completions");
    const model = options?.model ?? this.config.defaultModel ?? "gpt-4o-mini";

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(toOpenAiMessage),
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
      // gpt-5 / reasoning models reject tools unless reasoning_effort is none
      // on /v1/chat/completions (otherwise they require /v1/responses).
      if (requiresReasoningEffortNoneWithTools(model)) {
        body.reasoning_effort = "none";
      }
    }

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
    const providerMessage = extractProviderErrorMessage(text);
    const statusHint = httpStatusHint(response.status);
    const userMessage = providerMessage
      ? `Provider error (HTTP ${response.status}): ${providerMessage}`
      : `Provider error (HTTP ${response.status})${statusHint ? `: ${statusHint}` : "."}`;
    return new AppError({
      code: "PROVIDER_ERROR",
      userMessage,
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
    return out;
  }
  return { role: message.role, content: message.content };
}

export function parseSseDataLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 0 && l !== "[DONE]");
}
