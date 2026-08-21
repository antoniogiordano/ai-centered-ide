import { useEffect } from "react";
import {
  humanSetupItemSatisfied,
  humanSetupProgress,
  type HumanSetupItem,
  type SessionState,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";

/**
 * The human half of the gate: what the agent cannot do for you.
 *
 * Opened by request_human_setup when a suite fails on something no code change
 * can fix — a connection string, an OAuth client, a database branch. While it is
 * up the IDE stops retrying the gate, so nothing burns turns against a missing
 * credential.
 *
 * Env items are verified by the IDE (key names only, values never leave the
 * file): edit the file in your editor, hit Recheck, and they tick themselves.
 * Everything else is a manual tick, because only you can know it happened.
 */
export function HumanSetupBanner(props: { state: SessionState | null }) {
  const state = props.state;
  const request = state?.humanSetup ?? null;
  const dialogOpen = Boolean(
    state?.pendingAgentAsk ??
      state?.pendingTerminalAsk ??
      state?.pendingTerminalConfirm,
  );
  // A commit/integrate offer means the gate already passed: the checklist is
  // stale, and its digit shortcuts would fight the integrate banner's.
  const show =
    Boolean(request) &&
    !dialogOpen &&
    !state?.buildCommitOffer &&
    !state?.buildIntegrateOffer;
  const items = request?.items ?? [];
  const { done, total } = humanSetupProgress(request);
  const manualItems = items.filter((item) => item.envKeys.length === 0);

  function send(input: {
    action: "recheck" | "toggle" | "resume" | "skip";
    itemId?: string;
    done?: boolean;
  }) {
    void getBridge()?.session.humanSetup?.(input);
  }

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Enter") {
        e.preventDefault();
        send({ action: "resume" });
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        send({ action: "skip" });
        return;
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        send({ action: "recheck" });
        return;
      }
      const digit = Number.parseInt(e.key, 10);
      if (Number.isFinite(digit) && digit >= 1 && digit <= manualItems.length) {
        const item = manualItems[digit - 1];
        if (!item) return;
        e.preventDefault();
        send({ action: "toggle", itemId: item.id, done: !item.done });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, manualItems.map((item) => `${item.id}:${item.done}`).join("|")]);

  if (!show || !request) return null;

  return (
    <div className="human-setup-banner" role="status">
      <div className="human-setup-head">
        <strong>Your turn · {done}/{total} done</strong>
        <span>{request.reason}</span>
      </div>
      <ul className="human-setup-list">
        {items.map((item) => (
          <HumanSetupRow
            key={item.id}
            item={item}
            digit={
              item.envKeys.length === 0
                ? manualItems.findIndex((m) => m.id === item.id) + 1
                : null
            }
            onToggle={() =>
              send({ action: "toggle", itemId: item.id, done: !item.done })
            }
          />
        ))}
      </ul>
      <div className="human-setup-actions">
        <span className="human-setup-hint">
          Env keys are checked in the file, never read — paste the values in your
          editor, then Recheck.
        </span>
        <div className="human-setup-buttons">
          <button
            type="button"
            className="btn btn-outlined"
            onClick={() => send({ action: "skip" })}
          >
            Skip · Esc
          </button>
          <button
            type="button"
            className="btn btn-outlined"
            onClick={() => send({ action: "recheck" })}
          >
            Recheck · R
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => send({ action: "resume" })}
          >
            Resume · Enter
          </button>
        </div>
      </div>
    </div>
  );
}

function HumanSetupRow(props: {
  item: HumanSetupItem;
  /** Manual items get a digit shortcut; env items are verified, not ticked. */
  digit: number | null;
  onToggle: () => void;
}) {
  const { item, digit } = props;
  const satisfied = humanSetupItemSatisfied(item);
  return (
    <li className={satisfied ? "human-setup-row is-done" : "human-setup-row"}>
      <span className="human-setup-mark">{satisfied ? "✓" : "○"}</span>
      <div className="human-setup-body">
        <strong>{item.title}</strong>
        {item.detail ? <span>{item.detail}</span> : null}
        {item.envKeys.length ? (
          <div className="human-setup-keys">
            {item.envFile ? <code>{item.envFile}</code> : null}
            {item.envKeys.map((key) => (
              <span
                key={key}
                className={
                  item.envKeysPresent.includes(key)
                    ? "human-setup-key is-set"
                    : "human-setup-key"
                }
              >
                {key}
              </span>
            ))}
          </div>
        ) : null}
        {item.docUrl ? (
          <a href={item.docUrl} target="_blank" rel="noreferrer">
            {item.docUrl}
          </a>
        ) : null}
      </div>
      {digit ? (
        <button
          type="button"
          className="btn btn-sm btn-outlined"
          onClick={props.onToggle}
        >
          {item.done ? `Undo · ${digit}` : `Mark done · ${digit}`}
        </button>
      ) : null}
    </li>
  );
}
