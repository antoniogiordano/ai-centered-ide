/**
 * Wire-level helpers shared by the transport in `ai-sdk.ts`.
 *
 * These are the parts of talking to a provider that the AI SDK does not cover:
 * choosing an auth header for a host, reading the many dialects of a
 * `/v1/models` payload, turning an HTTP failure into a message a user can act
 * on, and recognising the endpoints that reject images so a turn can be retried
 * without them.
 */
import { isAnthropicHost } from "@ai-ide/shared";
import {
  chatContentText,
  type ChatMessage,
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

/** Anthropic pins its wire format behind this header on every endpoint. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Pick the auth header shape for the host.
 *
 * Anthropic reserves `Authorization: Bearer` for OAuth tokens, so an `sk-ant-…`
 * key sent that way is rejected with 401 "Invalid bearer token" before the key
 * is even looked at. Both the native endpoints and the OpenAI compatibility
 * layer at api.anthropic.com/v1 accept `x-api-key`, so that is what this host
 * gets; everyone else keeps Bearer.
 */
export function authHeadersFor(
  baseUrl: string,
  apiKey: string,
): Record<string, string> {
  // Local servers (Ollama, etc.) often need no key; send nothing when empty.
  const key = apiKey.trim();
  if (!key) return {};
  if (isAnthropicHost(baseUrl)) {
    return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  }
  return { Authorization: `Bearer ${key}` };
}

/**
 * Normalise the many shapes a `/v1/models` payload comes in. Deduplicates by
 * id, preferring the entry that carries a context window: OpenRouter and
 * friends sometimes list the same model twice with uneven metadata.
 */
export function parseModelListBody(payload: unknown): ModelInfo[] {
  const body = (payload ?? {}) as { data?: unknown[]; models?: unknown[] };
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
    if (
      parsed.contextWindowTokens != null &&
      prior.contextWindowTokens == null
    ) {
      byId.set(parsed.id, parsed);
    }
  }
  return [...byId.values()];
}

/**
 * llama.cpp / LM Studio (and similar local servers) reject the request when
 * the system prompt + tools already fill `n_ctx`. Distinct from a generic
 * HTTP 400 so the UI can tell the user to reload the model with a larger
 * context instead of "request failed".
 */
export const CONTEXT_OVERFLOW_USER_MESSAGE =
  "This model's loaded context is too small for AICI's system prompt and tools. Reload it with a larger context (32,768 tokens recommended) in LM Studio / llama.cpp, then set that number as Context window in Providers so AICI can compact before the next overflow.";

export function isContextOverflowError(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  if (t.includes("tokens to keep from the initial prompt")) return true;
  if (t.includes("n_keep") && t.includes("context")) return true;
  if (t.includes("greater than the context length")) return true;
  if (t.includes("context_length_exceeded")) return true;
  if (t.includes("maximum context length") || t.includes("max context length")) {
    return true;
  }
  if (t.includes("exceeds the context") || t.includes("exceeds context length")) {
    return true;
  }
  if (t.includes("context length exceeded")) return true;
  if (t.includes("prompt is too long") || t.includes("prompt too long")) {
    return true;
  }
  if (t.includes("please reduce the length of the messages")) return true;
  if (t.includes("this model's maximum context")) return true;
  if (t.includes("loaded context is too small")) return true;
  return false;
}

export function formatHttpUserMessage(status: number, body: string): string {
  if (isContextOverflowError(body)) {
    return CONTEXT_OVERFLOW_USER_MESSAGE;
  }
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
 * Recognise the ways an endpoint says "I cannot look at images", so a turn can
 * be retried with the pixels stripped instead of failing outright.
 */
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
    "max_context_length",
    "loaded_context_length",
    "max_context_window",
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
