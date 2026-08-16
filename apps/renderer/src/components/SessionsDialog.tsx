import { useEffect, useRef } from "react";
import type { SessionSummary } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function phaseLetter(phase: string | undefined): string {
  if (phase === "building") return "B";
  if (phase === "testing") return "T";
  return "P";
}

function phaseTitle(phase: string | undefined): string {
  if (phase === "building") return "Build";
  if (phase === "testing") return "Test";
  return "Plan";
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    Boolean(el.isContentEditable)
  );
}

export function SessionsDialog(props: {
  open: boolean;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onClose: () => void;
}) {
  const { open, sessions, activeSessionId, onClose } = props;
  const bridge = getBridge();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (isTypingTarget(e.target)) return;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const idx = Number(digit[1]) - 1;
        const session = sessions[idx];
        if (!session) return;
        e.preventDefault();
        if (e.altKey) {
          void bridge?.session.close(session.id);
          return;
        }
        if (session.id !== activeSessionId) {
          void bridge?.session.switch(session.id);
        }
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, sessions, activeSessionId, bridge, onClose]);

  if (!open) return null;

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="provider-dialog sessions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sessions-dialog-title"
        tabIndex={-1}
      >
        <div className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Sessions</div>
            <h2 className="provider-dialog-title" id="sessions-dialog-title">
              Switch chat
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
            Chats share one git working tree. Switching is intentional — pick a
            session below. Digit activates · ⌥digit closes.
          </p>
          <ul className="provider-list sessions-list">
            {sessions.map((session, index) => {
              const active = session.id === activeSessionId;
              return (
                <li
                  key={session.id}
                  className={
                    active
                      ? "provider-list-item provider-list-item-active"
                      : "provider-list-item"
                  }
                >
                  <button
                    type="button"
                    className="provider-list-main"
                    onClick={() => {
                      if (!active) void bridge?.session.switch(session.id);
                      onClose();
                    }}
                  >
                    <span className="provider-list-name">
                      <span
                        className={`session-tab-phase session-tab-phase-${session.phase ?? "planning"}`}
                        aria-hidden
                      >
                        {phaseLetter(session.phase)}
                      </span>
                      {session.title}
                    </span>
                    <span className="provider-list-meta">
                      {phaseTitle(session.phase)}
                      {session.workspaceName
                        ? ` · ${session.workspaceName}`
                        : ""}
                      {active ? " · current" : ""}
                    </span>
                    <span className="provider-list-sc">
                      {index < 9 ? `· ${index + 1}` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void bridge?.session.close(session.id)}
                  >
                    Close{index < 9 ? ` · ⌥${index + 1}` : ""}
                  </button>
                </li>
              );
            })}
            {sessions.length === 0 ? (
              <li className="muted">No sessions yet.</li>
            ) : null}
          </ul>
        </div>
      </div>
    </div>
  );
}
