import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  formatUsd,
  migrateLegacyProviderConfig,
  formatTokenCount,
  parseUsdRate,
  SavedProviderSchema,
} from "./providers.js";

describe("provider cost helpers", () => {
  it("estimates cost from per-1M rates", () => {
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      { inputPer1M: 2.5, outputPer1M: 10 },
    );
    expect(cost).toBeCloseTo(2.5 + 5, 5);
    expect(formatUsd(cost)).toBe("$7.50");
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
  });
});
