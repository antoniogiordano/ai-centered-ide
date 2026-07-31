import { useState, type FormEvent, type RefObject } from "react";
import type { SessionState } from "@ai-ide/shared";
import { getBridge } from "../bridge";

const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const FOCUS_HINT = isApple
  ? "Press ⌘I to talk to the agent"
  : "Press Ctrl+I to talk to the agent";

function isBusy(status: SessionState["status"] | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running"
  );
}

export function ComposerBar(props: {
  state: SessionState | null;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { state, inputRef } = props;
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useState("");
  const busy = isBusy(state?.status);
  const canSend = Boolean(value.trim()) && !busy;

  const activePlaceholder =
    state?.mode === "plan"
      ? "Describe the goal — we’ll shape phases and checklists together…"
      : "Continue development — the agent follows the Plan tab…";

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const bridge = getBridge();
    const content = value.trim();
    if (!bridge || !content || busy) return;
    setValue("");
    await bridge.session.sendMessage(content);
    inputRef.current?.focus();
  }

  return (
    <form className="composer-bar" onSubmit={(e) => void submit(e)}>
      <div className={`composer-shell ${focused ? "composer-shell-focused" : ""}`}>
        <input
          ref={inputRef}
          name="message"
          className="composer-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={focused || value ? activePlaceholder : FOCUS_HINT}
          aria-label="Message to the agent"
          readOnly={busy}
        />
        <button
          type="submit"
          className="composer-send"
          disabled={!canSend}
          title={busy ? "Agent is working…" : "Send"}
          aria-label="Send message"
        >
          {busy ? (
            <span className="composer-send-busy" aria-hidden>
              …
            </span>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <path
                d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
}
