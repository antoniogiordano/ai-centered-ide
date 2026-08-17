import { z } from "zod";

const hhmm = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Expected HH:MM (24h UTC)");

/** Single band of USD rates per 1M tokens. */
export const PricingRateBandSchema = z.object({
  inputPer1M: z.number().nonnegative().optional(),
  /** Cached / prompt-cache hit input tokens. */
  inputCacheHitPer1M: z.number().nonnegative().optional(),
  /** Uncached input (cache miss). Prefer this over inputPer1M when both set. */
  inputCacheMissPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
});
export type PricingRateBand = z.infer<typeof PricingRateBandSchema>;

/** Inclusive start, exclusive end, minutes from midnight UTC. */
export const PeakWindowSchema = z.object({
  startUtc: hhmm,
  endUtc: hhmm,
});
export type PeakWindow = z.infer<typeof PeakWindowSchema>;

export const ProviderPricingScheduleSchema = z.object({
  peakWindowsUtc: z.array(PeakWindowSchema).default([]),
  peak: PricingRateBandSchema.optional(),
  offPeak: PricingRateBandSchema.optional(),
});
export type ProviderPricingSchedule = z.infer<
  typeof ProviderPricingScheduleSchema
>;

/** Per-model override (same shape as flat rates + optional schedule). */
export const ProviderModelPricingSchema = PricingRateBandSchema.extend({
  schedule: ProviderPricingScheduleSchema.optional(),
});
export type ProviderModelPricing = z.infer<typeof ProviderModelPricingSchema>;

/**
 * Optional USD rates per 1M tokens.
 * Supports flat rates, cache hit/miss, peak/off-peak schedules, and per-model
 * overrides (e.g. DeepSeek V4 Flash vs Pro).
 */
export const ProviderPricingSchema = PricingRateBandSchema.extend({
  schedule: ProviderPricingScheduleSchema.optional(),
  /** Model id → rates. When present, prefer the active model entry. */
  byModel: z.record(ProviderModelPricingSchema).optional(),
  sourceUrl: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
  fetchedAt: z.string().datetime().optional(),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

export const ProviderUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  /** Subset of inputTokens billed at cache-hit rates when known. */
  cachedInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().default(0),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

/**
 * Union of effort values across providers. OpenAI-style endpoints accept
 * none…xhigh; DeepSeek accepts low/high/max. The endpoint rejects
 * unsupported values with a 400, so the picker exposes them all.
 */
export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export const REASONING_EFFORT_VALUES = ReasoningEffortSchema.options;

export const SavedProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  baseUrl: z.string().url(),
  defaultModel: z.string().min(1),
  /** Paid / metered endpoint — show $ in the HUD. */
  paid: z.boolean().default(false),
  pricing: ProviderPricingSchema.optional(),
  /**
   * DeepSeek-style thinking / chain-of-thought.
   * When true, requests send `thinking: { type: "enabled" }` + `reasoning_effort`.
   */
  thinking: z.boolean().default(false),
  /** Effort when thinking is on (DeepSeek maps these per model). */
  reasoningEffort: ReasoningEffortSchema.default("high"),
  /**
   * Model context window in tokens (prompt + completion budget the endpoint
   * accepts). Used for Cursor-style compaction triggers (~75% of this).
   * Leave unset to use the IDE default (48k trigger).
   */
  contextWindowTokens: z.number().int().positive().max(10_000_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SavedProvider = z.infer<typeof SavedProviderSchema>;

export const ProviderRegistrySchema = z.object({
  providers: z.array(SavedProviderSchema).default([]),
  activeId: z.string().nullable().default(null),
  /** Lifetime usage totals keyed by provider id. */
  usageByProviderId: z.record(ProviderUsageSchema).default({}),
});
export type ProviderRegistry = z.infer<typeof ProviderRegistrySchema>;

/** Compact HUD payload pushed with session state. */
export const ProviderHudSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  model: z.string().nullable(),
  paid: z.boolean(),
  /** Active provider context window (tokens), if configured. */
  contextWindowTokens: z.number().int().positive().nullable().default(null),
  session: ProviderUsageSchema,
  lifetime: ProviderUsageSchema,
  /** Estimated USD for session; null when unpaid or rates unknown. */
  sessionCostUsd: z.number().nullable(),
  lifetimeCostUsd: z.number().nullable(),
});
export type ProviderHud = z.infer<typeof ProviderHudSchema>;

/** Per-model usage within a single chat session (not lifetime). */
export const SessionModelUsageSchema = z.object({
  model: z.string().min(1),
  providerId: z.string().nullable(),
  providerName: z.string(),
  paid: z.boolean(),
  usage: ProviderUsageSchema,
  /** Estimated USD for this model in the chat; null when unpaid / rates unknown. */
  costUsd: z.number().nullable(),
});
export type SessionModelUsage = z.infer<typeof SessionModelUsageSchema>;

export function emptyProviderUsage(): ProviderUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
}

export function emptyProviderRegistry(): ProviderRegistry {
  return { providers: [], activeId: null, usageByProviderId: {} };
}

export function parseHhmmToMinutes(hhmmStr: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmmStr.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function isUtcInPeakWindow(
  windows: PeakWindow[],
  at: Date = new Date(),
): boolean {
  if (!windows.length) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  for (const w of windows) {
    const start = parseHhmmToMinutes(w.startUtc);
    const end = parseHhmmToMinutes(w.endUtc);
    if (start == null || end == null) continue;
    if (start === end) continue;
    if (start < end) {
      if (minutes >= start && minutes < end) return true;
    } else {
      // Wraps midnight (e.g. 22:00–06:00).
      if (minutes >= start || minutes < end) return true;
    }
  }
  return false;
}

function bandHasRates(band: PricingRateBand | undefined | null): boolean {
  if (!band) return false;
  return (
    band.inputPer1M != null ||
    band.inputCacheHitPer1M != null ||
    band.inputCacheMissPer1M != null ||
    band.outputPer1M != null
  );
}

/**
 * Resolve the effective rate band for a provider at a point in time,
 * applying byModel + peak/off-peak when configured.
 */
export function resolvePricingBand(
  pricing: ProviderPricing | undefined | null,
  opts?: { model?: string | null; at?: Date },
): PricingRateBand | null {
  if (!pricing) return null;
  const model = opts?.model?.trim();
  const modelEntry =
    model && pricing.byModel?.[model] ? pricing.byModel[model] : undefined;

  const schedule = modelEntry?.schedule ?? pricing.schedule;
  const flat: PricingRateBand = {
    ...(pricing.inputPer1M != null ? { inputPer1M: pricing.inputPer1M } : {}),
    ...(pricing.inputCacheHitPer1M != null
      ? { inputCacheHitPer1M: pricing.inputCacheHitPer1M }
      : {}),
    ...(pricing.inputCacheMissPer1M != null
      ? { inputCacheMissPer1M: pricing.inputCacheMissPer1M }
      : {}),
    ...(pricing.outputPer1M != null
      ? { outputPer1M: pricing.outputPer1M }
      : {}),
  };
  const modelFlat: PricingRateBand = modelEntry
    ? {
        ...(modelEntry.inputPer1M != null
          ? { inputPer1M: modelEntry.inputPer1M }
          : {}),
        ...(modelEntry.inputCacheHitPer1M != null
          ? { inputCacheHitPer1M: modelEntry.inputCacheHitPer1M }
          : {}),
        ...(modelEntry.inputCacheMissPer1M != null
          ? { inputCacheMissPer1M: modelEntry.inputCacheMissPer1M }
          : {}),
        ...(modelEntry.outputPer1M != null
          ? { outputPer1M: modelEntry.outputPer1M }
          : {}),
      }
    : {};

  let band: PricingRateBand = { ...flat, ...modelFlat };

  if (schedule?.peakWindowsUtc?.length) {
    const peakNow = isUtcInPeakWindow(schedule.peakWindowsUtc, opts?.at);
    const timed = peakNow ? schedule.peak : schedule.offPeak;
    if (bandHasRates(timed)) {
      band = { ...band, ...timed };
    }
  }

  return bandHasRates(band) ? band : null;
}

export function estimateCostUsd(
  usage: ProviderUsage,
  pricing: ProviderPricing | undefined | null,
  opts?: { model?: string | null; at?: Date },
): number | null {
  const band = resolvePricingBand(pricing, opts);
  if (!band) return null;

  const cached = Math.min(
    Math.max(0, usage.cachedInputTokens ?? 0),
    Math.max(0, usage.inputTokens),
  );
  const uncached = Math.max(0, usage.inputTokens - cached);

  const hitRate = band.inputCacheHitPer1M;
  const missRate = band.inputCacheMissPer1M ?? band.inputPer1M;
  const flatInput = band.inputPer1M;

  let inputCost = 0;
  let hasInputRate = false;
  if (cached > 0 && hitRate != null) {
    inputCost += (hitRate * cached) / 1_000_000;
    hasInputRate = true;
    if (missRate != null) {
      inputCost += (missRate * uncached) / 1_000_000;
    } else if (flatInput != null) {
      inputCost += (flatInput * uncached) / 1_000_000;
    }
  } else if (missRate != null) {
    // No cache breakdown: bill all input at miss / flat input rate.
    inputCost += (missRate * usage.inputTokens) / 1_000_000;
    hasInputRate = true;
  } else if (flatInput != null) {
    inputCost += (flatInput * usage.inputTokens) / 1_000_000;
    hasInputRate = true;
  }

  const outRate = band.outputPer1M;
  let outputCost = 0;
  if (outRate != null) {
    outputCost = (outRate * usage.outputTokens) / 1_000_000;
  }

  if (!hasInputRate && outRate == null) return null;
  return inputCost + outputCost;
}

export function formatUsd(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  if (amount < 0.01 && amount > 0) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Parse a USD-per-1M rate from user input. Accepts `,` or `.` as decimal
 * separator (e.g. `2,5` / `2.5`), optional `$`/`€`, and thousand separators.
 */
export function parseUsdRate(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let s = trimmed.replace(/[€$\s]/g, "");
  if (!s) return undefined;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // 1.234,56
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // 1,234.56
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = s.replace(",", ".");
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/** Parse "01:00-04:00, 06:00-10:00" into peak windows. */
export function parsePeakWindowsUtc(raw: string): PeakWindow[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
  const windows: PeakWindow[] = [];
  for (const part of parts) {
    const m = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(part);
    if (!m) return undefined;
    const sh = Number(m[1]);
    const sm = Number(m[2]);
    const eh = Number(m[3]);
    const em = Number(m[4]);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return undefined;
    windows.push({
      startUtc: `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}`,
      endUtc: `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`,
    });
  }
  return windows.length ? windows : undefined;
}

export function formatPeakWindowsUtc(windows: PeakWindow[] | undefined): string {
  if (!windows?.length) return "";
  return windows.map((w) => `${w.startUtc}-${w.endUtc}`).join(", ");
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function addUsage(
  a: ProviderUsage,
  b: Partial<ProviderUsage>,
): ProviderUsage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
  };
}

export function accumulateSessionModelUsage(
  existing: SessionModelUsage[],
  delta: ProviderUsage,
  meta: {
    model: string;
    providerId: string | null;
    providerName: string;
    paid: boolean;
    pricing?: ProviderPricing | null;
  },
): SessionModelUsage[] {
  const model = meta.model.trim() || "unknown";
  const key = `${meta.providerId ?? "none"}::${model}`;
  const next = existing.map((row) => ({ ...row, usage: { ...row.usage } }));
  const idx = next.findIndex(
    (row) => `${row.providerId ?? "none"}::${row.model}` === key,
  );
  if (idx >= 0) {
    const row = next[idx]!;
    const usage = addUsage(row.usage, delta);
    next[idx] = {
      ...row,
      usage,
      costUsd: meta.paid
        ? estimateCostUsd(usage, meta.pricing, { model })
        : null,
    };
    return next;
  }
  const usage = addUsage(emptyProviderUsage(), delta);
  next.push({
    model,
    providerId: meta.providerId,
    providerName: meta.providerName,
    paid: meta.paid,
    usage,
    costUsd: meta.paid
      ? estimateCostUsd(usage, meta.pricing, { model })
      : null,
  });
  return next;
}

export function buildProviderHud(input: {
  registry: ProviderRegistry;
  sessionUsage: ProviderUsage;
}): ProviderHud {
  const active =
    input.registry.providers.find((p) => p.id === input.registry.activeId) ??
    null;
  const lifetime = active
    ? (input.registry.usageByProviderId[active.id] ?? emptyProviderUsage())
    : emptyProviderUsage();
  const model = active?.defaultModel ?? null;
  return {
    id: active?.id ?? null,
    name: active?.name ?? "Mock / unset",
    model,
    paid: Boolean(active?.paid),
    contextWindowTokens: active?.contextWindowTokens ?? null,
    session: input.sessionUsage,
    lifetime,
    sessionCostUsd: active?.paid
      ? estimateCostUsd(input.sessionUsage, active.pricing, { model })
      : null,
    lifetimeCostUsd: active?.paid
      ? estimateCostUsd(lifetime, active.pricing, { model })
      : null,
  };
}

/** Best-effort docs URL for known OpenAI-compatible hosts. */
export function guessPricingDocsUrl(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes("deepseek")) {
      return "https://api-docs.deepseek.com/quick_start/pricing/";
    }
    if (host.includes("openai") || host === "api.openai.com") {
      return "https://openai.com/api/pricing/";
    }
    if (host.includes("anthropic")) {
      return "https://docs.anthropic.com/en/docs/about-claude/pricing";
    }
    if (host.includes("groq")) {
      return "https://groq.com/pricing/";
    }
    if (host.includes("together")) {
      return "https://www.together.ai/pricing";
    }
    if (host.includes("fireworks")) {
      return "https://fireworks.ai/pricing";
    }
    if (host.includes("mistral")) {
      return "https://mistral.ai/products/la-plateforme#pricing";
    }
    if (host.includes("openrouter")) {
      return "https://openrouter.ai/docs/guides/routing/model-routing";
    }
    return null;
  } catch {
    return null;
  }
}

/** Migrate legacy single providerConfig preference into a registry. */
export function migrateLegacyProviderConfig(
  legacy: { baseUrl?: string; defaultModel?: string } | null | undefined,
  existing: ProviderRegistry | null | undefined,
): ProviderRegistry {
  const registry = existing
    ? ProviderRegistrySchema.parse(existing)
    : emptyProviderRegistry();
  if (registry.providers.length > 0) return registry;
  const baseUrl = legacy?.baseUrl?.trim();
  const model = legacy?.defaultModel?.trim();
  if (!baseUrl || !model) return registry;
  const now = new Date().toISOString();
  const id = "legacy-default";
  const paid = !isLikelyLocalProvider(baseUrl);
  registry.providers.push({
    id,
    name: paid ? "Default (paid)" : "Local",
    baseUrl,
    defaultModel: model,
    paid,
    thinking: false,
    reasoningEffort: "high",
    createdAt: now,
    updatedAt: now,
  });
  registry.activeId = id;
  return registry;
}

export function isLikelyLocalProvider(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function providerKeychainAccount(providerId: string): string {
  return `provider:${providerId}`;
}
