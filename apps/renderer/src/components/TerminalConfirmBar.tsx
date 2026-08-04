import { useEffect, useRef, useState } from "react";
import type { PendingTerminalConfirm } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function modHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

export function TerminalConfirmBar(props: {
  pending: PendingTerminalConfirm;
}) {
  const { pending } = props;
  const [text, setText] = useState(pending.text);
  const [progress, setProgress] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const textSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setText(pending.text);
  }, [pending.id, pending.text]);

  useEffect(() => {
    const deadline = new Date(pending.deadlineAt).getTime();
    const duration = pending.durationMs || 3000;
    const start = deadline - duration;
    const tick = () => {
      const now = Date.now();
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      setProgress(p);
    };
    tick();
    const id = window.setInterval(tick, 32);
    return () => window.clearInterval(id);
  }, [pending.deadlineAt, pending.durationMs, pending.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void getBridge()?.session.terminalConfirm?.(pending.id, "cancel");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void getBridge()?.session.terminalConfirm?.(
          pending.id,
          "approve",
          text,
        );
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "i"
      ) {
        e.preventDefault();
        textRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending.id, text]);

  const onChange = (value: string) => {
    setText(value);
    if (textSyncTimer.current) clearTimeout(textSyncTimer.current);
    textSyncTimer.current = setTimeout(() => {
      void getBridge()?.session.terminalConfirmEdit?.(pending.id, value);
    }, 120);
  };

  return (
    <div className="terminal-confirm-bar" role="dialog" aria-label="Confirm terminal input">
      <div className="terminal-confirm-progress" aria-hidden>
        <div
          className="terminal-confirm-progress-fill"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="terminal-confirm-header">
        <div>
          <div className="terminal-confirm-kicker">Terminal input</div>
          <strong>Confirm or edit — auto-sends in 3s</strong>
        </div>
        <span className="terminal-confirm-meta">
          {pending.appendNewline ? "⏎ newline appended" : "raw bytes"}
        </span>
      </div>
      <textarea
        ref={textRef}
        className="terminal-confirm-text"
        value={text}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(6, Math.max(2, text.split("\n").length))}
      />
      <div className="terminal-confirm-actions">
        <button
          type="button"
          className="ghost-btn"
          onClick={() =>
            void getBridge()?.session.terminalConfirm?.(pending.id, "cancel")
          }
        >
          Cancel · Esc
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => textRef.current?.focus()}
        >
          Edit · {modHint("I")}
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={() =>
            void getBridge()?.session.terminalConfirm?.(
              pending.id,
              "approve",
              text,
            )
          }
        >
          Send · Enter
        </button>
      </div>
    </div>
  );
}
