import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTerminal, SessionState } from "@ai-ide/shared";
import { getBridge } from "../bridge";

/**
 * Mirror of the main-process cap (terminals.ts MAX_BUFFER_CHARS): a build or a
 * test run emits megabytes, and holding all of it in renderer state means every
 * repaint of the pane re-scans and re-lays out the whole thing until the process
 * runs out of memory. Only the tail is ever readable anyway.
 */
const MAX_BUFFER_CHARS = 200_000;

function appendCapped(previous: string, data: string): string {
  const next = previous + data;
  return next.length > MAX_BUFFER_CHARS
    ? next.slice(-MAX_BUFFER_CHARS)
    : next;
}

/** Built from a char code because a literal ESC in a regex is a lint error. */
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`,
  "g",
);

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE, "").replace(/\r/g, "");
}

export function LiveTerminalPane(props: {
  state: SessionState | null;
  commandHistory: Array<{
    command: string;
    exitCode: number | null;
    summary: string;
    success: boolean;
  }>;
}) {
  const terminals = props.state?.liveTerminals ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [userInput, setUserInput] = useState("");
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  const active = useMemo(() => {
    if (activeId && terminals.some((t) => t.id === activeId)) {
      return terminals.find((t) => t.id === activeId) ?? null;
    }
    return terminals[0] ?? null;
  }, [activeId, terminals]);

  useEffect(() => {
    if (!active && terminals[0]) setActiveId(terminals[0].id);
  }, [active, terminals]);

  useEffect(() => {
    setBuffers((prev) => {
      const missing = terminals.filter((t) => prev[t.id] === undefined);
      // `terminals` is a fresh clone on every state push, so this effect runs
      // constantly; seeding a new object each time would re-render the pane and
      // re-scan the output for nothing.
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const t of missing) next[t.id] = t.lastOutput ?? "";
      return next;
    });
  }, [terminals]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.terminal?.subscribe) return;
    return bridge.terminal.subscribe((event) => {
      setBuffers((prev) => ({
        ...prev,
        [event.terminalId]: appendCapped(prev[event.terminalId] ?? "", event.data),
      }));
    });
  }, []);

  // Depend on the strings, not on `active`: the terminal object is a new clone on
  // every push, while its output usually is not new at all.
  const activeBuffer = active ? buffers[active.id] : undefined;
  const activeFallback = active?.lastOutput ?? "";
  const activeOutput = useMemo(
    () => stripAnsi(activeBuffer ?? activeFallback),
    [activeBuffer, activeFallback],
  );

  useEffect(() => {
    if (!stickRef.current || !preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [active?.id, activeOutput]);

  const sendUser = () => {
    if (!active || !userInput) return;
    void getBridge()?.terminal?.writeUser(active.id, `${userInput}\n`);
    setUserInput("");
  };

  if (terminals.length === 0 && props.commandHistory.length === 0) {
    return (
      <div className="empty-state verify-empty">
        <strong>Terminals</strong>
        <p>
          Interactive terminals opened by the agent appear here with live
          output. One-shot <code>run_command</code> history is listed below when
          available.
        </p>
      </div>
    );
  }

  return (
    <div className="live-terminal-pane">
      {terminals.length > 0 ? (
        <>
          <div className="live-terminal-tabs" role="tablist">
            {terminals.map((t: LiveTerminal, index) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active?.id === t.id}
                className={`live-terminal-tab ${
                  active?.id === t.id ? "is-active" : ""
                }`}
                onClick={() => setActiveId(t.id)}
              >
                {t.title}
                <span className="live-terminal-tab-meta">
                  {t.status === "running" ? "· live" : "· exited"}
                  {index < 9 ? ` · ${index + 1}` : ""}
                </span>
              </button>
            ))}
          </div>
          {active ? (
            <>
              <pre
                ref={preRef}
                className="live-terminal-output"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  stickRef.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                }}
              >
                {activeOutput || "Waiting for output…"}
              </pre>
              <div className="live-terminal-input-row">
                <input
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Type to send to this terminal…"
                  disabled={active.status !== "running"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      sendUser();
                    }
                  }}
                />
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={active.status !== "running" || !userInput}
                  onClick={sendUser}
                >
                  Send · Enter
                </button>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {props.commandHistory.length > 0 ? (
        <div className="live-terminal-history">
          <div className="live-terminal-history-title">Command history</div>
          <ul className="verify-list">
            {props.commandHistory.map((entry, i) => (
              <li
                key={`${entry.command}-${i}`}
                className="verify-list-item verify-list-terminal"
              >
                <span
                  className={`verify-exit-code ${
                    entry.exitCode === 0
                      ? "ok"
                      : entry.exitCode === null
                        ? "unknown"
                        : "fail"
                  }`}
                >
                  {entry.exitCode === null ? "?" : entry.exitCode}
                </span>
                <code className="verify-list-primary">{entry.command}</code>
                <span className="verify-list-secondary">{entry.summary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
