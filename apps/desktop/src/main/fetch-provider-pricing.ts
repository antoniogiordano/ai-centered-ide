import {
  AppError,
  ProviderModelCatalogEntrySchema,
  ProviderModelPricingSchema,
  ProviderPricingSchema,
  catalogEntryHasHint,
  fillCatalogGaps,
  guessPricingDocsUrls,
  inferProviderKind,
  mergeProviderModels,
  pickLookupModelIds,
  SEQUENTIAL_LOOKUP_LIMIT,
  type ProviderFetchPricingRequest,
  type ProviderFetchPricingResponse,
  type ProviderKind,
  type ProviderModelCatalogEntry,
  type ProviderModelPricing,
  type ProviderPricing,
} from "@ai-ide/shared";
import {
  AiSdkProvider,
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

const MODEL_CAP_PROPS = {
  type: "object",
  additionalProperties: false,
  properties: {
    vision: {
      type: "boolean",
      description: "True if the model accepts images. Omit if unknown.",
    },
    tools: {
      type: "boolean",
      description:
        "True if the model supports function / tool calling. Omit if unknown.",
    },
    contextWindowTokens: {
      type: "number",
      description: "Context window in tokens. Omit if unknown.",
    },
  },
} as const;

const SUBMIT_PRICING_TOOL: ToolFunctionDef = {
  name: "submit_provider_pricing",
  description:
    "Submit structured USD-per-1M-token pricing plus per-model capabilities (vision, tools, context window). Always call this once, even when some fields are unknown — omit those instead of inventing. Prefer cache hit/miss and peak/off-peak when the page lists them.",
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
        description: "Per-model rates keyed by exact model id",
      },
      byModelCapabilities: {
        type: "object",
        additionalProperties: MODEL_CAP_PROPS,
        description:
          "Per-model vision / tools / context window keyed by exact model id. Omit a field when the docs do not say.",
      },
      sourceUrl: { type: "string" },
      notes: {
        type: "string",
        description: "Short notes (peak hours, units, caveats, missing data)",
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
const MAX_ROUNDS_PER_MODEL = 3;
const LATER_PAGE_CHARS = 8_000;

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

type PageCache = Map<string, { text: string; finalUrl: string }>;
type PageFailureCache = Map<string, string>;

function pageCacheKey(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function rememberPage(
  cache: PageCache,
  url: string,
  page: { text: string; finalUrl: string },
): void {
  cache.set(pageCacheKey(url), page);
  if (page.finalUrl) cache.set(pageCacheKey(page.finalUrl), page);
}

/** Model cards must not replace the session pricing docs URL. */
function isPricingDocsUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.includes("pricing") && !path.includes("/models/");
  } catch {
    return false;
  }
}

type CachedPageResult =
  | { ok: true; text: string; finalUrl: string; cached: boolean }
  | { ok: false; message: string; cached: boolean };

async function fetchPricingPageCached(
  url: string,
  cache: PageCache,
  failures: PageFailureCache,
  signal?: AbortSignal,
): Promise<CachedPageResult> {
  const key = pageCacheKey(url);
  const failed = failures.get(key);
  if (failed) return { ok: false, message: failed, cached: true };
  const hit = cache.get(key);
  if (hit) return { ok: true, ...hit, cached: true };
  try {
    const page = await fetchPricingPageText(url, signal);
    rememberPage(cache, url, page);
    return { ok: true, ...page, cached: false };
  } catch (err) {
    if (signal?.aborted) throw err;
    const message =
      err instanceof AppError
        ? err.userMessage
        : err instanceof Error
          ? err.message
          : "Could not fetch pricing page.";
    failures.set(key, message);
    return { ok: false, message, cached: false };
  }
}

type AccumToolCall = { id: string; name: string; arguments: string };

async function runChatRound(
  provider: AiSdkProvider,
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

function parseModelCapabilities(
  raw: unknown,
): ProviderModelCatalogEntry[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const models: ProviderModelCatalogEntry[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim()) continue;
    const parsed = ProviderModelCatalogEntrySchema.safeParse({
      id,
      ...(value && typeof value === "object" ? value : {}),
      source: "fetched",
    });
    if (parsed.success) models.push(parsed.data);
  }
  return models.length ? models : undefined;
}

function sanitizeSubmitRecord(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...parsed };
  if (next.byModel && typeof next.byModel === "object" && !Array.isArray(next.byModel)) {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      next.byModel as Record<string, unknown>,
    )) {
      const band = ProviderModelPricingSchema.safeParse(value);
      if (band.success) clean[key] = band.data;
    }
    if (Object.keys(clean).length) next.byModel = clean;
    else delete next.byModel;
  }
  return next;
}

function parseSubmitArgs(raw: string): {
  pricing: ProviderPricing;
  contextWindowTokens?: number;
  models?: ProviderModelCatalogEntry[];
} | null {
  try {
    const parsed = sanitizeSubmitRecord(
      JSON.parse(raw) as Record<string, unknown>,
    );
    const contextWindowTokens = coerceContextWindowTokens(
      parsed.contextWindowTokens ?? parsed.context_length,
    );
    const models = parseModelCapabilities(parsed.byModelCapabilities);
    const {
      contextWindowTokens: _drop,
      context_length: _drop2,
      byModelCapabilities: _drop3,
      ...rest
    } = parsed;
    void _drop;
    void _drop2;
    void _drop3;
    const fetchedAt = new Date().toISOString();
    const result = ProviderPricingSchema.safeParse({
      ...rest,
      fetchedAt,
    });
    if (!result.success) {
      if (!models?.length) return null;
      return {
        pricing: {
          fetchedAt,
          notes:
            "Capabilities extracted; rate fields were invalid and were dropped.",
        },
        ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
        models,
      };
    }
    return {
      pricing: result.data,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
      ...(models ? { models } : {}),
    };
  } catch {
    return null;
  }
}

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const trimmed = url?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Marketing SPAs often return nav chrome with no rates. */
function pageLooksUseful(text: string): boolean {
  if (text.length < 2_000) return false;
  return /\$|usd|\/1m|per\s*1\s*m|input token|output token|pricing|context window/i.test(
    text,
  );
}

function mergeFetchedCatalog(
  hinted: ProviderModelCatalogEntry[],
  incoming: ProviderModelCatalogEntry[] | undefined,
): ProviderModelCatalogEntry[] {
  return fillCatalogGaps(mergeProviderModels(hinted, incoming ?? []));
}

type LookupProgress = {
  message: string;
  models?: ProviderModelCatalogEntry[];
  pricing?: ProviderPricing;
  contextWindowTokens?: number;
  modelId?: string;
  index?: number;
  total?: number;
};

type ExtractedOne = {
  pricing: ProviderPricing;
  contextWindowTokens?: number;
  models?: ProviderModelCatalogEntry[];
};

function pricingHasRates(pricing: ProviderPricing): boolean {
  if (
    pricing.inputPer1M != null ||
    pricing.outputPer1M != null ||
    pricing.inputCacheHitPer1M != null ||
    pricing.inputCacheMissPer1M != null ||
    Boolean(pricing.schedule)
  ) {
    return true;
  }
  return Object.values(pricing.byModel ?? {}).some(
    (band) =>
      band.inputPer1M != null ||
      band.outputPer1M != null ||
      band.inputCacheHitPer1M != null ||
      band.inputCacheMissPer1M != null ||
      Boolean(band.schedule),
  );
}

function modelBandHasRates(band: ProviderModelPricing | undefined): boolean {
  if (!band) return false;
  return (
    band.inputPer1M != null ||
    band.outputPer1M != null ||
    band.inputCacheHitPer1M != null ||
    band.inputCacheMissPer1M != null ||
    Boolean(band.schedule)
  );
}

function pinRatesToModel(
  modelId: string,
  pricing: ProviderPricing,
): ProviderPricing {
  const existing = pricing.byModel?.[modelId];
  if (modelBandHasRates(existing)) {
    return pricing;
  }
  const pinned = {
    ...(pricing.inputPer1M != null ? { inputPer1M: pricing.inputPer1M } : {}),
    ...(pricing.outputPer1M != null ? { outputPer1M: pricing.outputPer1M } : {}),
    ...(pricing.inputCacheHitPer1M != null
      ? { inputCacheHitPer1M: pricing.inputCacheHitPer1M }
      : {}),
    ...(pricing.inputCacheMissPer1M != null
      ? { inputCacheMissPer1M: pricing.inputCacheMissPer1M }
      : {}),
    ...(pricing.schedule ? { schedule: pricing.schedule } : {}),
    ...existing,
  };
  if (!Object.keys(pinned).length) return pricing;
  return {
    ...pricing,
    byModel: { ...pricing.byModel, [modelId]: pinned },
  };
}

function mergePricing(
  base: ProviderPricing | undefined,
  incoming: ProviderPricing,
): ProviderPricing {
  return {
    ...base,
    ...incoming,
    byModel: { ...base?.byModel, ...incoming.byModel },
  };
}

async function extractOneModel(input: {
  provider: AiSdkProvider;
  lookupModel: string;
  system: string;
  userContent: string;
  pageText: string | null;
  resolvedDocsUrl: string | null;
  pageFetched: boolean;
  pageCache: PageCache;
  pageFailures: PageFailureCache;
  signal?: AbortSignal;
  log: (message: string) => void;
}): Promise<{
  submitted: ExtractedOne | null;
  pageText: string | null;
  resolvedDocsUrl: string | null;
  pageFetched: boolean;
  error?: AppError;
}> {
  const { provider, lookupModel, system, pageCache, pageFailures, signal, log } =
    input;
  let { pageText, resolvedDocsUrl, pageFetched } = input;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: input.userContent },
  ];
  const tools = [SUBMIT_PRICING_TOOL, FETCH_PAGE_TOOL];

  for (let round = 0; round < MAX_ROUNDS_PER_MODEL; round++) {
    throwIfAborted(signal);
    const turn = await runChatRound(
      provider,
      messages,
      lookupModel,
      tools,
      signal,
    );
    if (signal?.aborted) {
      provider.cancel();
      return { submitted: null, pageText, resolvedDocsUrl, pageFetched };
    }
    if (turn.error) {
      log(`  LLM error: ${turn.error.userMessage}`);
      return {
        submitted: null,
        pageText,
        resolvedDocsUrl,
        pageFetched,
        error: turn.error,
      };
    }

    if (turn.toolCalls.length === 0) {
      if (round === MAX_ROUNDS_PER_MODEL - 1 && turn.content.trim()) {
        const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(turn.content);
        const candidate = fenced?.[1]?.trim() ?? turn.content.trim();
        const parsed = parseSubmitArgs(candidate);
        if (parsed) return { submitted: parsed, pageText, resolvedDocsUrl, pageFetched };
      }
      messages.push({ role: "assistant", content: turn.content || null });
      messages.push({
        role: "user",
        content:
          "Call submit_provider_pricing for this one model id only. Omit prices if the docs do not list them.",
      });
      continue;
    }

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
          log(
            `  submit rejected (${call.arguments.length} chars) — retrying`,
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              "Invalid pricing payload. Resubmit with valid numbers and HH:MM peak windows.",
          });
          continue;
        }
        return { submitted, pageText, resolvedDocsUrl, pageFetched };
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
        try {
          const page = await fetchPricingPageCached(
            url,
            pageCache,
            pageFailures,
            signal,
          );
          if (!page.ok) {
            log(
              page.cached
                ? `  Page cache: still failing\n  ${url}\n  ${page.message}`
                : `  Page fetch failed: ${page.message}\n  ${url} — submit with docs you already have`,
            );
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Fetch failed: ${page.message}. Do not retry this URL. Submit capabilities/rates from the docs text you already have, or omit prices.`,
            });
            continue;
          }
          if (isPricingDocsUrl(page.finalUrl) || isPricingDocsUrl(url)) {
            resolvedDocsUrl = page.finalUrl;
          }
          pageText = page.text;
          pageFetched = true;
          log(
            page.cached
              ? `  Page cache hit (${page.text.length} chars)\n  ${url}`
              : `  Fetching page…\n  ${url}\n  Page loaded (${page.text.length} chars)`,
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: page.text || "(empty page)",
          });
        } catch (err) {
          if (signal?.aborted) {
            return { submitted: null, pageText, resolvedDocsUrl, pageFetched };
          }
          throw err;
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

  return { submitted: null, pageText, resolvedDocsUrl, pageFetched };
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
  onProgress?: (event: LookupProgress) => void;
}): Promise<ProviderFetchPricingResponse> {
  const { store, request, signal } = input;
  const log = (message: string, extra?: Omit<LookupProgress, "message">) => {
    try {
      input.onProgress?.({ message, ...extra });
    } catch {
      /* ignore UI progress errors */
    }
  };
  const candidateDocsUrls = uniqueUrls([
    request.docsUrl,
    ...guessPricingDocsUrls(request.target.baseUrl),
  ]);
  const docsUrl = candidateDocsUrls[0] ?? null;

  let lookup: {
    baseUrl: string;
    apiKey: string;
    model: string;
    kind: ProviderKind;
  };

  log("Resolving lookup provider…");
  if (request.lookupDraft) {
    lookup = {
      baseUrl: request.lookupDraft.baseUrl,
      apiKey: request.lookupDraft.apiKey,
      model: request.lookupModel?.trim() || request.lookupDraft.model,
      kind:
        request.lookupDraft.kind ?? inferProviderKind(request.lookupDraft.baseUrl),
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
      model: request.lookupModel?.trim() || saved.defaultModel,
      kind: saved.kind,
    };
    log(`Using saved provider “${saved.name}” · ${lookup.model}`);
  }

  throwIfAborted(signal);

  const provider = new AiSdkProvider({
    kind: lookup.kind,
    baseUrl: lookup.baseUrl,
    apiKey: lookup.apiKey,
    defaultModel: lookup.model,
    // Disable thinking for structured tool extraction.
    thinking: false,
  });

  let pageFetched = false;
  let pageText: string | null = null;
  let resolvedDocsUrl = docsUrl;
  const pageCache: PageCache = new Map();
  const pageFailures: PageFailureCache = new Map();

  if (candidateDocsUrls.length === 0) {
    log("No docs URL yet — model may call fetch_pricing_page");
  } else {
    for (const url of candidateDocsUrls.slice(0, 3)) {
      throwIfAborted(signal);
      log(`Fetching docs page…\n${url}`);
      try {
        const page = await fetchPricingPageCached(
          url,
          pageCache,
          pageFailures,
          signal,
        );
        if (!page.ok) {
          log(`Docs page fetch failed: ${page.message}`);
          continue;
        }
        const useful = pageLooksUseful(page.text);
        log(
          `${page.cached ? "Docs page cache hit" : "Docs page loaded"} (${page.text.length} chars)${
            useful ? "" : " — looks like a JS shell, trying next URL"
          }${page.finalUrl !== url ? `\n→ ${page.finalUrl}` : ""}`,
        );
        if (useful || !pageText) {
          pageText = page.text;
          resolvedDocsUrl = page.finalUrl;
          pageFetched = Boolean(page.text);
        }
        if (useful) break;
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
        log(`Docs page fetch failed: ${msg}`);
      }
    }
    if (pageText && !pageLooksUseful(pageText)) {
      log(
        "Docs text is still thin — lookup will try fetch_pricing_page or keep name hints",
      );
    }
  }

  throwIfAborted(signal);

  const targetLabel =
    request.target.name?.trim() ||
    request.target.defaultModel?.trim() ||
    request.target.baseUrl;

  const listedIds = (request.target.modelIds ?? []).filter(Boolean);
  const picked = pickLookupModelIds({
    modelIds: listedIds,
    limit: SEQUENTIAL_LOOKUP_LIMIT,
    ...(request.target.defaultModel
      ? { defaultModel: request.target.defaultModel }
      : {}),
  });
  const queue =
    picked.send.length > 0
      ? picked.send
      : request.target.defaultModel?.trim()
        ? [request.target.defaultModel.trim()]
        : [];
  let catalog = fillCatalogGaps(
    listedIds.map((id) => ({ id, source: "fetched" as const })),
  );
  const hintedCount = catalog.filter(catalogEntryHasHint).length;
  if (listedIds.length) {
    log(
      `Catalog has ${listedIds.length} model${
        listedIds.length === 1 ? "" : "s"
      } — looking up ${queue.length} one by one${
        picked.skipped
          ? ` (skipped ${picked.skipped} fine-tunes / audio / embeddings / snapshots)`
          : ""
      }`,
    );
  }
  if (hintedCount) {
    log(
      `Pre-filled ${hintedCount}/${listedIds.length || hintedCount} models from name hints`,
      { models: catalog },
    );
  }

  const system = [
    "You extract public API token pricing and capabilities for exactly one model id.",
    "Fill byModel and byModelCapabilities keyed by that exact id only.",
    "For local servers (LM Studio, Ollama, llama.cpp) use the vendor docs or Hugging Face: VL / llava / mmproj / gemma-3-it-vision usually have vision; most instruct models have tools, embedding-only models do not.",
    "Omit a capability when you are not sure. Never invent a yes or a price.",
    "Units for prices must be USD per 1M tokens (not per 1K). Local / unpaid servers can omit rates.",
    "If the page lists cache hit vs miss and/or peak vs off-peak, fill those fields. Peak windows must be UTC in HH:MM.",
    "Set contextWindowTokens when documented; omit if unknown.",
    "If the fetched page is a JavaScript shell, call fetch_pricing_page on another official HTML/docs URL.",
    "Do not fetch a URL whose text is already attached — reuse it.",
    "If fetch_pricing_page fails (403, 404, …), do not retry that URL. Submit from the docs you already have, or omit prices.",
    "If you still have no rates, call submit_provider_pricing with capabilities only.",
    "Call submit_provider_pricing exactly once.",
  ].join(" ");

  let pricing: ProviderPricing = {
    fetchedAt: new Date().toISOString(),
    ...(resolvedDocsUrl ? { sourceUrl: resolvedDocsUrl } : {}),
  };
  const defaultModelId = request.target.defaultModel?.trim() ?? "";
  let contextWindowTokens: number | undefined = defaultModelId
    ? catalog.find((entry) => entry.id === defaultModelId)?.contextWindowTokens
    : undefined;

  try {
    for (let i = 0; i < queue.length; i++) {
      throwIfAborted(signal);
      const modelId = queue[i]!;
      log(`Model ${i + 1}/${queue.length}: ${modelId}`, {
        modelId,
        index: i + 1,
        total: queue.length,
      });
      const excerpt =
        i === 0
          ? pageText
          : pageText
            ? pageText.slice(0, LATER_PAGE_CHARS)
            : null;
      const blockedUrls = [...pageFailures.keys()];
      const userContent = [
        `Target provider: ${targetLabel}`,
        `Base URL: ${request.target.baseUrl}`,
        `Model id (only this one): ${modelId}`,
        resolvedDocsUrl ? `Suggested docs URL: ${resolvedDocsUrl}` : null,
        blockedUrls.length
          ? `Do not fetch these URLs (already failed): ${blockedUrls.join(", ")}`
          : null,
        excerpt
          ? `Docs text (truncated):\n${excerpt}`
          : "No page text yet — use fetch_pricing_page or submit capabilities you know without inventing prices.",
      ]
        .filter(Boolean)
        .join("\n\n");

      const extracted = await extractOneModel({
        provider,
        lookupModel: lookup.model,
        system,
        userContent,
        pageText,
        resolvedDocsUrl,
        pageFetched,
        pageCache,
        pageFailures,
        ...(signal ? { signal } : {}),
        log,
      });
      pageText = extracted.pageText;
      resolvedDocsUrl = extracted.resolvedDocsUrl;
      pageFetched = extracted.pageFetched;

      if (extracted.error) {
        log(`Stopped on ${modelId}: ${extracted.error.userMessage}`);
        return {
          ok: false,
          pricing,
          ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
          ...(catalog.length ? { models: catalog } : {}),
          docsUrl: resolvedDocsUrl,
          pageFetched,
          error: {
            code: extracted.error.code,
            userMessage: `Stopped on ${modelId}: ${extracted.error.userMessage}`,
            technicalDetail: extracted.error.technicalDetail,
          },
        };
      }

      if (signal?.aborted) {
        provider.cancel();
        return {
          ok: true,
          cancelled: true,
          pricing,
          ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
          ...(catalog.length ? { models: catalog } : {}),
          docsUrl: resolvedDocsUrl,
          pageFetched,
        };
      }

      if (!extracted.submitted) {
        log(`  no structured data — keeping name hints`);
        continue;
      }

      const submitted = extracted.submitted;
      const pinned = pinRatesToModel(modelId, {
        ...submitted.pricing,
        ...(resolvedDocsUrl && !submitted.pricing.sourceUrl
          ? { sourceUrl: resolvedDocsUrl }
          : {}),
      });
      pricing = mergePricing(pricing, pinned);
      const incomingModels = [
        ...(submitted.models ?? []),
        ...(submitted.contextWindowTokens != null
          ? [
              {
                id: modelId,
                contextWindowTokens: submitted.contextWindowTokens,
                source: "fetched" as const,
              },
            ]
          : []),
      ];
      catalog = mergeFetchedCatalog(catalog, incomingModels);
      if (
        submitted.contextWindowTokens != null &&
        modelId === request.target.defaultModel
      ) {
        contextWindowTokens = submitted.contextWindowTokens;
      }
      const row = catalog.find((entry) => entry.id === modelId);
      const band = pinned.byModel?.[modelId];
      log(
        [
          `  ${modelId}`,
          row?.contextWindowTokens != null
            ? `context ${row.contextWindowTokens.toLocaleString()}`
            : null,
          row?.vision != null ? `vision ${row.vision ? "yes" : "no"}` : null,
          row?.tools != null ? `tools ${row.tools ? "yes" : "no"}` : null,
          band?.inputPer1M != null || band?.outputPer1M != null
            ? `$${band.inputPer1M ?? "—"} / $${band.outputPer1M ?? "—"}`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        {
          modelId,
          index: i + 1,
          total: queue.length,
          models: catalog.filter(
            (entry) =>
              entry.id === modelId ||
              incomingModels.some((item) => item.id === entry.id),
          ),
          pricing: pinned,
          ...(submitted.contextWindowTokens != null
            ? { contextWindowTokens: submitted.contextWindowTokens }
            : {}),
        },
      );
    }
  } catch (err) {
    if (signal?.aborted) {
      provider.cancel();
      return {
        ok: true,
        cancelled: true,
        pricing,
        ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
        ...(catalog.length ? { models: catalog } : {}),
        docsUrl: resolvedDocsUrl,
        pageFetched,
      };
    }
    throw err;
  }

  catalog = fillCatalogGaps(catalog);
  if (pricingHasRates(pricing) || catalog.some(catalogEntryHasHint)) {
    log(
      `Done — ${queue.length} lookup${queue.length === 1 ? "" : "s"}, catalog now ${catalog.length} model${catalog.length === 1 ? "" : "s"}`,
      { models: catalog, pricing },
    );
    return {
      ok: true,
      pricing,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
      ...(catalog.length ? { models: catalog } : {}),
      docsUrl: resolvedDocsUrl,
      pageFetched,
    };
  }
  log("Gave up — no model returned valid data");
  return {
    ok: false,
    docsUrl: resolvedDocsUrl,
    pageFetched,
    error: {
      code: "PROVIDER_ERROR",
      userMessage:
        "Could not extract pricing. Try another lookup provider or paste rates manually.",
      technicalDetail: "no per-model submit_provider_pricing succeeded",
    },
  };
}
