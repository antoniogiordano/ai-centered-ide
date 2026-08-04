import { useEffect, useRef, useState } from "react";
import type { PendingTerminalAsk } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function modHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

function letterForIndex(index: number): string {
  return String.fromCharCode(65 + index);
}

export function TerminalAskDialog(props: {
  pending: PendingTerminalAsk;
}) {
  const { pending } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState(pending.suggestedText);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSelectedId(null);
    setText(pending.suggestedText);
  }, [pending.id, pending.suggestedText]);

  const submit = (cancelled = false) => {
    void getBridge()?.session.terminalAsk?.({
      askId: pending.id,
      selectedOptionId: selectedId,
      text,
      cancelled,
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.isContentEditable);

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        submit(true);
        return;
      }

      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "i"
      ) {
        e.preventDefault();
        e.stopPropagation();
        textRef.current?.focus();
        return;
      }

      if (!typing && e.key.length === 1) {
        const letter = e.key.toUpperCase();
        const index = letter.charCodeAt(0) - 65;
        if (index >= 0 && index < pending.options.length) {
          e.preventDefault();
          e.stopPropagation();
          const option = pending.options[index];
          if (!option) return;
          setSelectedId(option.id);
          if (!text.trim()) {
            setText(option.label);
          }
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        if (typing && e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          submit(false);
          return;
        }
        if (!typing) {
          e.preventDefault();
          e.stopPropagation();
          if (selectedId || text.trim()) submit(false);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.id, pending.options, selectedId, text]);

  return (
    <div
      className="palette-overlay qa-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) submit(true);
      }}
    >
      <div
        className="qa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-ask-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Terminal decision</div>
            <h2 id="terminal-ask-title" className="qa-dialog-title">
              Choose what to send
            </h2>
          </div>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => submit(true)}
          >
            Cancel · Esc
          </button>
        </header>
        <div className="qa-dialog-body">
          <p className="qa-question-text">{pending.prompt}</p>
          <ul className="qa-options">
            {pending.options.map((option, index) => {
              const selected = selectedId === option.id;
              const key = letterForIndex(index);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    className={`qa-option ${selected ? "is-selected" : ""}`}
                    onClick={() => {
                      setSelectedId(option.id);
                      if (!text.trim()) setText(option.label);
                    }}
                  >
                    <span className="qa-option-key">{key}</span>
                    <span className="qa-option-label">{option.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <label className="terminal-ask-text-label" htmlFor="terminal-ask-text">
            Exact text for terminal · {modHint("I")}
          </label>
          <textarea
            id="terminal-ask-text"
            ref={textRef}
            className="terminal-confirm-text"
            value={text}
            spellCheck={false}
            rows={4}
            onChange={(e) => setText(e.target.value)}
            placeholder="Confirm or edit the exact stdin text…"
          />
          {pending.writeToTerminal ? (
            <p className="qa-dialog-lead">
              Confirming will write this text
              {pending.appendNewline ? " (+ newline)" : ""} to the terminal.
            </p>
          ) : (
            <p className="qa-dialog-lead">
              Choice is returned to the agent without writing to the terminal.
            </p>
          )}
          <div className="qa-dialog-actions">
            <button
              type="button"
              className="primary-btn"
              disabled={!selectedId && !text.trim()}
              onClick={() => submit(false)}
            >
              Confirm · Enter
            </button>
          </div>
          <div className="qa-dialog-hints">
            <span>
              <kbd>A</kbd>–<kbd>Z</kbd> select · <kbd>{modHint("I")}</kbd> edit
              text · <kbd>Enter</kbd> confirm · <kbd>Esc</kbd> cancel
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
