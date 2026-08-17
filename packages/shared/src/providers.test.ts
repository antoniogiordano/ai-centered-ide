import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  formatPeakWindowsUtc,
  formatUsd,
  migrateLegacyProviderConfig,
  formatTokenCount,
  guessPricingDocsUrl,
  isUtcInPeakWindow,
  parsePeakWindowsUtc,
  parseUsdRate,
  resolvePricingBand,
  SavedProviderSchema,
  accumulateSessionModelUsage,
} from "./providers.js";

describe("provider cost helpers", () => {
  it("accumulates per-model usage for a chat session", () => {
    const first = accumulateSessionModelUsage(
      [],
      { inputTokens: 100, outputTokens: 20 },
      {
        model: "gpt-5.2",
        providerId: "p1",
        providerName: "OpenAI",
        paid: true,
        pricing: { inputPer1M: 2, outputPer1M: 8 },
      },
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.usage.inputTokens).toBe(100);
    expect(first[0]?.costUsd).toBeCloseTo(0.00036, 6);

    const second = accumulateSessionModelUsage(
      first,
      { inputTokens: 50, outputTokens: 0 },
      {
        model: "gpt-5.2",
        providerId: "p1",
        providerName: "OpenAI",
        paid: true,
        pricing: { inputPer1M: 2, outputPer1M: 8 },
      },
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.usage.inputTokens).toBe(150);

    const third = accumulateSessionModelUsage(
      second,
      { inputTokens: 10, outputTokens: 10 },
      {
        model: "local-model",
        providerId: "p2",
        providerName: "Ollama",
        paid: false,
      },
    );
    expect(third).toHaveLength(2);
    expect(third[1]?.costUsd).toBeNull();
  });

  it("estimates cost from per-1M rates", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { inputPer1M: 2.5, outputPer1M: 10 },
    );
    expect(cost).toBeCloseTo(2.5 + 5, 5);
    expect(formatUsd(cost)).toBe("$7.50");
  });

  it("bills cache hit vs miss when cached tokens are known", () => {
    const cost = estimateCostUsd(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 250_000,
        outputTokens: 0,
      },
      {
        inputCacheHitPer1M: 0.014,
        inputCacheMissPer1M: 0.44,
        outputPer1M: 1.32,
      },
    );
    // 0.25M * 0.014 + 0.75M * 0.44
    expect(cost).toBeCloseTo(0.25 * 0.014 + 0.75 * 0.44, 6);
  });

  it("uses miss rate for all input when cache breakdown is absent", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0 },
      { inputCacheMissPer1M: 0.44, inputPer1M: 9 },
    );
    expect(cost).toBeCloseTo(0.44, 6);
  });

  it("resolves peak vs off-peak by UTC window", () => {
    const pricing = {
      schedule: {
        peakWindowsUtc: [
          { startUtc: "01:00", endUtc: "04:00" },
          { startUtc: "06:00", endUtc: "10:00" },
        ],
        peak: { inputCacheMissPer1M: 0.44, outputPer1M: 1.32 },
        offPeak: { inputCacheMissPer1M: 0.22, outputPer1M: 0.66 },
      },
    };
    const peakAt = new Date("2026-08-17T07:30:00.000Z");
    const offAt = new Date("2026-08-17T12:00:00.000Z");
    expect(isUtcInPeakWindow(pricing.schedule.peakWindowsUtc, peakAt)).toBe(
      true,
    );
    expect(isUtcInPeakWindow(pricing.schedule.peakWindowsUtc, offAt)).toBe(
      false,
    );
    expect(resolvePricingBand(pricing, { at: peakAt })?.inputCacheMissPer1M).toBe(
      0.44,
    );
    expect(
      resolvePricingBand(pricing, { at: offAt })?.inputCacheMissPer1M,
    ).toBe(0.22);
  });

  it("prefers byModel rates for the active model", () => {
    const band = resolvePricingBand(
      {
        inputPer1M: 1,
        byModel: {
          "deepseek-v4-pro": { inputCacheMissPer1M: 1.32, outputPer1M: 3.96 },
        },
      },
      { model: "deepseek-v4-pro" },
    );
    expect(band?.inputCacheMissPer1M).toBe(1.32);
    expect(band?.outputPer1M).toBe(3.96);
  });

  it("parses and formats peak windows", () => {
    const windows = parsePeakWindowsUtc("01:00-04:00, 06:00-10:00");
    expect(windows).toEqual([
      { startUtc: "01:00", endUtc: "04:00" },
      { startUtc: "06:00", endUtc: "10:00" },
    ]);
    expect(formatPeakWindowsUtc(windows)).toBe("01:00-04:00, 06:00-10:00");
    expect(parsePeakWindowsUtc("nope")).toBeUndefined();
  });

  it("guesses DeepSeek pricing docs URL", () => {
    expect(guessPricingDocsUrl("https://api.deepseek.com")).toBe(
      "https://api-docs.deepseek.com/quick_start/pricing/",
    );
  });

  it("returns null when rates are missing", () => {
    expect(
      estimateCostUsd({ inputTokens: 10, outputTokens: 10 }, undefined),
    ).toBeNull();
    expect(formatUsd(null)).toBe("—");
  });

  it("formats token counts compactly", () => {
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(1500)).toBe("1.5k");
  });

  it("parses rates with comma or dot decimals", () => {
    expect(parseUsdRate("2,5")).toBe(2.5);
    expect(parseUsdRate("2.5")).toBe(2.5);
    expect(parseUsdRate("$10,00")).toBe(10);
    expect(parseUsdRate("1.234,56")).toBeCloseTo(1234.56);
    expect(parseUsdRate("1,234.56")).toBeCloseTo(1234.56);
    expect(parseUsdRate("")).toBeUndefined();
    expect(parseUsdRate("abc")).toBeUndefined();
  });

  it("migrates legacy single config once", () => {
    const migrated = migrateLegacyProviderConfig(
      { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
      null,
    );
    expect(migrated.providers).toHaveLength(1);
    expect(migrated.activeId).toBe("legacy-default");
    expect(migrated.providers[0]?.paid).toBe(true);
    expect(migrated.providers[0]?.thinking).toBe(false);
    expect(migrated.providers[0]?.reasoningEffort).toBe("high");

    const again = migrateLegacyProviderConfig(
      { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
      migrated,
    );
    expect(again.providers).toHaveLength(1);
  });

  it("defaults thinking fields on SavedProvider parse", () => {
    const now = new Date().toISOString();
    const parsed = SavedProviderSchema.parse({
      id: "p1",
      name: "Test",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-chat",
      createdAt: now,
      updatedAt: now,
    });
    expect(parsed.thinking).toBe(false);
    expect(parsed.reasoningEffort).toBe("high");
    expect(parsed.paid).toBe(false);
    expect(parsed.contextWindowTokens).toBeUndefined();
  });

  it("accepts contextWindowTokens on SavedProvider", () => {
    const now = new Date().toISOString();
    const parsed = SavedProviderSchema.parse({
      id: "p1",
      name: "Test",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-chat",
      contextWindowTokens: 128_000,
      createdAt: now,
      updatedAt: now,
    });
    expect(parsed.contextWindowTokens).toBe(128_000);
  });

  it("accepts DeepSeek-style nested pricing", () => {
    const now = new Date().toISOString();
    const parsed = SavedProviderSchema.parse({
      id: "p1",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      paid: true,
      pricing: {
        inputCacheHitPer1M: 0.014,
        inputCacheMissPer1M: 0.44,
        outputPer1M: 1.32,
        schedule: {
          peakWindowsUtc: [
            { startUtc: "01:00", endUtc: "04:00" },
            { startUtc: "06:00", endUtc: "10:00" },
          ],
          peak: {
            inputCacheHitPer1M: 0.014,
            inputCacheMissPer1M: 0.44,
            outputPer1M: 1.32,
          },
          offPeak: {
            inputCacheHitPer1M: 0.007,
            inputCacheMissPer1M: 0.22,
            outputPer1M: 0.66,
          },
        },
        byModel: {
          "deepseek-v4-pro": {
            schedule: {
              peakWindowsUtc: [
                { startUtc: "01:00", endUtc: "04:00" },
                { startUtc: "06:00", endUtc: "10:00" },
              ],
              peak: {
                inputCacheHitPer1M: 0.044,
                inputCacheMissPer1M: 1.32,
                outputPer1M: 3.96,
              },
              offPeak: {
                inputCacheHitPer1M: 0.022,
                inputCacheMissPer1M: 0.66,
                outputPer1M: 1.98,
              },
            },
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    expect(parsed.pricing?.schedule?.offPeak?.outputPer1M).toBe(0.66);
    expect(
      parsed.pricing?.byModel?.["deepseek-v4-pro"]?.schedule?.peak
        ?.outputPer1M,
    ).toBe(3.96);
  });
});
