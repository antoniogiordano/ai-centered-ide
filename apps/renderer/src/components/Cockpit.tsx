import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type UIEvent,
} from "react";
import type {
  PlanPhase,
  SessionState,
  SessionSummary,
  ToolCall,
  ToolResult,
  Turn,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { MonacoEditor } from "./MonacoEditor";
import {
  CollapsibleUserText,
  MarkdownMessage,
  TranscriptLabel,
} from "./TranscriptMessages";

const SCROLL_STICK_THRESHOLD_PX = 96;

export type VerifyTab =
  | "plan"
  | "browser"
  | "diff"
  | "environment"
  | "tests"
  | "terminal"
  | "files";

const PHASE_STATUS_LABEL: Record<PlanPhase["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

const VERIFY_TABS: { id: VerifyTab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "browser", label: "Browser" },
  { id: "diff", label: "Diff" },
  { id: "files", label: "Files" },
  { id: "environment", label: "Environment" },
  { id: "tests", label: "Tests" },
  { id: "terminal", label: "Terminal" },
];

function toolNameByCallId(turn: Turn): Map<string, string> {
  const map = new Map<string, string>();
  for (const call of turn.toolCalls ?? []) {
    map.set(call.id, call.name);
  }
  return map;
}

function actionLabel(toolName: string): string {
  switch (toolName) {
    case "write_file":
      return "Modified file";
    case "run_command":
      return "Ran command";
    case "read_file":
      return "Read file";
    case "list_dir":
      return "Listed directory";
    case "search_text":
      return "Searched text";
    case "git_status":
      return "Git status";
    case "git_diff":
      return "Git diff";
    case "git_commit":
      return "Git commit";
    case "checkpoint_restore":
      return "Restored checkpoint";
    default:
      return toolName.replace(/_/g, " ");
  }
}

function extractFileChanges(turns: Turn[]): { path: string; summary: string; success: boolean }[] {
  const changes: { path: string; summary: string; success: boolean }[] = [];
  for (const turn of turns) {
    const names = toolNameByCallId(turn);
    for (const result of turn.toolResults ?? []) {
      const name = names.get(result.callId);
      if (name !== "write_file" && name !== "git_commit") continue;
      const args = turn.toolCalls?.find((c) => c.id === result.callId)?.arguments;
      const path =
        typeof args?.path === "string"
          ? args.path
          : typeof args?.file === "string"
            ? args.file
            : "unknown file";
      changes.push({ path, summary: result.summary, success: result.success });
    }
  }
  return changes;
}

function extractCommandHistory(
  turns: Turn[],
): { command: string; exitCode: number | null; summary: string; success: boolean }[] {
  const history: {
    command: string;
    exitCode: number | null;
    summary: string;
    success: boolean;
  }[] = [];
  for (const turn of turns) {
    const names = toolNameByCallId(turn);
    for (const result of turn.toolResults ?? []) {
      if (names.get(result.callId) !== "run_command") continue;
      const args = turn.toolCalls?.find((c) => c.id === result.callId)?.arguments;
      const command = typeof args?.command === "string" ? args.command : "(unknown command)";
      const output = result.output;
      let exitCode: number | null = null;
      if (output && typeof output === "object" && "exitCode" in output) {
        const code = (output as { exitCode?: unknown }).exitCode;
        exitCode = typeof code === "number" ? code : null;
      }
      history.push({ command, exitCode, summary: result.summary, success: result.success });
    }
  }
  return history;
}

function ActionCard(props: { toolName: string; result: ToolResult; toolCall?: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const label = actionLabel(props.toolName);

  return (
    <div className={`tool-row ${props.result.success ? "tool-row-ok" : "tool-row-fail"}`}>
      <button
        type="button"
        className="tool-row-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tool-row-label">{label}</span>
        <span className="tool-row-meta">{props.result.success ? "done" : "failed"}</span>
      </button>
      {expanded ? (
        <div className="tool-row-body">
          <p>{props.result.summary}</p>
          {props.result.error ? (
            <p className="tool-row-error">{props.result.error}</p>
          ) : null}
          {props.toolCall ? (
            <pre className="tool-row-args">
              {JSON.stringify(props.toolCall.arguments, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LiveToolRow(props: {
  label: string;
  status: "running" | "done" | "failed";
  summary?: string;
}) {
  return (
    <div className={`tool-row tool-row-${props.status === "running" ? "running" : props.status === "done" ? "ok" : "fail"}`}>
      <div className="tool-row-header">
        <span className="tool-row-label">
          {props.status === "running" ? (
            <span className="thinking-spinner" aria-hidden />
          ) : null}
          {props.label}
        </span>
        <span className="tool-row-meta">{props.status}</span>
      </div>
      {props.summary ? (
        <div className="tool-row-body">
          <p>{props.summary}</p>
        </div>
      ) : null}
    </div>
  );
}

function PlanBoard(props: {
  state: SessionState | null;
  onOpenQa?: (() => void) | undefined;
}) {
  const phases = props.state?.planPhases ?? [];
  const questions = props.state?.planQuestions ?? [];
  const planStatus = props.state?.planStatus ?? "drafting";
  const mode = props.state?.mode ?? "plan";

  if (phases.length === 0) {
    return (
      <div className="empty-state verify-empty">
        <strong>Delivery plan</strong>
        <p>
          {mode === "plan"
            ? "Talk with the agent to define phases, checklists, and clarifying questions. The plan will appear here as it takes shape."
            : "No plan defined for this chat yet."}
        </p>
        <p className="verify-hint">Status: {planStatus}</p>
      </div>
    );
  }

  const doneCount = phases.reduce(
    (n, p) => n + p.checklist.filter((c) => c.done).length,
    0,
  );
  const totalCount = phases.reduce((n, p) => n + p.checklist.length, 0);
  const openQuestions = questions.filter((q) => q.status === "open");

  return (
    <div className="plan-board">
      <div className="plan-board-header">
        <div>
          <strong>
            {mode === "plan" ? "Planning Q&A" : "Executing"} · {planStatus}
          </strong>
          <p className="verify-hint">
            {doneCount}/{totalCount} checklist · {phases.length} phase
            {phases.length === 1 ? "" : "s"}
            {questions.length
              ? ` · ${openQuestions.length} open question${openQuestions.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        {openQuestions.length > 0 && props.onOpenQa ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={props.onOpenQa}
          >
            Answer Q&A
          </button>
        ) : null}
      </div>

      {questions.length > 0 ? (
        <div className="plan-questions">
          <div className="plan-questions-title">Clarifying questions</div>
          <ul className="plan-questions-list">
            {questions.map((q, index) => (
              <li
                key={q.id}
                className={`plan-question plan-question-${q.status}`}
              >
                <span className="plan-question-index">Q{index + 1}</span>
                <div className="plan-question-body">
                  <div className="plan-question-text">
                    {q.text}
                    <span
                      className={`plan-question-kind plan-question-kind-${q.selection ?? "single"}`}
                    >
                      {(q.selection ?? "single") === "multiple"
                        ? "Multi"
                        : "Single"}
                    </span>
                  </div>
                  {(q.options ?? []).length > 0 ? (
                    <div className="plan-question-options">
                      {(q.options ?? []).map((opt, optIndex) => {
                        const key =
                          (q.selection ?? "single") === "multiple"
                            ? String(optIndex + 1)
                            : String.fromCharCode(65 + optIndex);
                        const picked = q.selectedOptionIds?.includes(opt.id);
                        return (
                          <span
                            key={opt.id}
                            className={`plan-question-option ${picked ? "is-picked" : ""}`}
                          >
                            <span className="plan-question-option-key">{key}</span>
                            {opt.label}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {q.answer ? (
                    <div className="plan-question-answer">{q.answer}</div>
                  ) : (
                    <div className="plan-question-answer muted">
                      Waiting for answer in Q&A dialog…
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ol className="plan-phase-list">
        {phases.map((phase, index) => (
          <li
            key={phase.id}
            className={`plan-phase plan-phase-${phase.status}`}
            aria-current={phase.status === "in_progress" ? "step" : undefined}
          >
            <div className="plan-phase-header">
              <span className="plan-phase-index">{index + 1}</span>
              <span className="plan-phase-title">{phase.title}</span>
              <span className="plan-phase-status">
                {PHASE_STATUS_LABEL[phase.status]}
              </span>
            </div>
            <ul className="plan-checklist">
              {phase.checklist.map((item) => (
                <li
                  key={item.id}
                  className={`plan-check ${item.done ? "plan-check-done" : ""}`}
                >
                  <span className="plan-check-mark" aria-hidden>
                    {item.done ? "✓" : "○"}
                  </span>
                  <span>{item.text}</span>
                </li>
              ))}
              {phase.checklist.length === 0 ? (
                <li className="plan-check muted">No checklist items yet</li>
              ) : null}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function isBusy(status: SessionState["status"] | undefined): boolean {
  return (
    status === "thinking" ||
    status === "streaming" ||
    status === "tool" ||
    status === "running"
  );
}

export function ConversationPane(props: {
  state: SessionState | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
}) {
  const { state, sessions, activeSessionId } = props;
  const bridge = getBridge();
  const busy = isBusy(state?.status);
  const canCancel = typeof bridge?.session.cancel === "function";
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  async function createSession() {
    await bridge?.session.create();
  }

  async function switchSession(sessionId: string) {
    if (sessionId === activeSessionId) return;
    await bridge?.session.switch(sessionId);
  }

  async function closeSession(sessionId: string, e: MouseEvent) {
    e.stopPropagation();
    await bridge?.session.close(sessionId);
  }

  const turns = state?.turns ?? [];
  const showThinking =
    busy &&
    (state?.status === "thinking" || state?.status === "running") &&
    !state?.partialAssistantText;

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= SCROLL_STICK_THRESHOLD_PX;
  }

  function scrollTranscriptToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  // New session or freshly sent user message: pin to bottom again.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeSessionId]);

  useEffect(() => {
    const last = turns[turns.length - 1];
    if (last?.role === "user") {
      stickToBottomRef.current = true;
    }
  }, [turns]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollTranscriptToBottom();
  }, [
    turns,
    state?.partialAssistantText,
    state?.liveTools,
    state?.activityLabel,
    state?.error,
    state?.pendingApprovals,
    busy,
    showThinking,
  ]);

  const tabSessions =
    sessions.length > 0
      ? sessions
      : activeSessionId
        ? [
            {
              id: activeSessionId,
              title: "New chat",
              updatedAt: new Date().toISOString(),
              workspaceName: state?.workspace?.name ?? null,
            },
          ]
        : [];

  return (
    <>
      <div className="session-tabs" role="tablist" aria-label="Chat sessions">
        <div className="session-tabs-scroll">
          {tabSessions.map((session) => {
            const active = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                role="tab"
                aria-selected={active}
                className={`session-tab ${active ? "session-tab-active" : ""}`}
              >
                <button
                  type="button"
                  className="session-tab-main"
                  title={session.title}
                  onClick={() => void switchSession(session.id)}
                >
                  <span className="session-tab-title">{session.title}</span>
                </button>
                <button
                  type="button"
                  className="session-tab-close"
                  aria-label={`Close ${session.title}`}
                  onClick={(e) => void closeSession(session.id, e)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="session-tab-add"
          title="New chat"
          aria-label="New chat"
          onClick={() => void createSession()}
        >
          +
        </button>
      </div>
      <div
        ref={scrollRef}
        className="pane-body transcript-body"
        onScroll={handleTranscriptScroll}
      >
        {!state?.workspace && (
          <div className="empty-state">
            Open a workspace to start. The agent operates inside your project folder only.
          </div>
        )}

        {state?.workspace && turns.length === 0 && !busy ? (
          <div className="empty-state">
            Workspace <strong>{state.workspace.name}</strong> is ready. Send a message to begin.
          </div>
        ) : null}

        {state?.error ? (
          <div className="error-banner" role="alert">
            <strong>Error</strong>
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="transcript" aria-live="polite">
          {turns.map((turn) => (
            <div key={turn.id} className="transcript-block">
              {turn.role === "user" ? (
                <div className="transcript-user">
                  <TranscriptLabel tone="user">You</TranscriptLabel>
                  <CollapsibleUserText content={turn.content} />
                </div>
              ) : null}

              {turn.role === "assistant" ? (
                <div className="transcript-assistant">
                  <TranscriptLabel tone="agent">Agent</TranscriptLabel>
                  {(turn.toolResults ?? []).map((result) => {
                    const toolCall = turn.toolCalls?.find((c) => c.id === result.callId);
                    const toolName = toolCall?.name ?? "tool";
                    return (
                      <ActionCard
                        key={result.callId}
                        toolName={toolName}
                        result={result}
                        {...(toolCall ? { toolCall } : {})}
                      />
                    );
                  })}
                  {turn.content ? <MarkdownMessage content={turn.content} /> : null}
                </div>
              ) : null}
            </div>
          ))}

          {busy || (state?.liveTools?.length ?? 0) > 0 ? (
            <div className="transcript-block transcript-live">
              {(state?.liveTools ?? []).map((tool) => (
                <LiveToolRow
                  key={tool.id}
                  label={tool.label}
                  status={tool.status}
                  {...(tool.summary ? { summary: tool.summary } : {})}
                />
              ))}

              {showThinking ? (
                <div className="thinking-row" role="status">
                  <span className="thinking-spinner" aria-hidden />
                  <span>{state?.activityLabel ?? "Thinking…"}</span>
                  {canCancel ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm thinking-stop"
                      onClick={() => void bridge?.session.cancel?.()}
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              ) : null}

              {state?.partialAssistantText ? (
                <div className="transcript-assistant">
                  <TranscriptLabel tone="agent">Agent</TranscriptLabel>
                  <MarkdownMessage content={state.partialAssistantText} streaming />
                  {canCancel ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm stream-stop"
                      onClick={() => void bridge?.session.cancel?.()}
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {(state?.pendingApprovals ?? []).map((approval) => (
          <div key={approval.id} className="approval-card">
            <strong>Approval required</strong>
            <p>{approval.description}</p>
            <p className="approval-meta">
              Tool: {approval.toolCall.name} · Risk: {approval.riskLevel}
            </p>
            <div className="approval-actions">
              <button
                type="button"
                className="btn"
                onClick={() => void getBridge()?.session.approve(approval.id)}
              >
                Approve once
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void getBridge()?.session.approve(approval.id, true)
                }
              >
                Approve for session category
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void getBridge()?.session.reject(approval.id)}
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function VerifyTabPanel(props: {
  tab: VerifyTab;
  state: SessionState | null;
  onOpenQa?: (() => void) | undefined;
}) {
  const { tab, state, onOpenQa } = props;
  const turns = state?.turns ?? [];

  const fileChanges = useMemo(() => extractFileChanges(turns), [turns]);
  const commandHistory = useMemo(() => extractCommandHistory(turns), [turns]);

  switch (tab) {
    case "plan":
      return <PlanBoard state={state} onOpenQa={onOpenQa} />;

    case "browser":
      return (
        <div className="empty-state verify-empty">
          <strong>Browser QA preview</strong>
          <p>No active browser session. When QA runs, the live preview appears here.</p>
          <p className="verify-hint">
            Base URL hint: configure your app URL in environment settings (e.g.{" "}
            <code>http://localhost:5173</code>).
          </p>
        </div>
      );

    case "diff":
      if (fileChanges.length === 0) {
        return (
          <div className="empty-state verify-empty">
            <strong>Session file changes</strong>
            <p>Modified files from this session will be listed here with diffs.</p>
          </div>
        );
      }
      return (
        <ul className="verify-list">
          {fileChanges.map((change, i) => (
            <li key={`${change.path}-${i}`} className="verify-list-item">
              <span className={`verify-badge ${change.success ? "ok" : "fail"}`}>
                {change.success ? "modified" : "failed"}
              </span>
              <span className="verify-list-primary">{change.path}</span>
              <span className="verify-list-secondary">{change.summary}</span>
            </li>
          ))}
        </ul>
      );

    case "files": {
      const samplePath = fileChanges[0]?.path ?? "README.md";
      const sample =
        fileChanges[0]?.summary ??
        "// Monaco is read-only by default.\n// Switch to manual edit mode from the command palette when needed.\n";
      return (
        <div className="files-panel">
          <div className="files-toolbar">
            <span className="verify-hint">{samplePath} · read-only</span>
          </div>
          <MonacoEditor path={samplePath} value={sample} readOnly />
        </div>
      );
    }

    case "environment":
      return (
        <div className="empty-state verify-empty">
          <strong>Environment services</strong>
          <p>No services running yet. Start your dev stack to see API, web, and database status.</p>
          {state?.workspace ? (
            <p className="verify-hint">Workspace: {state.workspace.name}</p>
          ) : null}
        </div>
      );

    case "tests":
      return (
        <div className="empty-state verify-empty">
          <strong>Cypress scenarios</strong>
          <p>No test recordings or scenarios yet. Record a flow or run Cypress to populate this tab.</p>
        </div>
      );

    case "terminal":
      if (commandHistory.length === 0) {
        return (
          <div className="empty-state verify-empty">
            <strong>Command history</strong>
            <p>Commands executed by the agent appear here with exit codes and output summaries.</p>
          </div>
        );
      }
      return (
        <ul className="verify-list">
          {commandHistory.map((entry, i) => (
            <li key={`${entry.command}-${i}`} className="verify-list-item verify-list-terminal">
              <span
                className={`verify-exit-code ${
                  entry.exitCode === 0 ? "ok" : entry.exitCode === null ? "unknown" : "fail"
                }`}
              >
                {entry.exitCode === null ? "?" : entry.exitCode}
              </span>
              <code className="verify-list-primary">{entry.command}</code>
              <span className="verify-list-secondary">{entry.summary}</span>
            </li>
          ))}
        </ul>
      );
  }
}

export function VerifyPane(props: {
  state: SessionState | null;
  activeTab: VerifyTab;
  onTabChange: (tab: VerifyTab) => void;
  onOpenQa?: (() => void) | undefined;
}) {
  const { state, activeTab, onTabChange, onOpenQa } = props;

  return (
    <>
      <div className="pane-header verify-header">
        <span>Verify</span>
        <div className="tab-bar" role="tablist" aria-label="Verify panels">
          {VERIFY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`tab ${activeTab === tab.id ? "tab-active" : ""}`}
              aria-selected={activeTab === tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pane-body" role="tabpanel">
        <VerifyTabPanel tab={activeTab} state={state} onOpenQa={onOpenQa} />
      </div>
    </>
  );
}
