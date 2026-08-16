import type { ArchitectureProfile } from "./architecture.js";
import type {
  TestRunReport,
  TestRunSpec,
  TestSuiteCounts,
  TestSuiteKind,
  TestSuiteResult,
} from "./domain.js";

/** Cap individual failed test titles kept on a suite result. */
export const MAX_FAILED_TEST_NAMES = 40;

/** Default chunk size for `read_test_log` (chars). */
export const TEST_LOG_CHUNK_CHARS = 8_000;

/** Soft cap for the digest pushed into the agent prompt. */
export const TEST_DIGEST_MAX_CHARS = 8_000;

/** Extra excerpt from full suite logs embedded in the digest. */
export const TEST_DIGEST_LOG_EXCERPT_CHARS = 3_500;

/** E2E suites (cypress/playwright) boot browsers + dev servers: 10 min. */
export const TEST_GATE_E2E_TIMEOUT_MS = 600_000;

/** Same failure fingerprint streak before strategy escalation. */
export const TEST_GATE_ESCALATION_AFTER = 2;

/** Stronger “rewrite the test” escalation. */
export const TEST_GATE_STRONG_ESCALATION_AFTER = 3;

/**
 * Max automatic agent fix turns after a failed test gate when the active
 * provider is paid. Local/unpaid providers are uncapped.
 */
export const TEST_GATE_PAID_AUTO_FIX_LIMIT = 5;

/** Resolve a human platform label for a gate suite (vitest, jest, eslint…). */
export function platformForTestKind(
  kind: TestSuiteKind,
  profile: ArchitectureProfile | null | undefined,
  command?: string,
): string {
  const cmd = command ?? "";
  if (kind === "lint") {
    if (/eslint/i.test(cmd)) return "eslint";
    if (/biome/i.test(cmd)) return "biome";
    return "lint";
  }
  if (kind === "typecheck") {
    if (/vue-tsc/i.test(cmd)) return "vue-tsc";
    if (/tsc/i.test(cmd)) return "tsc";
    return "typecheck";
  }
  if (kind === "unit") {
    const lib = profile?.testing?.unit?.lib?.trim();
    if (lib && lib !== "none" && lib !== "custom") return lib;
    if (/vitest/i.test(cmd)) return "vitest";
    if (/jest/i.test(cmd)) return "jest";
    if (/mocha/i.test(cmd)) return "mocha";
    if (/pytest/i.test(cmd)) return "pytest";
    return "unit";
  }
  if (kind === "e2e") {
    const lib = profile?.testing?.e2e?.lib?.trim();
    if (lib && lib !== "none" && lib !== "custom") return lib;
    if (/cypress/i.test(cmd)) return "cypress";
    if (/playwright/i.test(cmd)) return "playwright";
    return "e2e";
  }
  return kind;
}

export function discoverTestRunSpecs(
  profile: ArchitectureProfile | null | undefined,
  options?: { includeE2e?: boolean },
): TestRunSpec[] {
  if (!profile) return [];
  const specs: TestRunSpec[] = [];
  const quality = profile.quality;
  if (quality?.lint?.trim()) {
    const command = quality.lint.trim();
    specs.push({
      id: "lint",
      kind: "lint",
      command,
      platform: platformForTestKind("lint", profile, command),
    });
  }
  if (quality?.typecheck?.trim()) {
    const command = quality.typecheck.trim();
    specs.push({
      id: "typecheck",
      kind: "typecheck",
      command,
      platform: platformForTestKind("typecheck", profile, command),
    });
  }
  const unitCmd = profile.testing?.unit?.command?.trim();
  if (unitCmd) {
    specs.push({
      id: "unit",
      kind: "unit",
      command: unitCmd,
      platform: platformForTestKind("unit", profile, unitCmd),
    });
  }
  if (options?.includeE2e) {
    const e2eCmd = profile.testing?.e2e?.command?.trim();
    if (e2eCmd) {
      specs.push({
        id: "e2e",
        kind: "e2e",
        command: e2eCmd,
        platform: platformForTestKind("e2e", profile, e2eCmd),
        timeoutMs: TEST_GATE_E2E_TIMEOUT_MS,
      });
    }
  }
  return specs;
}

/** Build-phase harness block: which suites the IDE will run + authoring rules. */
export function formatTestGateForBuildPrompt(
  profile: ArchitectureProfile | null | undefined,
): string {
  const specs = discoverTestRunSpecs(profile, { includeE2e: true });
  const unitLib = profile?.testing?.unit?.lib?.trim();
  const e2eLib = profile?.testing?.e2e?.lib?.trim();
  const lines: string[] = [
    "Test gate (critical — IDE-owned verification after propose_testing_ready):",
  ];
  if (specs.length === 0) {
    lines.push(
      "- No lint/typecheck/unit/e2e commands detected in the architecture profile yet.",
      "- Still write appropriate automated tests for new behavior (match the project stack).",
      "- Do NOT run lint/test/typecheck suites yourself via run_command or terminal_* during Build — after the checklist, call propose_testing_ready so the IDE runs them.",
      "- Install test runners/deps if the plan needs them; create/edit test files with replace_in_file (edits) or write_file (new files); leave execution to the IDE gate.",
    );
  } else {
    lines.push(
      "- After every checklist item is done, call propose_testing_ready; the IDE then runs these suites (do not run them yourself during Build):",
    );
    for (const spec of specs) {
      const libHint =
        spec.kind === "unit" && unitLib
          ? ` · lib=${unitLib}`
          : spec.kind === "e2e" && e2eLib
            ? ` · lib=${e2eLib}`
            : "";
      lines.push(`  - [${spec.id}] ${spec.kind}${libHint}: \`${spec.command}\``);
    }
    if (specs.some((s) => s.kind === "e2e")) {
      lines.push(
        "- The e2e command must be self-contained: the gate runs it headless with no dev server running. If it needs the app up, make the script start (and stop) it, e.g. via start-server-and-test.",
      );
    }
    lines.push(
      "- Create the test/spec files those suites need as you implement (co-locate or follow project conventions).",
      "- UI component tests: prefer stable `data-testid` (or role+name that cannot collide). Avoid multiple controls sharing the same accessible name (e.g. family/variant/favorite all named like the opening).",
      "- Do NOT execute these verification commands via run_command or terminal_* during Build (no `npm test`, `pnpm lint`, `vitest`, etc. unless the user explicitly asks).",
      "- Shell is for installs, codegen, app/dev servers, and git — not for pre-empting the IDE Test gate.",
      "- When the gate fails later (Testing phase): call get_test_report and list_failed_tests; use read_test_log for raw chunks. The IDE re-runs the suites — do not re-launch the full suite yourself.",
      "- If the IDE marks the failure as ESCALATED, change strategy (rewrite brittle tests / coherent test+impl edit). You may run ONLY the single failing suite command from the digest once for diagnosis.",
    );
  }
  return lines.join("\n");
}

/**
 * Extra system rules while a test-gate escalation is active (fix turns).
 */
export function formatTestGateEscalationSystemRules(level: number): string {
  if (level <= 0) return "";
  const lines = [
    "Test gate ESCALATION (harness — follow strictly this turn):",
    "- You already failed this gate with a similar fingerprint. Stop micro-patching the same aria-label / import / one-liner.",
    "- Call get_test_report and list_failed_tests first to see platform + which tests fail, then fix.",
    "- Read the failing test file and the implementation together. Align them in one coherent edit.",
    "- Prefer rewriting brittle Testing Library queries to `data-testid` (or unique accessible names) over thrashing labels.",
    "- Do not oscillate (e.g. selectOpenings ↔ openings). Pick the real export, update tests to match, keep them consistent.",
  ];
  if (level >= 2) {
    lines.push(
      "- STRONG escalation: assume the test is wrong or too brittle. Rewrite the test for stable selectors, then fix the component to match. Ship both.",
    );
  }
  lines.push(
    "- Diagnosis exception: you MAY run_command the SINGLE failing suite command shown in the digest once this turn. Do not run the full gate or unrelated suites.",
  );
  return lines.join("\n");
}

export function testLogChunkCount(
  logChars: number,
  chunkSize = TEST_LOG_CHUNK_CHARS,
): number {
  if (logChars <= 0) return 0;
  return Math.ceil(logChars / chunkSize);
}

/** Normalize noisy log text for fingerprinting. */
export function normalizeFailureSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+ms\b/g, "Nms")
    .replace(/\b\d{2,}\b/g, "N")
    .replace(/0x[0-9a-f]+/gi, "0xN")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * Pull Testing Library / Jest / tsc failure blocks from a raw suite log.
 */
export function extractRichLogExcerpt(
  log: string,
  options?: { maxChars?: number },
): string {
  const maxChars = options?.maxChars ?? TEST_DIGEST_LOG_EXCERPT_CHARS;
  const text = log.replace(/\r\n/g, "\n");
  if (!text.trim()) return "";

  const blocks: string[] = [];

  // Testing Library: Unable to find / Found multiple elements …
  const tlRe =
    /(?:TestingLibraryElementError|Unable to find|Found multiple elements)[\s\S]{0,2500}?(?=\n\s*(?:●|FAIL |PASS |Test Suites:|Tests:|$))/gi;
  for (const m of text.matchAll(tlRe)) {
    if (m[0]) blocks.push(m[0].trim());
  }

  // Also capture "Available" name/role dumps often right after TL errors.
  const availRe =
    /(?:Here are the (?:accessible|available)[^\n]*:\n)(?:.*\n){0,80}/gi;
  for (const m of text.matchAll(availRe)) {
    if (m[0] && !blocks.some((b) => b.includes(m[0]!.slice(0, 80)))) {
      blocks.push(m[0].trim());
    }
  }

  // TypeScript errors
  const tsRe = /(?:error TS\d+:[^\n]*(?:\n\s+[^\n]+){0,6})/g;
  for (const m of text.matchAll(tsRe)) {
    if (m[0]) blocks.push(m[0].trim());
  }

  // Jest FAIL / ● blocks
  const jestRe =
    /(?:FAIL\s+\S+[^\n]*\n|●\s+[^\n]+\n)(?:.*\n){0,40}?(?=●|FAIL |PASS |Test Suites:|$)/g;
  for (const m of text.matchAll(jestRe)) {
    if (m[0]) blocks.push(m[0].trim());
  }

  let joined =
    blocks.length > 0
      ? uniquePreserveOrder(blocks).join("\n\n---\n\n")
      : "";

  if (!joined) {
    // Fallback: last interesting lines
    const lines = text.split("\n");
    const interesting = lines.filter((line) =>
      /fail|error|✖|×|ERR!|AssertionError|Type error|ELIFECYCLE|Unable to find|Found multiple|TestingLibrary/i.test(
        line,
      ),
    );
    joined =
      interesting.length > 0
        ? interesting.slice(-60).join("\n")
        : lines.slice(-40).join("\n");
  }

  if (joined.length > maxChars) {
    return `${joined.slice(0, maxChars)}\n…[excerpt truncated]`;
  }
  return joined.trim();
}

function uniquePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function failedSuiteIds(
  suites: TestSuiteResult[],
): string[] {
  return suites
    .filter((s) => s.status === "failed" || s.status === "timed_out")
    .map((s) => s.id)
    .sort();
}

/**
 * Stable-ish fingerprint for "same failure again" detection.
 */
export function fingerprintTestFailure(
  report: Pick<TestRunReport, "suites">,
  logs?: Record<string, string>,
): string {
  const failed = report.suites.filter(
    (s) => s.status === "failed" || s.status === "timed_out",
  );
  const suiteKey = failed.map((s) => s.id).sort().join("+") || "none";
  const parts: string[] = [suiteKey];
  for (const suite of failed) {
    const log = logs?.[suite.id] ?? suite.summary;
    const excerpt = extractRichLogExcerpt(log, { maxChars: 800 });
    // Prefer first strong signal line
    const signal =
      excerpt.match(
        /Unable to find[^\n]+|Found multiple elements[^\n]+|error TS\d+:[^\n]+|Expected[^\n]+|TypeError:[^\n]+|ReferenceError:[^\n]+/i,
      )?.[0] ?? excerpt.slice(0, 160);
    parts.push(normalizeFailureSignature(`${suite.id}:${signal}`));
  }
  return parts.join("|").slice(0, 400);
}

export type TestGateEscalationDecision = {
  fingerprint: string;
  sameFailureStreak: number;
  /** 0 = none, 1 = escalate, 2 = strong */
  level: number;
  /** Failed suite id sets flip-flopping across recent runs. */
  oscillating: boolean;
  recentSuiteKeys: string[];
};

/**
 * Update streak / oscillation from a new failure vs prior gate state.
 */
export function decideTestGateEscalation(input: {
  fingerprint: string;
  previousFingerprint: string | null | undefined;
  previousStreak: number;
  /** Prior failed-suite keys like "unit", "typecheck", "lint+unit". */
  previousSuiteKeys?: string[];
  currentSuiteKey: string;
  escalateAfter?: number;
  strongAfter?: number;
}): TestGateEscalationDecision {
  const escalateAfter = input.escalateAfter ?? TEST_GATE_ESCALATION_AFTER;
  const strongAfter = input.strongAfter ?? TEST_GATE_STRONG_ESCALATION_AFTER;
  const same =
    Boolean(input.previousFingerprint) &&
    input.previousFingerprint === input.fingerprint;
  const sameFailureStreak = same
    ? Math.max(1, input.previousStreak) + 1
    : 1;

  const recentSuiteKeys = [
    ...(input.previousSuiteKeys ?? []),
    input.currentSuiteKey,
  ].slice(-4);

  const oscillating = detectSuiteOscillation(recentSuiteKeys);

  let level = 0;
  if (sameFailureStreak >= strongAfter || oscillating) level = 2;
  else if (sameFailureStreak >= escalateAfter) level = 1;

  return {
    fingerprint: input.fingerprint,
    sameFailureStreak,
    level,
    oscillating,
    recentSuiteKeys,
  };
}

/** A→B→A (or A→B→A→B) on failed suite keys. */
export function detectSuiteOscillation(suiteKeys: string[]): boolean {
  if (suiteKeys.length < 3) return false;
  const a = suiteKeys[suiteKeys.length - 3]!;
  const b = suiteKeys[suiteKeys.length - 2]!;
  const c = suiteKeys[suiteKeys.length - 1]!;
  if (a === c && a !== b) return true;
  if (suiteKeys.length >= 4) {
    const d = suiteKeys[suiteKeys.length - 4]!;
    // B→A→B→A
    if (d === b && a === c && a !== b) return true;
  }
  return false;
}

export function formatTestGateEscalationBanner(
  decision: Pick<
    TestGateEscalationDecision,
    "level" | "sameFailureStreak" | "oscillating"
  >,
): string {
  if (decision.level <= 0) return "";
  const lines = [
    decision.level >= 2
      ? "[IDE · TEST GATE · ESCALATED — STRONG]"
      : "[IDE · TEST GATE · ESCALATED]",
    `Same-failure streak: ${decision.sameFailureStreak}.${
      decision.oscillating
        ? " Suite oscillation detected (e.g. typecheck ↔ unit)."
        : ""
    }`,
    "Change strategy: stop one-line thrash. Rewrite brittle tests (prefer data-testid), fix implementation to match, keep imports consistent.",
    "You MAY run_command the single failing suite command below once for diagnosis this turn.",
    "",
  ];
  return lines.join("\n");
}

export function buildTestFailureDigest(
  report: Pick<TestRunReport, "suites" | "specs">,
  options?: {
    maxChars?: number;
    logs?: Record<string, string>;
    escalation?: Pick<
      TestGateEscalationDecision,
      "level" | "sameFailureStreak" | "oscillating"
    > | null;
  },
): string {
  const maxChars = options?.maxChars ?? TEST_DIGEST_MAX_CHARS;
  const failed = report.suites.filter(
    (s) => s.status === "failed" || s.status === "timed_out",
  );
  const cancelled = report.suites.filter((s) => s.status === "cancelled");
  const lines: string[] = [];

  if (options?.escalation && options.escalation.level > 0) {
    lines.push(formatTestGateEscalationBanner(options.escalation).trimEnd());
    lines.push("");
  }

  lines.push(
    "[IDE · TEST GATE] One or more verification suites failed.",
    "Fix the failures (keep checklist done sticky). Use read_test_log for more output.",
    "",
  );

  for (const suite of failed) {
    const plat = suite.platform ? ` · ${suite.platform}` : "";
    lines.push(`## ${suite.id} (${suite.kind}${plat}) — ${suite.status}`);
    lines.push(`command: ${suite.command}`);
    lines.push(`exitCode: ${suite.exitCode ?? "null"} · ${suite.durationMs}ms`);
    if (suite.counts) {
      lines.push(
        `tests: ${suite.counts.passed} passed · ${suite.counts.failed} failed · ${suite.counts.skipped} skipped · ${suite.counts.total} total`,
      );
    }
    if (suite.failedTests?.length) {
      lines.push(
        `failed tests: ${suite.failedTests.slice(0, 12).join(" · ")}${
          suite.failedTests.length > 12 ? " …" : ""
        }`,
      );
    }
    lines.push(
      `log: ${suite.logChars} chars · ${suite.logChunks} chunks of ${suite.logChunkSize}`,
    );
    lines.push(suite.summary);

    const fullLog = options?.logs?.[suite.id];
    if (fullLog) {
      const excerpt = extractRichLogExcerpt(fullLog);
      if (excerpt && excerpt.trim() !== suite.summary.trim()) {
        lines.push("");
        lines.push("### Failure excerpt");
        lines.push(excerpt);
      }
    }
    lines.push("");
  }
  if (cancelled.length) {
    lines.push(
      `Cancelled after fail-fast: ${cancelled.map((s) => s.id).join(", ")}`,
    );
    lines.push("");
  }
  const passed = report.suites.filter((s) => s.status === "passed");
  if (passed.length) {
    lines.push(`Already passed: ${passed.map((s) => s.id).join(", ")}`);
  }
  let text = lines.join("\n").trim();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[digest truncated]`;
  }
  return text;
}

export const TEST_FAILURE_CONTINUE_USER_MESSAGE =
  "Continue: test gate failed. Fix the reported failures, then the IDE will re-run lint/typecheck/unit. Prefer read_test_log if you need more log. Do not only narrate.";

export type TestGateCircuitDecision = {
  /** Attempts after counting this failure. */
  attempts: number;
  /** Stop auto-injecting the digest into the agent. */
  circuitOpen: boolean;
  /** Whether the IDE should send the failure digest as a user turn. */
  autoContinue: boolean;
};

/**
 * Decide whether to auto-continue after a failed gate.
 * Unpaid providers always auto-continue; paid providers open the circuit
 * after {@link TEST_GATE_PAID_AUTO_FIX_LIMIT} auto-fix attempts.
 */
export function decideTestGateAutoContinue(input: {
  paidProvider: boolean;
  previousAttempts: number;
  limit?: number;
}): TestGateCircuitDecision {
  const limit = input.limit ?? TEST_GATE_PAID_AUTO_FIX_LIMIT;
  const attempts = Math.max(0, input.previousAttempts) + 1;
  if (!input.paidProvider) {
    return { attempts, circuitOpen: false, autoContinue: true };
  }
  const circuitOpen = attempts > limit;
  return {
    attempts,
    circuitOpen,
    autoContinue: !circuitOpen,
  };
}

export function isTestGateSyntheticPrompt(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (text === TEST_FAILURE_CONTINUE_USER_MESSAGE) return true;
  if (text.startsWith("[IDE · TEST GATE]")) return true;
  return false;
}

export function summarizeSuiteLog(
  kind: TestSuiteKind,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean,
): string {
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  const excerpt = extractRichLogExcerpt(combined, { maxChars: 2_500 });
  const head = timedOut
    ? `Timed out (${kind}).`
    : `Exit ${exitCode ?? "null"} (${kind}).`;
  const body = excerpt.trim() || "(no output)";
  const text = `${head}\n${body}`;
  return text.length > 2_800 ? `${text.slice(0, 2_800)}\n…` : text;
}

function parseCountCluster(segment: string): {
  failed: number;
  passed: number;
  skipped: number;
  total: number;
} | null {
  const failed = Number(segment.match(/(\d+)\s+failed/i)?.[1] ?? NaN);
  const passed = Number(segment.match(/(\d+)\s+passed/i)?.[1] ?? NaN);
  const skipped = Number(
    segment.match(/(\d+)\s+(?:skipped|todo|pending)/i)?.[1] ?? 0,
  );
  const totalMatch = segment.match(/(\d+)\s+total/i);
  let total = totalMatch ? Number(totalMatch[1]) : NaN;
  if (Number.isNaN(failed) && Number.isNaN(passed)) return null;
  const f = Number.isNaN(failed) ? 0 : failed;
  const p = Number.isNaN(passed) ? 0 : passed;
  const s = Number.isNaN(skipped) ? 0 : skipped;
  if (Number.isNaN(total)) total = f + p + s;
  return { failed: f, passed: p, skipped: s, total };
}

/**
 * Parse Jest / Vitest / Cypress-ish summaries and failed test titles from a log.
 */
export function parseTestSuiteInsights(
  log: string,
  options?: { platform?: string; kind?: TestSuiteKind; maxFailed?: number },
): { counts?: TestSuiteCounts; failedTests: string[]; platform?: string } {
  const maxFailed = options?.maxFailed ?? MAX_FAILED_TEST_NAMES;
  const text = log.replace(/\r\n/g, "\n");
  let counts: TestSuiteCounts | undefined;
  let platform = options?.platform;

  // Jest: Tests: 1 failed, 12 passed, 13 total
  const jestTests = text.match(
    /Tests:\s*([^\n]+)/i,
  );
  if (jestTests?.[1]) {
    const c = parseCountCluster(jestTests[1]);
    if (c) {
      counts = { ...c };
      platform = platform ?? "jest";
    }
  }
  const jestSuites = text.match(/Test Suites:\s*([^\n]+)/i);
  if (jestSuites?.[1] && counts) {
    const c = parseCountCluster(jestSuites[1]);
    if (c) {
      counts = {
        ...counts,
        suiteFilesFailed: c.failed,
        suiteFilesPassed: c.passed,
        suiteFilesTotal: c.total,
      };
    }
  }

  // Vitest: Tests  2 failed | 10 passed (12)
  if (!counts) {
    const vitest = text.match(
      /Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?(?:\s*\((\d+)\))?/i,
    );
    if (vitest) {
      const failed = Number(vitest[1]);
      const passed = Number(vitest[2]);
      const skipped = Number(vitest[3] ?? 0);
      const total = Number(vitest[4] ?? failed + passed + skipped);
      counts = { failed, passed, skipped, total };
      platform = platform ?? "vitest";
    }
  }

  // Cypress: ✖  2 of 10 failed
  if (!counts) {
    const cy = text.match(/(?:✖|×)\s+(\d+)\s+of\s+(\d+)\s+failed/i);
    if (cy) {
      const failed = Number(cy[1]);
      const total = Number(cy[2]);
      counts = {
        failed,
        passed: Math.max(0, total - failed),
        skipped: 0,
        total,
      };
      platform = platform ?? "cypress";
    }
  }

  // TypeScript: count error TS lines as failed "tests"
  if (!counts && (options?.kind === "typecheck" || /error TS\d+/i.test(text))) {
    const tsErrors = text.match(/error TS\d+/g);
    if (tsErrors?.length) {
      counts = {
        failed: tsErrors.length,
        passed: 0,
        skipped: 0,
        total: tsErrors.length,
      };
      platform = platform ?? "tsc";
    }
  }

  const failedTests: string[] = [];
  const seen = new Set<string>();
  const pushName = (raw: string) => {
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name || name.length < 2 || seen.has(name)) return;
    seen.add(name);
    failedTests.push(name.slice(0, 200));
  };

  // Jest / Vitest: ● suite > test  OR  FAIL  path > test
  for (const m of text.matchAll(/^\s*●\s+(.+?)\s*$/gm)) {
    if (failedTests.length >= maxFailed) break;
    const line = m[1] ?? "";
    if (/^(Test suite failed|Failed Suites)/i.test(line)) continue;
    pushName(line);
  }
  for (const m of text.matchAll(
    /^\s*FAIL\s+\S+\s*(?:>\s*)?(.+?)?\s*$/gm,
  )) {
    if (failedTests.length >= maxFailed) break;
    if (m[1]?.trim()) pushName(m[1]);
  }
  // Playwright-ish
  for (const m of text.matchAll(/^\s*\d+\)\s+\[.+?\]\s*›\s*(.+)$/gm)) {
    if (failedTests.length >= maxFailed) break;
    pushName(m[1] ?? "");
  }

  return {
    ...(counts ? { counts } : {}),
    failedTests,
    ...(platform ? { platform } : {}),
  };
}

/** Compact structured view of the last IDE test gate for the agent. */
export function formatAgentTestReport(
  report: TestRunReport | null | undefined,
  options?: {
    escalationLevel?: number;
    circuitOpen?: boolean;
    sameFailureStreak?: number;
  },
): Record<string, unknown> {
  if (!report) {
    return {
      available: false,
      message: "No IDE test-gate run yet for this session.",
    };
  }
  const suites = report.suites.map((s) => ({
    id: s.id,
    kind: s.kind,
    platform: s.platform ?? null,
    status: s.status,
    command: s.command,
    exitCode: s.exitCode,
    durationMs: s.durationMs,
    counts: s.counts ?? null,
    failedTests: s.failedTests ?? [],
    failedTestCount: s.failedTests?.length ?? 0,
    logChunks: s.logChunks,
  }));
  const totals = suites.reduce(
    (acc, s) => {
      if (s.counts) {
        acc.passed += s.counts.passed;
        acc.failed += s.counts.failed;
        acc.skipped += s.counts.skipped;
        acc.total += s.counts.total;
        acc.parsedSuites += 1;
      }
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0, total: 0, parsedSuites: 0 },
  );
  return {
    available: true,
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt ?? null,
    suiteCount: suites.length,
    suites,
    totals: totals.parsedSuites > 0 ? totals : null,
    escalationLevel: options?.escalationLevel ?? 0,
    circuitOpen: Boolean(options?.circuitOpen),
    sameFailureStreak: options?.sameFailureStreak ?? 0,
    hint: "Use list_failed_tests for titles; read_test_log for raw chunks. Prefer get_test_report over re-running suites.",
  };
}

export function suiteResultFromRun(input: {
  spec: TestRunSpec;
  status: TestSuiteResult["status"];
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  chunkSize?: number;
}): { result: TestSuiteResult; log: string } {
  const chunkSize = input.chunkSize ?? TEST_LOG_CHUNK_CHARS;
  const log = [input.stdout, input.stderr].filter(Boolean).join("\n");
  const logChars = log.length;
  const insights = parseTestSuiteInsights(log, {
    ...(input.spec.platform ? { platform: input.spec.platform } : {}),
    kind: input.spec.kind,
  });
  const platform = insights.platform ?? input.spec.platform;
  const countHint =
    insights.counts && input.status !== "cancelled"
      ? ` · ${insights.counts.passed}✓ ${insights.counts.failed}✗ / ${insights.counts.total}`
      : "";
  const result: TestSuiteResult = {
    id: input.spec.id,
    kind: input.spec.kind,
    command: input.spec.command,
    status: input.status,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    summary:
      input.status === "passed"
        ? `Passed (${input.durationMs}ms)${countHint}`
        : input.status === "cancelled"
          ? "Cancelled (fail-fast)"
          : summarizeSuiteLog(
              input.spec.kind,
              input.stdout,
              input.stderr,
              input.exitCode,
              Boolean(input.timedOut),
            ),
    logChars,
    logChunkSize: chunkSize,
    logChunks: testLogChunkCount(logChars, chunkSize),
    ...(platform ? { platform } : {}),
    ...(insights.counts ? { counts: insights.counts } : {}),
    failedTests: insights.failedTests,
  };
  return { result, log };
}
