import { useEffect, useState } from "react";
import {
  pruneExpiredNotices,
  type SessionNotice,
  type SessionState,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { modShiftHint } from "./ArchitecturePane";

/**
 * Chrome banners the human cannot miss: harness intercepts (images dropped)
 * and agent `post_notice`. A transcript line is too easy to scroll past.
 * Blocking notices pause auto-continue until Dismiss.
 */
export function SessionNoticeBanner(props: {
  state: SessionState | null;
  onToggleModel?: (() => void) | undefined;
}) {
  const state = props.state;
  const [, setTick] = useState(0);
  const dialogOpen = Boolean(
    state?.pendingAgentAsk ??
      state?.pendingTerminalAsk ??
      state?.pendingTerminalConfirm,
  );
  const humanSetup = Boolean(state?.humanSetup);
  const notices = pruneExpiredNotices(state?.notices ?? []);
  const notice = notices[0] ?? null;
  const remaining = Math.max(0, notices.length - 1);
  const show = Boolean(notice);
  const escFree = !dialogOpen && !humanSetup;
  const dismissHint = escFree ? "Esc" : "D";

  function dismiss(noticeId: string) {
    void getBridge()?.session.dismissNotice?.({ noticeId });
  }

  useEffect(() => {
    const nextExpiry = notices
      .map((notice) =>
        notice.expiresAt ? Date.parse(notice.expiresAt) : Number.NaN,
      )
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const delay = Math.max(0, nextExpiry - Date.now()) + 30;
    const timer = window.setTimeout(() => setTick((n) => n + 1), delay);
    return () => window.clearTimeout(timer);
  }, [notices.map((notice) => `${notice.id}:${notice.expiresAt ?? ""}`).join("|")]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!notice) return;
      if (e.key === "Escape" && escFree) {
        e.preventDefault();
        dismiss(notice.id);
        return;
      }
      if ((e.key === "d" || e.key === "D") && !escFree) {
        e.preventDefault();
        dismiss(notice.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, escFree, notice?.id]);

  if (!show || !notice) return null;

  return (
    <NoticeCard
      notice={notice}
      remaining={remaining}
      dismissHint={dismissHint}
      onDismiss={() => dismiss(notice.id)}
      {...(notice.action === "switch_model" && props.onToggleModel
        ? { onToggleModel: props.onToggleModel }
        : {})}
    />
  );
}

function NoticeCard(props: {
  notice: SessionNotice;
  remaining: number;
  dismissHint: string;
  onDismiss: () => void;
  onToggleModel?: (() => void) | undefined;
}) {
  const { notice, remaining, dismissHint, onDismiss, onToggleModel } = props;
  const kindLabel = notice.kind === "error" ? "Error" : "Warning";
  const sourceLabel = notice.source === "harness" ? "Harness" : "Agent";
  return (
    <div
      className={
        notice.kind === "error"
          ? "session-notice-banner session-notice-banner--error"
          : "session-notice-banner session-notice-banner--warning"
      }
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <div className="session-notice-copy">
        <strong>
          {kindLabel} · {sourceLabel}
          {notice.blocking ? " · blocking" : ""}
        </strong>
        <span className="session-notice-title">{notice.title}</span>
        {notice.detail ? (
          <span className="session-notice-detail">{notice.detail}</span>
        ) : null}
        {remaining > 0 ? (
          <span className="session-notice-more">
            {remaining} more after this
          </span>
        ) : null}
      </div>
      <div className="session-notice-buttons">
        {onToggleModel ? (
          <button
            type="button"
            className="btn btn-outlined"
            onClick={onToggleModel}
          >
            Model · {modShiftHint("M")}
          </button>
        ) : null}
        <button type="button" className="btn btn-primary" onClick={onDismiss}>
          Dismiss · {dismissHint}
        </button>
      </div>
    </div>
  );
}
