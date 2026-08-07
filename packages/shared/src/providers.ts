import { z } from "zod";

/** Optional USD rates per 1M tokens (OpenAI-style). */
export const ProviderPricingSchema = z.object({
  inputPer1M: z.number().nonnegative().optional(),
  outputPer1M: z.number().nonnegative().optional(),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

export const ProviderUsageSchema = z.object({
  inputTokens: z.number().nonnegative().default(0),
  outputTokens: z.number().nonnegative().default(0),
});
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export const ReasoningEffortSchema = z.enum(["low", "high", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

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
  session: ProviderUsageSchema,
  lifetime: ProviderUsageSchema,
  /** Estimated USD for session; null when unpaid or rates unknown. */
  sessionCostUsd: z.number().nullable(),
  lifetimeCostUsd: z.number().nullable(),
});
export type ProviderHud = z.infer<typeof ProviderHudSchema>;

export function emptyProviderUsage(): ProviderUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function emptyProviderRegistry(): ProviderRegistry {
  return { providers: [], activeId: null, usageByProviderId: {} };
}

export function estimateCostUsd(
  usage: ProviderUsage,
  pricing: ProviderPricing | undefined | null,
): number | null {
  if (!pricing) return null;
  const inRate = pricing.inputPer1M;
  const outRate = pricing.outputPer1M;
  if (inRate == null && outRate == null) return null;
  const input = ((inRate ?? 0) * usage.inputTokens) / 1_000_000;
  const output = ((outRate ?? 0) * usage.outputTokens) / 1_000_000;
  return input + output;
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
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
  };
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
  return {
    id: active?.id ?? null,
    name: active?.name ?? "Mock / unset",
    model: active?.defaultModel ?? null,
    paid: Boolean(active?.paid),
    session: input.sessionUsage,
    lifetime,
    sessionCostUsd: active?.paid
      ? estimateCostUsd(input.sessionUsage, active.pricing)
      : null,
    lifetimeCostUsd: active?.paid
      ? estimateCostUsd(lifetime, active.pricing)
      : null,
  };
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
