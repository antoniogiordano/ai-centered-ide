import type { SessionState, TestRunSpec, TestSuiteResult } from "@ai-ide/shared";
import { deriveProductPhase } from "@ai-ide/shared";

type PlatformRow = {
  key: string;
  platform: string;
  kind: string;
  command: string;
  result: TestSuiteResult | null;
  running: boolean;
};

function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function platformLabel(spec: TestRunSpec, result: TestSuiteResult | null): string {
  const raw = result?.platform ?? spec.platform ?? spec.kind;
  return titleCase(raw);
}

function buildRows(state: SessionState | null): PlatformRow[] {
  const run = state?.testRun;
  if (!run) return [];

  const byId = new Map(run.suites.map((s) => [s.id, s]));
  const gateRunning = run.status === "running";

  // Prefer specs (planned gate); fall back to completed suites only.
  const specs =
    run.specs.length > 0
      ? run.specs
      : run.suites.map(
          (s): TestRunSpec => ({
            id: s.id,
            kind: s.kind,
            command: s.command,
            ...(s.platform ? { platform: s.platform } : {}),
          }),
        );

  return specs.map((spec) => {
    const result = byId.get(spec.id) ?? null;
    const running = gateRunning && !result;
    return {
      key: spec.id,
      platform: platformLabel(spec, result),
      kind: spec.kind,
      command: spec.command,
      result,
      running,
    };
  });
}

function CountChip(props: {
  label: string;
  value: number;
  tone: "pass" | "fail" | "muted" | "total";
}) {
  return (
    <span className={`testing-count testing-count-${props.tone}`}>
      <span className="testing-count-value">{props.value}</span>
      <span className="testing-count-label">{props.label}</span>
    </span>
  );
}

function SuiteCounts(props: { result: TestSuiteResult }) {
  const { result } = props;
  const counts = result.counts;
  const suitePassed = counts?.suiteFilesPassed;
  const suiteFailed = counts?.suiteFilesFailed;
  const suiteTotal = counts?.suiteFilesTotal;
  const hasSuiteFiles =
    suitePassed !== undefined ||
    suiteFailed !== undefined ||
    suiteTotal !== undefined;

  if (!counts && result.status === "passed") {
    return (
      <div className="testing-counts-row">
        <CountChip label="passed" value={1} tone="pass" />
        <CountChip label="failed" value={0} tone="fail" />
        <CountChip label="total" value={1} tone="total" />
      </div>
    );
  }

  if (!counts && (result.status === "failed" || result.status === "timed_out")) {
    return (
      <div className="testing-counts-row">
        <CountChip label="passed" value={0} tone="pass" />
        <CountChip label="failed" value={1} tone="fail" />
        <CountChip label="total" value={1} tone="total" />
      </div>
    );
  }

  if (!counts) {
    return (
      <div className="testing-counts-row">
        <CountChip label="—" value={0} tone="muted" />
      </div>
    );
  }

  return (
    <div className="testing-platform-metrics">
      <div className="testing-metric-block">
        <div className="testing-metric-title">Tests</div>
        <div className="testing-counts-row">
          <CountChip label="passed" value={counts.passed} tone="pass" />
          <CountChip label="failed" value={counts.failed} tone="fail" />
          <CountChip label="total" value={counts.total} tone="total" />
          {counts.skipped > 0 ? (
            <CountChip label="skipped" value={counts.skipped} tone="muted" />
          ) : null}
        </div>
      </div>
      {hasSuiteFiles ? (
        <div className="testing-metric-block">
          <div className="testing-metric-title">Suites</div>
          <div className="testing-counts-row">
            <CountChip
              label="passed"
              value={suitePassed ?? 0}
              tone="pass"
            />
            <CountChip
              label="failed"
              value={suiteFailed ?? 0}
              tone="fail"
            />
            <CountChip
              label="total"
              value={suiteTotal ?? (suitePassed ?? 0) + (suiteFailed ?? 0)}
              tone="total"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function statusLabel(result: TestSuiteResult | null, running: boolean): string {
  if (running) return "Running";
  if (!result) return "Pending";
  if (result.status === "passed") return "Passed";
  if (result.status === "failed") return "Failed";
  if (result.status === "timed_out") return "Timed out";
  if (result.status === "cancelled") return "Cancelled";
  if (result.status === "skipped") return "Skipped";
  return result.status;
}

export function TestingReportBoard(props: { state: SessionState | null }) {
  const run = props.state?.testRun ?? null;
  const rows = buildRows(props.state);
  const overall = run?.status ?? null;
  const isCheck =
    props.state != null && deriveProductPhase(props.state) === "checking";
  const reportTitle = isCheck ? "Check report" : "Testing report";
  const waitingHint = isCheck
    ? "Pre-build Check: the IDE runs lint / typecheck / unit / e2e on the feature branch before Build starts."
    : "Waiting for the agent to call propose_testing_ready, then the IDE Test gate will run lint / typecheck / unit / e2e here.";

  if (!run || rows.length === 0) {
    return (
      <div className="testing-report">
        <div className="testing-report-header">
          <div>
            <strong>{reportTitle}</strong>
            <p className="verify-hint">{waitingHint}</p>
          </div>
        </div>
        <div className="empty-state verify-empty testing-report-empty">
          <strong>No suites yet</strong>
          <p>Results appear per platform as each verification command finishes.</p>
        </div>
      </div>
    );
  }

  const passedSuites = rows.filter((r) => r.result?.status === "passed").length;
  const failedSuites = rows.filter(
    (r) =>
      r.result?.status === "failed" || r.result?.status === "timed_out",
  ).length;
  const runningCount = rows.filter((r) => r.running).length;

  return (
    <div className="testing-report" role="region" aria-label={reportTitle}>
      <div className="testing-report-header">
        <div>
          <strong>{reportTitle}</strong>
          <p className="verify-hint">
            {overall === "running"
              ? `Gate running · ${runningCount} in flight · ${passedSuites} passed · ${failedSuites} failed`
              : overall === "passed"
                ? `Gate passed · ${passedSuites} suite${passedSuites === 1 ? "" : "s"}`
                : overall === "failed"
                  ? `Gate failed · ${failedSuites} failed · ${passedSuites} passed`
                  : overall === "skipped"
                    ? "Gate skipped — no suites configured"
                    : `${rows.length} suite${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {overall ? (
          <span className={`testing-overall testing-overall-${overall}`}>
            {overall === "running" ? (
              <>
                <span className="thinking-spinner testing-spinner" aria-hidden />
                Running
              </>
            ) : (
              titleCase(overall)
            )}
          </span>
        ) : null}
      </div>

      <ul className="testing-platform-list">
        {rows.map((row) => {
          const tone = row.running
            ? "running"
            : row.result?.status === "passed"
              ? "passed"
              : row.result?.status === "failed" ||
                  row.result?.status === "timed_out"
                ? "failed"
                : "pending";
          return (
            <li
              key={row.key}
              className={`testing-platform testing-platform-${tone}`}
            >
              <div className="testing-platform-header">
                <div className="testing-platform-titles">
                  <span className="testing-platform-name">{row.platform}</span>
                  <span className="testing-platform-kind">{row.kind}</span>
                </div>
                <span className={`testing-platform-status testing-status-${tone}`}>
                  {row.running ? (
                    <>
                      <span
                        className="thinking-spinner testing-spinner"
                        aria-hidden
                      />
                      Running
                    </>
                  ) : (
                    statusLabel(row.result, false)
                  )}
                </span>
              </div>
              <code className="testing-platform-command" title={row.command}>
                {row.command}
              </code>
              {row.running ? (
                <div className="testing-running-hint">
                  <span className="thinking-spinner testing-spinner" aria-hidden />
                  <span>Suite in progress…</span>
                </div>
              ) : row.result ? (
                <>
                  <SuiteCounts result={row.result} />
                  {row.result.failedTests.length > 0 ? (
                    <ul className="testing-failed-list">
                      {row.result.failedTests.slice(0, 8).map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                      {row.result.failedTests.length > 8 ? (
                        <li className="muted">
                          +{row.result.failedTests.length - 8} more
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="testing-platform-pending muted">
                  Waiting to start…
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
