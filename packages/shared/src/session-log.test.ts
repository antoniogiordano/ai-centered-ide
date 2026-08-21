import { describe, expect, it } from "vitest";
import {
  applyUsageToSessionLog,
  appendSessionError,
  emptySessionLog,
  formatDurationMs,
  phaseDurationTotals,
  sessionLogTotals,
  setSessionOutcome,
  snapshotPricing,
} from "./session-log.js";

describe("session log", () => {
  it("splits P/C/B/T time and tokens by model", () => {
    const started = "2026-08-20T08:00:00.000Z";
    let log = emptySessionLog({ sessionId: "s1", startedAt: started });
    log = applyUsageToSessionLog(
      log,
      { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100 },
      {
        model: "deepseek-v4-pro",
        providerId: "p1",
        providerName: "DeepSeek",
        paid: true,
        pricing: { inputPer1M: 0.14, outputPer1M: 0.28 },
        phase: "planning",
        at: "2026-08-20T08:01:00.000Z",
      },
    );
    log = applyUsageToSessionLog(
      log,
      { inputTokens: 4000, outputTokens: 800 },
      {
        model: "deepseek-v4-flash",
        providerId: "p1",
        providerName: "DeepSeek",
        paid: true,
        pricing: { inputPer1M: 0.07, outputPer1M: 0.14 },
        phase: "building",
        at: "2026-08-20T08:10:00.000Z",
      },
    );
    log = setSessionOutcome(log, {
      outcome: "commit",
      detail: "feat/roman-svg-icons",
      at: "2026-08-20T08:20:00.000Z",
      end: true,
    });

    expect(log.models).toHaveLength(2);
    expect(log.phases).toHaveLength(2);
    expect(log.phases[0]?.phase).toBe("planning");
    expect(log.phases[0]?.endedAt).toBe("2026-08-20T08:10:00.000Z");
    expect(log.phases[1]?.phase).toBe("building");
    expect(log.phases[1]?.model).toBe("deepseek-v4-flash");
    expect(log.outcome).toBe("commit");
    const totals = phaseDurationTotals(log, Date.parse("2026-08-20T08:20:00.000Z"));
    expect(totals.planning).toBe(9 * 60 * 1000);
    expect(totals.building).toBe(10 * 60 * 1000);
    const sum = sessionLogTotals(log);
    expect(sum.inputTokens).toBe(5000);
    expect(sum.costUsd).toBeGreaterThan(0);
  });

  it("snapshots the rates that were live when tokens landed", () => {
    const snap = snapshotPricing({
      model: "gpt-4o",
      providerId: "p",
      providerName: "OpenAI",
      paid: true,
      pricing: { inputPer1M: 2.5, outputPer1M: 10 },
      at: new Date("2026-08-20T08:00:00.000Z"),
    });
    expect(snap?.inputPer1M).toBe(2.5);
    expect(snap?.outputPer1M).toBe(10);
    expect(snap?.capturedAt).toBe("2026-08-20T08:00:00.000Z");
  });

  it("dedupes the same error while the phase is unchanged", () => {
    let log = emptySessionLog({ sessionId: "s1" });
    log = appendSessionError(log, {
      message: "Provider timeout",
      phase: "building",
    });
    log = appendSessionError(log, {
      message: "Provider timeout",
      phase: "building",
    });
    expect(log.errors).toHaveLength(1);
  });

  it("formats durations compactly", () => {
    expect(formatDurationMs(800)).toBe("800ms");
    expect(formatDurationMs(12_000)).toBe("12s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
  });
});
