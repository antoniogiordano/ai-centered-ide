import { AppError } from "@ai-ide/shared";

export type ToolFunctionDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AssistantToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: AssistantToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatChunk =
  | { type: "content"; delta: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      argumentsDelta: string;
      index: number;
    }
  | {
      type: "done";
      finishReason: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; error: AppError };

export type ChatOptions = {
  model?: string;
  signal?: AbortSignal;
  tools?: ToolFunctionDef[];
};

export type ModelInfo = {
  id: string;
};

export interface AiProvider {
  listModels(): Promise<ModelInfo[]>;
  chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatChunk>;
  cancel(requestId?: string): void;
}

export type ProviderErrorKind =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "auth"
  | "validation"
  | "unknown";

export function classifyProviderError(error: unknown): ProviderErrorKind {
  if (error instanceof AppError) {
    if (error.code === "PROVIDER_TIMEOUT") return "timeout";
    if (error.code === "VALIDATION_ERROR") return "validation";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return "timeout";
    const msg = error.message.toLowerCase();
    if (msg.includes("429")) return "rate_limit";
    if (msg.includes("401") || msg.includes("403")) return "auth";
    if (msg.includes("fetch") || msg.includes("network")) return "network";
    if (/5\d\d/.test(msg)) return "server";
  }
  return "unknown";
}

export function isRetryable(kind: ProviderErrorKind): boolean {
  return kind === "network" || kind === "rate_limit" || kind === "server";
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const kind = classifyProviderError(error);
      if (!isRetryable(kind) || attempt >= maxRetries) throw error;
      attempt += 1;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

export function assertHttpsForRemote(baseUrl: string): void {
  const url = new URL(baseUrl);
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (!isLocal && url.protocol !== "https:") {
    throw new AppError({
      code: "VALIDATION_ERROR",
      userMessage: "Remote provider URLs must use HTTPS.",
      technicalDetail: `Invalid protocol for host ${url.hostname}: ${url.protocol}`,
    });
  }
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Join OpenAI-compatible base URL with an API path without duplicating /v1. */
export function providerUrl(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  if (base.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${base}${path.slice(3)}`;
  }
  return `${base}${path}`;
}
