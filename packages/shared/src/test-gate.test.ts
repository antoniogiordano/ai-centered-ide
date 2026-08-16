import { describe, expect, it } from "vitest";
import {
  buildTestFailureDigest,
  decideTestGateAutoContinue,
  decideTestGateEscalation,
  detectSuiteOscillation,
  discoverTestRunSpecs,
  extractRichLogExcerpt,
  fingerprintTestFailure,
  formatAgentTestReport,
  formatTestGateEscalationSystemRules,
  formatTestGateForBuildPrompt,
  parseTestSuiteInsights,
  suiteResultFromRun,
  TEST_GATE_ESCALATION_AFTER,
  TEST_GATE_PAID_AUTO_FIX_LIMIT,
  TEST_GATE_STRONG_ESCALATION_AFTER,
  testLogChunkCount,
} from "./test-gate.js";
import { createEmptyArchitectureProfile } from "./architecture.js";

describe("discoverTestRunSpecs", () => {
  it("returns empty without quality/testing commands", () => {
    expect(discoverTestRunSpecs(createEmptyArchitectureProfile("x"))).toEqual(
      [],
    );
  });

  it("maps lint, typecheck, and unit (skips e2e by default)", () => {
    const base = createEmptyArchitectureProfile("app");
    const profile = {
      ...base,
      quality: {
        lint: "pnpm lint",
        typecheck: "pnpm typecheck",
      },
      testing: {
        unit: { lib: "vitest", command: "pnpm test" },
        e2e: { lib: "playwright", command: "pnpm e2e" },
      },
    };
    const specs = discoverTestRunSpecs(profile);
    expect(specs.map((s) => s.id)).toEqual(["lint", "typecheck", "unit"]);
    expect(specs.find((s) => s.id === "unit")?.platform).toBe("vitest");
    expect(specs.find((s) => s.id === "lint")?.platform).toBe("lint");
    expect(
      discoverTestRunSpecs({
        ...profile,
        quality: { ...profile.quality, lint: "pnpm eslint ." },
      }).find((s) => s.id === "lint")?.platform,
    ).toBe("eslint");
    const withE2e = discoverTestRunSpecs(profile, { includeE2e: true });
    expect(withE2e.map((s) => s.id)).toEqual([
      "lint",
      "typecheck",
      "unit",
      "e2e",
    ]);
    const e2e = withE2e.find((s) => s.id === "e2e");
    expect(e2e?.platform).toBe("playwright");
    expect(e2e?.timeoutMs).toBe(600_000);
  });
});

describe("parseTestSuiteInsights", () => {
  it("parses Jest Tests / Test Suites lines and ● failures", () => {
    const log = `
FAIL src/components/OpeningSidebar.test.tsx
  ● searches and selects variant

    TestingLibraryElementError: Unable to find

Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 12 passed, 13 total
`;
    const insights = parseTestSuiteInsights(log, { platform: "jest" });
    expect(insights.counts).toEqual({
      failed: 1,
      passed: 12,
      skipped: 0,
      total: 13,
      suiteFilesFailed: 1,
      suiteFilesPassed: 2,
      suiteFilesTotal: 3,
    });
    expect(insights.failedTests).toContain("searches and selects variant");
    expect(insights.platform).toBe("jest");
  });

  it("parses Vitest summary", () => {
    const log = `Tests  2 failed | 10 passed (12)`;
    const insights = parseTestSuiteInsights(log);
    expect(insights.counts).toEqual({
      failed: 2,
      passed: 10,
      skipped: 0,
      total: 12,
    });
    expect(insights.platform).toBe("vitest");
  });

  it("suiteResultFromRun attaches counts", () => {
    const { result } = suiteResultFromRun({
      spec: {
        id: "unit",
        kind: "unit",
        command: "pnpm test",
        platform: "jest",
      },
      status: "failed",
      exitCode: 1,
      durationMs: 40,
      stdout: "Tests:       1 failed, 4 passed, 5 total\n● my broken test\n",
      stderr: "",
    });
    expect(result.counts?.failed).toBe(1);
    expect(result.failedTests).toContain("my broken test");
    expect(result.platform).toBe("jest");
  });

  it("formatAgentTestReport aggregates totals", () => {
    const report = formatAgentTestReport({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed",
      specs: [],
      suites: [
        {
          id: "unit",
          kind: "unit",
          command: "pnpm test",
          status: "failed",
          exitCode: 1,
          durationMs: 10,
          summary: "fail",
          logChars: 0,
          logChunkSize: 8000,
          logChunks: 0,
          platform: "jest",
          counts: { passed: 4, failed: 1, skipped: 0, total: 5 },
          failedTests: ["a"],
        },
      ],
    });
    expect(report.available).toBe(true);
    expect(report.totals).toMatchObject({ passed: 4, failed: 1, total: 5 });
  });
});

describe("decideTestGateAutoContinue", () => {
  it("always auto-continues for unpaid providers", () => {
    for (let prev = 0; prev < 20; prev++) {
      const d = decideTestGateAutoContinue({
        paidProvider: false,
        previousAttempts: prev,
      });
      expect(d.autoContinue).toBe(true);
      expect(d.circuitOpen).toBe(false);
      expect(d.attempts).toBe(prev + 1);
    }
  });

  it("opens the circuit after the paid limit", () => {
    const under = decideTestGateAutoContinue({
      paidProvider: true,
      previousAttempts: TEST_GATE_PAID_AUTO_FIX_LIMIT - 1,
    });
    expect(under).toEqual({
      attempts: TEST_GATE_PAID_AUTO_FIX_LIMIT,
      circuitOpen: false,
      autoContinue: true,
    });

    const over = decideTestGateAutoContinue({
      paidProvider: true,
      previousAttempts: TEST_GATE_PAID_AUTO_FIX_LIMIT,
    });
    expect(over).toEqual({
      attempts: TEST_GATE_PAID_AUTO_FIX_LIMIT + 1,
      circuitOpen: true,
      autoContinue: false,
    });
  });
});

describe("extractRichLogExcerpt", () => {
  it("keeps Testing Library Unable to find + Available dump", () => {
    const log = `
FAIL src/components/OpeningSidebar.test.tsx
  ● searches and selects variant

    TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "Italian Game"

    Here are the accessible roles:

      button:

      Name "famiglia Italian Game":
      <button />

      Name "preferiti variante Italian Game":
      <button />

    --------------------------------------------------

Test Suites: 1 failed, 1 total
`;
    const excerpt = extractRichLogExcerpt(log);
    expect(excerpt).toContain("Unable to find");
    expect(excerpt).toContain("Italian Game");
    expect(excerpt).toMatch(/accessible roles|famiglia Italian Game/i);
  });

  it("keeps TypeScript error lines", () => {
    const log = `src/components/OpeningSidebar.tsx(3,10): error TS2305: Module '"@/lib/openings"' has no exported member 'selectOpenings'.`;
    expect(extractRichLogExcerpt(log)).toContain("error TS2305");
  });
});

describe("decideTestGateEscalation", () => {
  it("escalates after repeated same fingerprint", () => {
    const first = decideTestGateEscalation({
      fingerprint: "unit|unable",
      previousFingerprint: null,
      previousStreak: 0,
      currentSuiteKey: "unit",
    });
    expect(first.level).toBe(0);
    expect(first.sameFailureStreak).toBe(1);

    const second = decideTestGateEscalation({
      fingerprint: "unit|unable",
      previousFingerprint: "unit|unable",
      previousStreak: 1,
      previousSuiteKeys: ["unit"],
      currentSuiteKey: "unit",
    });
    expect(second.sameFailureStreak).toBe(TEST_GATE_ESCALATION_AFTER);
    expect(second.level).toBe(1);

    const third = decideTestGateEscalation({
      fingerprint: "unit|unable",
      previousFingerprint: "unit|unable",
      previousStreak: 2,
      previousSuiteKeys: ["unit", "unit"],
      currentSuiteKey: "unit",
    });
    expect(third.sameFailureStreak).toBe(TEST_GATE_STRONG_ESCALATION_AFTER);
    expect(third.level).toBe(2);
  });

  it("detects suite oscillation as strong escalation", () => {
    const d = decideTestGateEscalation({
      fingerprint: "typecheck|ts",
      previousFingerprint: "unit|jest",
      previousStreak: 1,
      previousSuiteKeys: ["unit", "typecheck"],
      currentSuiteKey: "unit",
    });
    expect(d.oscillating).toBe(true);
    expect(d.level).toBe(2);
  });
});

describe("detectSuiteOscillation", () => {
  it("flags A→B→A", () => {
    expect(detectSuiteOscillation(["unit", "typecheck", "unit"])).toBe(true);
    expect(detectSuiteOscillation(["unit", "unit", "unit"])).toBe(false);
  });
});

describe("fingerprint + digest", () => {
  it("fingerprints from logs", () => {
    const suites = [
      {
        id: "unit",
        kind: "unit" as const,
        command: "pnpm test",
        status: "failed" as const,
        exitCode: 1,
        durationMs: 12,
        summary: "Exit 1",
        logChars: 100,
        logChunkSize: 8000,
        logChunks: 1,
        failedTests: [] as string[],
      },
    ];
    const fp = fingerprintTestFailure(
      { suites },
      {
        unit: `TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "Italian Game"`,
      },
    );
    expect(fp).toContain("unit");
    expect(fp).toMatch(/unable to find/i);
  });

  it("embeds escalation banner and log excerpt in digest", () => {
    const digest = buildTestFailureDigest(
      {
        specs: [{ id: "unit", kind: "unit", command: "pnpm test" }],
        suites: [
          {
            id: "unit",
            kind: "unit",
            command: "pnpm test",
            status: "failed",
            exitCode: 1,
            durationMs: 12,
            summary: "Exit 1\nshort",
            logChars: 100,
            logChunkSize: 8000,
            logChunks: 1,
            failedTests: [],
          },
        ],
      },
      {
        logs: {
          unit: `TestingLibraryElementError: Unable to find role "button" and name /Italian Game/
Here are the accessible roles:
  button:
  Name "famiglia Italian Game":
`,
        },
        escalation: {
          level: 1,
          sameFailureStreak: 2,
          oscillating: false,
        },
      },
    );
    expect(digest).toContain("ESCALATED");
    expect(digest).toContain("Failure excerpt");
    expect(digest).toContain("Unable to find");
  });
});

describe("test log helpers", () => {
  it("chunks by size", () => {
    expect(testLogChunkCount(0)).toBe(0);
    expect(testLogChunkCount(8000)).toBe(1);
    expect(testLogChunkCount(8001)).toBe(2);
  });
});

describe("formatTestGateForBuildPrompt", () => {
  it("lists detected suites and forbids self-running them", () => {
    const base = createEmptyArchitectureProfile("app");
    const text = formatTestGateForBuildPrompt({
      ...base,
      quality: { lint: "pnpm lint", typecheck: "pnpm typecheck" },
      testing: { unit: { lib: "vitest", command: "pnpm test" } },
    });
    expect(text).toContain("pnpm lint");
    expect(text).toMatch(/data-testid/i);
    expect(text).toMatch(/Do NOT (execute|run)/i);
  });

  it("lists the e2e suite and its self-contained requirement", () => {
    const base = createEmptyArchitectureProfile("app");
    const text = formatTestGateForBuildPrompt({
      ...base,
      testing: {
        unit: { lib: "vitest", command: "pnpm test" },
        e2e: { lib: "cypress", command: "pnpm cypress:run" },
      },
    });
    expect(text).toContain("[e2e] e2e · lib=cypress: `pnpm cypress:run`");
    expect(text).toMatch(/self-contained/i);
  });

  it("formats escalation system rules", () => {
    expect(formatTestGateEscalationSystemRules(0)).toBe("");
    expect(formatTestGateEscalationSystemRules(1)).toContain("ESCALATION");
    expect(formatTestGateEscalationSystemRules(2)).toContain("STRONG");
  });
});
