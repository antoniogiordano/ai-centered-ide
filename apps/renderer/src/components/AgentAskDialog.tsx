import { useEffect, useRef, useState } from "react";
import type { PendingAgentAsk } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function modHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

function optionKeyLabel(
  selection: PendingAgentAsk["selection"],
  index: number,
): string {
  if (selection === "multiple") return String(index + 1);
  return String.fromCharCode(65 + index);
}

/**
 * Blocking answer UI for the ask_user tool. Unlike PlanQaDialog there is no
 * recap step, so a single keystroke never submits on its own — the user always
 * confirms with Enter before the agent acts on the decision.
 */
export function AgentAskDialog(props: { pending: PendingAgentAsk }) {
  const { pending } = props;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setSelectedIds([]);
    setText("");
  }, [pending.id]);

  const canConfirm = selectedIds.length > 0 || text.trim().length > 0;

  const submit = (cancelled: boolean) => {
    void getBridge()?.session.agentAsk?.({
      askId: pending.id,
      selectedOptionIds: selectedIds,
      text,
      cancelled,
    });
  };

  const pick = (optionId: string) => {
    setSelectedIds((prev) => {
      if (pending.selection === "single") return [optionId];
      return prev.includes(optionId)
        ? prev.filter((id) => id !== optionId)
        : [...prev, optionId];
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
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

      if (e.key === "Enter" && !e.shiftKey) {
        if (typing && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        e.stopPropagation();
        if (canConfirm) submit(false);
        return;
      }

      if (typing) return;

      if (pending.selection === "single") {
        const letter = e.key.toUpperCase();
        if (!/^[A-Z]$/.test(letter)) return;
        const option = pending.options[letter.charCodeAt(0) - 65];
        if (!option) return;
        e.preventDefault();
        e.stopPropagation();
        pick(option.id);
        return;
      }

      if (!/^[1-9]$/.test(e.key)) return;
      const option = pending.options[Number(e.key) - 1];
      if (!option) return;
      e.preventDefault();
      e.stopPropagation();
      pick(option.id);
    };
    // Capture phase: the overlay must win over editors/terminals underneath.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, selectedIds, text, canConfirm]);

  return (
    <div className="palette-overlay qa-overlay" role="presentation">
      <div
        className="qa-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-ask-title"
      >
        <header className="qa-dialog-header">
          <div>
            <div className="qa-dialog-kicker">Agent needs a decision</div>
            <h2 id="agent-ask-title" className="qa-dialog-title">
              Your call
            </h2>
          </div>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => submit(true)}
          >
            Skip · Esc
          </button>
        </header>
        <div className="qa-dialog-body">
          <div className={`qa-selection-badge qa-selection-${pending.selection}`}>
            {pending.selection === "single"
              ? "Single choice · A–Z"
              : "Multiple choice · 1–9"}
          </div>
          {pending.context ? (
            <p className="qa-dialog-lead">{pending.context}</p>
          ) : null}
          <p className="qa-question-text">{pending.prompt}</p>
          <ul className="qa-options">
            {pending.options.map((option, index) => {
              const selected = selectedIds.includes(option.id);
              return (
                <li key={option.id}>
                  <button
                    type="button"
                    className={`qa-option ${selected ? "is-selected" : ""}`}
                    onClick={() => pick(option.id)}
                  >
                    <span className="qa-option-key">
                      {optionKeyLabel(pending.selection, index)}
                    </span>
                    <span className="qa-option-label">{option.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {pending.allowFreeText ? (
            <>
              <label className="terminal-ask-text-label" htmlFor="agent-ask-text">
                Or answer in your own words · {modHint("I")}
              </label>
              <textarea
                id="agent-ask-text"
                ref={textRef}
                className="terminal-confirm-text"
                value={text}
                spellCheck={false}
                rows={3}
                onChange={(e) => setText(e.target.value)}
                placeholder="Optional — overrides or refines the options above…"
              />
            </>
          ) : null}
          <div className="qa-dialog-actions">
            <button
              type="button"
              className="primary-btn"
              disabled={!canConfirm}
              onClick={() => submit(false)}
            >
              Confirm · Enter
            </button>
          </div>
          <div className="qa-dialog-hints">
            <span>
              {pending.selection === "single" ? (
                <>
                  <kbd>A</kbd>–<kbd>Z</kbd> select
                </>
              ) : (
                <>
                  <kbd>1</kbd>–<kbd>9</kbd> toggle
                </>
              )}{" "}
              · <kbd>{modHint("I")}</kbd> write · <kbd>Enter</kbd> confirm ·{" "}
              <kbd>Esc</kbd> skip
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
