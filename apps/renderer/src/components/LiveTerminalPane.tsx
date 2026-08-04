import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTerminal, SessionState } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
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
      const next = { ...prev };
      for (const t of terminals) {
        if (next[t.id] === undefined) {
          next[t.id] = t.lastOutput ?? "";
        }
      }
      return next;
    });
  }, [terminals]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.terminal?.subscribe) return;
    return bridge.terminal.subscribe((event) => {
      setBuffers((prev) => ({
        ...prev,
        [event.terminalId]: (prev[event.terminalId] ?? "") + event.data,
      }));
    });
  }, []);

  useEffect(() => {
    if (!stickRef.current || !preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [active?.id, buffers]);

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
                {stripAnsi(buffers[active.id] ?? active.lastOutput ?? "") ||
                  "Waiting for output…"}
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
