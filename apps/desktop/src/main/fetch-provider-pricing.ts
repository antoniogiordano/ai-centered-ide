import {
  AppError,
  ProviderPricingSchema,
  guessPricingDocsUrl,
  type ProviderFetchPricingRequest,
  type ProviderFetchPricingResponse,
  type ProviderPricing,
} from "@ai-ide/shared";
import {
  OpenAiCompatibleProvider,
  type ChatMessage,
  type ToolFunctionDef,
} from "@ai-ide/provider";
import type { ProviderRegistryStore } from "./provider-registry.js";

const RATE_PROPS = {
  type: "object",
  additionalProperties: false,
  properties: {
    inputPer1M: { type: "number", description: "USD per 1M input tokens" },
    inputCacheHitPer1M: {
      type: "number",
      description: "USD per 1M cached input tokens (cache hit)",
    },
    inputCacheMissPer1M: {
      type: "number",
      description: "USD per 1M uncached input tokens (cache miss)",
    },
    outputPer1M: { type: "number", description: "USD per 1M output tokens" },
  },
} as const;

const SCHEDULE_PROPS = {
  type: "object",
  additionalProperties: false,
  properties: {
    peakWindowsUtc: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          startUtc: { type: "string", description: "HH:MM UTC" },
          endUtc: { type: "string", description: "HH:MM UTC (exclusive)" },
        },
        required: ["startUtc", "endUtc"],
      },
    },
    peak: RATE_PROPS,
    offPeak: RATE_PROPS,
  },
} as const;

const SUBMIT_PRICING_TOOL: ToolFunctionDef = {
  name: "submit_provider_pricing",
  description:
    "Submit structured USD-per-1M-token pricing extracted from the docs, plus contextWindowTokens for the default model when documented. Always call this once you have rates. Prefer cache hit/miss and peak/off-peak when the page lists them (e.g. DeepSeek).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      inputPer1M: { type: "number" },
      inputCacheHitPer1M: { type: "number" },
      inputCacheMissPer1M: { type: "number" },
      outputPer1M: { type: "number" },
      schedule: SCHEDULE_PROPS,
      byModel: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            inputPer1M: { type: "number" },
            inputCacheHitPer1M: { type: "number" },
            inputCacheMissPer1M: { type: "number" },
            outputPer1M: { type: "number" },
            schedule: SCHEDULE_PROPS,
          },
        },
        description: "Per-model rates keyed by model id",
      },
      sourceUrl: { type: "string" },
      notes: {
        type: "string",
        description: "Short notes (peak hours, units, caveats)",
      },
      contextWindowTokens: {
        type: "number",
        description:
          "Context window in tokens for the target default model (e.g. 128000). Use the official docs when stated; omit if unknown.",
      },
    },
  },
};

const FETCH_PAGE_TOOL: ToolFunctionDef = {
  name: "fetch_pricing_page",
  description:
    "Fetch a public pricing documentation URL and return truncated plain text.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "https URL of the pricing page" },
    },
    required: ["url"],
  },
};

const MAX_PAGE_CHARS = 24_000;
const MAX_ROUNDS = 4;

function htmlToRoughText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPricingPageText(
  url: string,
  signal?: AbortSignal,
): Promise<{ text: string; finalUrl: string }> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    ...(signal ? { signal } : {}),
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent": "ai-first-ide-pricing-fetch/0.1",
    },
  });
  if (!response.ok) {
    throw new AppError({
      code: "PROVIDER_ERROR",
      userMessage: `Could not fetch pricing page (HTTP ${response.status}).`,
      technicalDetail: `GET ${url} → ${response.status}`,
    });
  }
  const raw = await response.text();
  const text = htmlToRoughText(raw).slice(0, MAX_PAGE_CHARS);
  return { text, finalUrl: response.url || url };
}

type AccumToolCall = { id: string; name: string; arguments: string };

async function runChatRound(
  provider: OpenAiCompatibleProvider,
  messages: ChatMessage[],
  model: string,
  tools: ToolFunctionDef[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: AccumToolCall[]; error?: AppError }> {
  const byIndex = new Map<number, AccumToolCall>();
  let content = "";
  let error: AppError | undefined;

  for await (const chunk of provider.chat(messages, {
    model,
    tools,
    ...(signal ? { signal } : {}),
  })) {
    if (signal?.aborted) {
      error = new AppError({
        code: "PROVIDER_ERROR",
        userMessage: "Fetch cancelled.",
        technicalDetail: "AbortSignal aborted during chat",
      });
      break;
    }
    if (chunk.type === "content") content += chunk.delta;
    if (chunk.type === "tool_call") {
      const current = byIndex.get(chunk.index) ?? {
        id: chunk.id,
        name: chunk.name,
        arguments: "",
      };
      if (chunk.id) current.id = chunk.id;
      if (chunk.name) current.name = chunk.name;
      current.arguments += chunk.argumentsDelta;
      byIndex.set(chunk.index, current);
    }
    if (chunk.type === "error") {
      error = chunk.error;
      break;
    }
  }

  return {
    content,
    toolCalls: [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c),
    ...(error ? { error } : {}),
  };
}

function coerceContextWindowTokens(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 4_000 && n <= 10_000_000) return n;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return coerceContextWindowTokens(Number(value.trim()));
  }
  return undefined;
}

function parseSubmitArgs(
  raw: string,
): { pricing: ProviderPricing; contextWindowTokens?: number } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const contextWindowTokens = coerceContextWindowTokens(
      parsed.contextWindowTokens ?? parsed.context_length,
    );
    const { contextWindowTokens: _drop, context_length: _drop2, ...rest } =
      parsed;
    void _drop;
    void _drop2;
    const result = ProviderPricingSchema.safeParse({
      ...rest,
      fetchedAt: new Date().toISOString(),
    });
    if (!result.success) return null;
    return {
      pricing: result.data,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
    };
  } catch {
    return null;
  }
}

function cancelledResponse(
  docsUrl: string | null,
  pageFetched: boolean,
): ProviderFetchPricingResponse {
  return {
    ok: false,
    cancelled: true,
    docsUrl,
    pageFetched,
    error: {
      code: "PROVIDER_ERROR",
      userMessage: "Fetch cancelled.",
      technicalDetail: "AbortSignal aborted",
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError({
      code: "PROVIDER_ERROR",
      userMessage: "Fetch cancelled.",
      technicalDetail: "AbortSignal aborted",
    });
  }
}

export async function fetchProviderPricingOnline(input: {
  store: ProviderRegistryStore;
  request: ProviderFetchPricingRequest;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ProviderFetchPricingResponse> {
  const { store, request, signal } = input;
  const log = (message: string) => {
    try {
      input.onProgress?.(message);
    } catch {
      /* ignore UI progress errors */
    }
  };
  const docsUrl =
    request.docsUrl?.trim() ||
    guessPricingDocsUrl(request.target.baseUrl) ||
    null;

  let lookup: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };

  log("Resolving lookup provider…");
  if (request.lookupDraft) {
    lookup = {
      baseUrl: request.lookupDraft.baseUrl,
      apiKey: request.lookupDraft.apiKey,
      model: request.lookupDraft.model,
    };
    log(`Using draft credentials · model ${lookup.model}`);
  } else {
    const id = request.lookupProviderId!;
    const registry = store.loadRegistry();
    const saved = registry.providers.find((p) => p.id === id);
    if (!saved) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          userMessage: "Lookup provider not found.",
          technicalDetail: `Unknown provider id: ${id}`,
        },
      };
    }
    lookup = {
      baseUrl: saved.baseUrl,
      apiKey: await store.getApiKey(saved.id),
      model: saved.defaultModel,
    };
    log(`Using saved provider “${saved.name}” · ${lookup.model}`);
  }

  throwIfAborted(signal);

  const provider = new OpenAiCompatibleProvider({
    baseUrl: lookup.baseUrl,
    apiKey: lookup.apiKey,
    defaultModel: lookup.model,
    // Disable thinking for structured tool extraction.
    thinking: false,
  });

  let pageFetched = false;
  let pageText: string | null = null;
  let resolvedDocsUrl = docsUrl;

  if (docsUrl) {
    log(`Fetching docs page…\n${docsUrl}`);
    try {
      const page = await fetchPricingPageText(docsUrl, signal);
      pageText = page.text;
      resolvedDocsUrl = page.finalUrl;
      pageFetched = Boolean(pageText);
      log(
        `Docs page loaded (${pageText?.length ?? 0} chars)${
          page.finalUrl !== docsUrl ? `\n→ ${page.finalUrl}` : ""
        }`,
      );
    } catch (err) {
      if (signal?.aborted) {
        return cancelledResponse(resolvedDocsUrl, pageFetched);
      }
      const msg =
        err instanceof AppError
          ? err.userMessage
          : err instanceof Error
            ? err.message
            : String(err);
      log(`Docs page fetch failed: ${msg} — LLM may still fetch another URL`);
      pageFetched = false;
    }
  } else {
    log("No docs URL yet — model may call fetch_pricing_page");
  }

  throwIfAborted(signal);

  const targetLabel =
    request.target.name?.trim() ||
    request.target.defaultModel?.trim() ||
    request.target.baseUrl;

  const system = [
    "You extract public API token pricing into structured USD rates per 1 million tokens.",
    "Also extract the context window (max input context tokens) for the target default model when the docs state it.",
    "Units for prices must be USD per 1M tokens (not per 1K).",
    "If the page lists cache hit vs miss and/or peak vs off-peak, fill those fields.",
    "Peak windows must be UTC in HH:MM.",
    "When multiple models are priced, put each under byModel keyed by exact model id.",
    "Also set flat input/output (or cache miss) to a sensible default for the primary/default model.",
    "Set contextWindowTokens to an integer (e.g. 128000) for the default model when documented; omit if unknown — do not invent.",
    "Call submit_provider_pricing exactly once when done. Prefer fetch_pricing_page if you need another URL (pricing or model limits page).",
  ].join(" ");

  const userParts = [
    `Target provider: ${targetLabel}`,
    `Base URL: ${request.target.baseUrl}`,
    request.target.defaultModel
      ? `Default model: ${request.target.defaultModel}`
      : null,
    resolvedDocsUrl ? `Suggested docs URL: ${resolvedDocsUrl}` : null,
    pageText
      ? `Pricing page text (truncated):\n${pageText}`
      : "No page text yet — use fetch_pricing_page with the suggested URL or a better official pricing URL, then submit_provider_pricing.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userParts },
  ];

  const tools = [SUBMIT_PRICING_TOOL, FETCH_PAGE_TOOL];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      throwIfAborted(signal);
      log(`LLM round ${round + 1}/${MAX_ROUNDS}…`);
      const turn = await runChatRound(
        provider,
        messages,
        lookup.model,
        tools,
        signal,
      );
      if (signal?.aborted) {
        provider.cancel();
        return cancelledResponse(resolvedDocsUrl, pageFetched);
      }
      if (turn.error) {
        if (signal?.aborted) {
          return cancelledResponse(resolvedDocsUrl, pageFetched);
        }
        log(`LLM error: ${turn.error.userMessage}`);
        return {
          ok: false,
          docsUrl: resolvedDocsUrl,
          pageFetched,
          error: {
            code: turn.error.code,
            userMessage: turn.error.userMessage,
            technicalDetail: turn.error.technicalDetail,
          },
        };
      }

      if (turn.toolCalls.length === 0) {
        log(
          turn.content.trim()
            ? `Model replied without tools (${turn.content.trim().length} chars)`
            : "Model replied without tools",
        );
        // Try to parse JSON from prose as last resort on final round.
        if (round === MAX_ROUNDS - 1 && turn.content.trim()) {
          const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(turn.content);
          const candidate = fenced?.[1]?.trim() ?? turn.content.trim();
          const pricing = parseSubmitArgs(candidate);
          if (pricing) {
            log("Parsed pricing from final prose reply");
            return {
              ok: true,
              pricing: {
                ...pricing.pricing,
                ...(resolvedDocsUrl && !pricing.pricing.sourceUrl
                  ? { sourceUrl: resolvedDocsUrl }
                  : {}),
              },
              ...(pricing.contextWindowTokens != null
                ? { contextWindowTokens: pricing.contextWindowTokens }
                : {}),
              docsUrl: resolvedDocsUrl,
              pageFetched,
            };
          }
        }
        messages.push({
          role: "assistant",
          content: turn.content || null,
        });
        messages.push({
          role: "user",
          content:
            "You must call the submit_provider_pricing tool with numeric USD-per-1M rates.",
        });
        continue;
      }

      log(
        `Tools: ${turn.toolCalls.map((c) => c.name).join(", ")}`,
      );
      messages.push({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
        })),
      });

      for (const call of turn.toolCalls) {
        throwIfAborted(signal);
        if (call.name === "submit_provider_pricing") {
          const submitted = parseSubmitArgs(call.arguments);
          if (!submitted) {
            log("submit_provider_pricing rejected — invalid payload");
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content:
                "Invalid pricing payload. Resubmit with valid numbers and HH:MM peak windows.",
            });
            continue;
          }
          log(
            submitted.contextWindowTokens != null
              ? `Got pricing + context window ${submitted.contextWindowTokens.toLocaleString()}`
              : "Got pricing (no context window in docs)",
          );
          return {
            ok: true,
            pricing: {
              ...submitted.pricing,
              ...(resolvedDocsUrl && !submitted.pricing.sourceUrl
                ? { sourceUrl: resolvedDocsUrl }
                : {}),
            },
            ...(submitted.contextWindowTokens != null
              ? { contextWindowTokens: submitted.contextWindowTokens }
              : {}),
            docsUrl: resolvedDocsUrl,
            pageFetched,
          };
        }

        if (call.name === "fetch_pricing_page") {
          let url = resolvedDocsUrl ?? "";
          try {
            const args = JSON.parse(call.arguments) as { url?: string };
            if (args.url?.trim()) url = args.url.trim();
          } catch {
            /* keep suggested */
          }
          if (!url) {
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Missing url. Provide an https pricing docs URL.",
            });
            continue;
          }
          log(`Fetching page…\n${url}`);
          try {
            const page = await fetchPricingPageText(url, signal);
            resolvedDocsUrl = page.finalUrl;
            pageText = page.text;
            pageFetched = true;
            log(`Page loaded (${page.text.length} chars)`);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: page.text || "(empty page)",
            });
          } catch (err) {
            if (signal?.aborted) {
              return cancelledResponse(resolvedDocsUrl, pageFetched);
            }
            const msg =
              err instanceof AppError
                ? err.userMessage
                : err instanceof Error
                  ? err.message
                  : String(err);
            log(`Page fetch failed: ${msg}`);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Fetch failed: ${msg}`,
            });
          }
        } else {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Unknown tool: ${call.name}`,
          });
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      provider.cancel();
      return cancelledResponse(resolvedDocsUrl, pageFetched);
    }
    throw err;
  }

  log("Gave up — submit_provider_pricing never returned valid data");
  return {
    ok: false,
    docsUrl: resolvedDocsUrl,
    pageFetched,
    error: {
      code: "PROVIDER_ERROR",
      userMessage:
        "Could not extract pricing. Try another lookup provider or paste rates manually.",
      technicalDetail: "submit_provider_pricing was not called with valid data",
    },
  };
}
