import { useEffect, useRef, useState } from "react";
import {
  formatDurationMs,
  formatTokenCount,
  formatUsd,
  phaseDurationTotals,
  sessionLogTotals,
  type SessionLog,
} from "@ai-ide/shared";
import { useNativeOverlay } from "../hooks/useNativeOverlay";
import { getBridge } from "../bridge";

function outcomeLabel(outcome: SessionLog["outcome"]): string {
  switch (outcome) {
    case "commit":
      return "Commit";
    case "pr":
      return "Pull request";
    case "merged":
      return "Merged";
    case "archived":
      return "Archived";
    case "discarded":
      return "Discarded";
    case "error":
      return "Error";
    default:
      return "Open";
  }
}

/**
 * Local SQLite analytics: models, tokens, estimated $ at the rates that
 * were configured when the tokens landed, plus P/C/B/T wall time.
 */
export function SessionStatsDialog(props: {
  open: boolean;
  onClose: () => void;
}) {
  const { open, onClose } = props;
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useNativeOverlay(open);

  useEffect(() => {
    if (!open) return;
    void getBridge()
      ?.session.listLogs()
      .then((res) => setLogs(res?.logs ?? []))
      .catch(() => setLogs([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="provider-dialog sessions-dialog session-stats-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-stats-title"
        tabIndex={-1}
      >
        <div className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Local analytics</div>
            <h2 className="provider-dialog-title" id="session-stats-title">
              Session stats
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClose}
          >
            Close · Esc
          </button>
        </div>
        <div className="provider-dialog-body">
          <p className="provider-dialog-lead">
            Stored in the local IDE database. Costs use the model rates from
            the moment tokens were recorded.
          </p>
          <ul className="session-stats-list">
            {logs.map((log) => {
              const totals = sessionLogTotals(log);
              const phases = phaseDurationTotals(log);
              return (
                <li key={log.sessionId} className="session-stats-row">
                  <div className="session-stats-head">
                    <strong>{log.title}</strong>
                    <span className="session-stats-outcome">
                      {outcomeLabel(log.outcome)}
                    </span>
                  </div>
                  <div className="session-stats-meta">
                    {new Date(log.startedAt).toLocaleString()}
                    {log.featBranch ? ` · ${log.featBranch}` : ""}
                    {log.workspaceName ? ` · ${log.workspaceName}` : ""}
                  </div>
                  <div className="session-stats-usage">
                    in {formatTokenCount(totals.inputTokens)} · out{" "}
                    {formatTokenCount(totals.outputTokens)}
                    {totals.costUsd != null ? ` · ${formatUsd(totals.costUsd)}` : ""}
                  </div>
                  <div className="session-stats-phases">
                    P {formatDurationMs(phases.planning)} · C{" "}
                    {formatDurationMs(phases.checking)} · B{" "}
                    {formatDurationMs(phases.building)} · T{" "}
                    {formatDurationMs(phases.testing)}
                  </div>
                  {log.models.length > 0 ? (
                    <ul className="session-stats-models">
                      {log.models.map((row) => (
                        <li key={`${row.providerId ?? "x"}:${row.model}`}>
                          {row.providerName} · {row.model}: in{" "}
                          {formatTokenCount(row.inputTokens)} · out{" "}
                          {formatTokenCount(row.outputTokens)}
                          {row.costUsd != null ? ` · ${formatUsd(row.costUsd)}` : ""}
                          {row.pricing?.inputPer1M != null
                            ? ` @ $${row.pricing.inputPer1M}/$${row.pricing.outputPer1M ?? "—"} /1M`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {log.errors.length > 0 ? (
                    <p className="session-stats-errors">
                      {log.errors.length} error
                      {log.errors.length === 1 ? "" : "s"} · last:{" "}
                      {log.errors[log.errors.length - 1]?.message}
                    </p>
                  ) : null}
                  {log.outcomeDetail ? (
                    <p className="session-stats-detail">{log.outcomeDetail}</p>
                  ) : null}
                </li>
              );
            })}
            {logs.length === 0 ? (
              <li className="muted">No session logs yet.</li>
            ) : null}
          </ul>
        </div>
      </div>
    </div>
  );
}
