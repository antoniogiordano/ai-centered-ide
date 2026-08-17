import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import type {
  PlanPhase,
  SessionState,
  SessionSummary,
  ToolCall,
  Turn,
} from "@ai-ide/shared";
import { deriveProductPhase } from "@ai-ide/shared";
import { getBridge } from "../bridge";
import { ArchitectureSummary } from "./ArchitectureSummary";
import {
  CollapsibleUserText,
  MarkdownMessage,
  TranscriptLabel,
} from "./TranscriptMessages";
import { LiveTerminalPane } from "./LiveTerminalPane";
import { DiffNavigator } from "./DiffNavigator";
import { BuildContinueBanner } from "./BuildContinueBanner";
import { StartBuildBanner } from "./StartBuildBanner";
import { CommitBuildBanner } from "./CommitBuildBanner";
import { IntegrateBuildBanner } from "./IntegrateBuildBanner";
import { ArchiveChatBanner } from "./ArchiveChatBanner";
import { TestingReportBoard } from "./TestingReportBoard";
import { playChecklistChime } from "../lib/checklistSound";

const SCROLL_STICK_THRESHOLD_PX = 96;

const PHASE_STATUS_LABEL: Record<PlanPhase["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

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
      return "Write file";
    case "replace_in_file":
      return "Replace in file";
    case "run_command":
      return "Run command";
    case "get_test_report":
      return "Test report";
    case "list_failed_tests":
      return "Failed tests";
    case "read_test_log":
      return "Read test log";
    case "read_file":
      return "Read file";
    case "list_dir":
      return "List dir";
    case "search_text":
      return "Search text";
    case "git_status":
      return "Git status";
    case "git_diff":
      return "Git diff";
    case "git_commit":
      return "Git commit";
    case "checkpoint_restore":
      return "Restore checkpoint";
    case "upsert_plan":
      return "Update plan";
    case "read_plan":
      return "Read plan";
    case "add_phase":
      return "Add phase";
    case "replace_phase":
      return "Replace phase";
    case "delete_phase":
      return "Delete phase";
    case "add_check":
      return "Add check";
    case "replace_check":
      return "Replace check";
    case "delete_check":
      return "Delete check";
    case "set_questions":
      return "Set questions";
    case "propose_plan_ready":
      return "Propose plan ready";
    case "propose_testing_ready":
      return "Propose testing ready";
    case "search_graph":
      return "Graph search";
    case "search_code":
      return "Code search";
    default:
      return toolName.replace(/_/g, " ");
  }
}

/** One-line target for the collapsed tool row (path / command / query). */
function toolTargetPreview(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  if (typeof args.path === "string" && args.path.trim()) {
    return args.path.trim();
  }
  if (typeof args.command === "string" && args.command.trim()) {
    const cmd = args.command.trim().replace(/\s+/g, " ");
    return cmd.length > 100 ? `${cmd.slice(0, 97)}…` : cmd;
  }
  if (typeof args.query === "string" && args.query.trim()) {
    const q = args.query.trim();
    return q.length > 80 ? `“${q.slice(0, 77)}…”` : `“${q}”`;
  }
  if (typeof args.text === "string" && args.text.trim() && toolName.startsWith("terminal_")) {
    const t = args.text.trim().replace(/\s+/g, " ");
    return t.length > 80 ? `${t.slice(0, 77)}…` : t;
  }
  if (toolName === "upsert_plan" && Array.isArray(args.phases)) {
    return `${args.phases.length} phase${args.phases.length === 1 ? "" : "s"}`;
  }
  return null;
}

/** Args for the expandable log — keep full write_file / replace_in_file payloads. */
function formatToolArgsForLog(
  _toolName: string,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args || Object.keys(args).length === 0) return null;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatToolOutputForLog(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
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

function ToolLogCard(props: {
  toolName: string;
  status: "running" | "done" | "failed";
  label?: string;
  summary?: string;
  error?: string;
  arguments?: Record<string, unknown>;
  output?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = actionLabel(props.toolName);
  const target = toolTargetPreview(props.toolName, props.arguments);
  const argsLog = formatToolArgsForLog(props.toolName, props.arguments);
  const outputLog = formatToolOutputForLog(props.output);
  const statusClass =
    props.status === "running"
      ? "tool-row-running"
      : props.status === "done"
        ? "tool-row-ok"
        : "tool-row-fail";

  return (
    <div className={`tool-row ${statusClass}`}>
      <button
        type="button"
        className="tool-row-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tool-row-label">
          {props.status === "running" ? (
            <span className="thinking-spinner" aria-hidden />
          ) : null}
          <span className="tool-row-name">{label}</span>
          {target ? <span className="tool-row-target">{target}</span> : null}
        </span>
        <span className="tool-row-meta">
          {props.status}
          <span className="tool-row-chevron" aria-hidden>
            {expanded ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="tool-row-body">
          <p className="tool-row-toolid">
            <code>{props.toolName}</code>
            {props.label && props.label !== label ? (
              <span> · {props.label}</span>
            ) : null}
          </p>
          {props.summary?.trim() ? (
            <p className="tool-row-summary">{props.summary.trim()}</p>
          ) : null}
          {props.error ? (
            <p className="tool-row-error">{props.error}</p>
          ) : null}
          {argsLog ? (
            <>
              <div className="tool-row-section">Arguments</div>
              <pre className="tool-row-args">{argsLog}</pre>
            </>
          ) : (
            <p className="tool-row-summary">No arguments yet.</p>
          )}
          {outputLog ? (
            <>
              <div className="tool-row-section">Output</div>
              <pre className="tool-row-output">{outputLog}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function roleHeading(role: Turn["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Agent";
  if (role === "system") return "System";
  return "Tool";
}

const VISIBLE_USER_COLLAPSE_CHARS = 160;

export type ChatClipboardMode = "visible" | "deep";

/** Plain-text export of the open chat for the clipboard. */
export function formatChatForClipboard(
  turns: Turn[],
  meta?: { title?: string | null; workspaceName?: string | null },
  mode: ChatClipboardMode = "visible",
): string {
  const deep = mode === "deep";
  const lines: string[] = [];
  const title = meta?.title?.trim() || "Chat";
  lines.push(`# ${title}`);
  if (meta?.workspaceName?.trim()) {
    lines.push(`Workspace: ${meta.workspaceName.trim()}`);
  }
  if (deep) {
    lines.push("Mode: deep (full tool args + output)");
  }
  lines.push("");

  for (const turn of turns) {
    lines.push(`## ${roleHeading(turn.role)}`);
    const body = turn.content.trim();
    if (body) {
      if (
        !deep &&
        turn.role === "user" &&
        body.length > VISIBLE_USER_COLLAPSE_CHARS
      ) {
        lines.push(`${body.slice(0, VISIBLE_USER_COLLAPSE_CHARS).trimEnd()}…`);
      } else {
        lines.push(body);
      }
    }

    for (const result of turn.toolResults ?? []) {
      const call = turn.toolCalls?.find((c) => c.id === result.callId);
      const name = call?.name ?? "tool";
      const status = result.success ? "done" : "failed";
      const target = toolTargetPreview(name, call?.arguments);
      lines.push("");
      if (deep) {
        lines.push(`### ${actionLabel(name)} · ${name} (${status})`);
        if (result.summary?.trim()) {
          lines.push(result.summary.trim());
        }
        if (result.error?.trim()) {
          lines.push("");
          lines.push(`Error: ${result.error.trim()}`);
        }
        if (call?.arguments && Object.keys(call.arguments).length > 0) {
          lines.push("");
          lines.push("Arguments:");
          lines.push("```json");
          lines.push(JSON.stringify(call.arguments, null, 2));
          lines.push("```");
        }
        if (result.output !== undefined) {
          lines.push("");
          lines.push("Output:");
          if (typeof result.output === "string") {
            lines.push(result.output);
          } else {
            lines.push("```json");
            lines.push(JSON.stringify(result.output, null, 2));
            lines.push("```");
          }
        }
      } else {
        // Collapsed tool row as shown in chat (label + one-line target).
        const head = target
          ? `${actionLabel(name)} · ${target} · ${status}`
          : `${actionLabel(name)} · ${status}`;
        lines.push(`- ${head}`);
        if (result.error?.trim()) {
          lines.push(`  Error: ${result.error.trim()}`);
        }
      }
    }

    for (const call of turn.toolCalls ?? []) {
      const hasResult = (turn.toolResults ?? []).some((r) => r.callId === call.id);
      if (hasResult) continue;
      lines.push("");
      const target = toolTargetPreview(call.name, call.arguments);
      if (deep) {
        lines.push(`### ${actionLabel(call.name)} · ${call.name} (no result)`);
        if (call.arguments && Object.keys(call.arguments).length > 0) {
          lines.push("Arguments:");
          lines.push("```json");
          lines.push(JSON.stringify(call.arguments, null, 2));
          lines.push("```");
        }
      } else {
        const head = target
          ? `${actionLabel(call.name)} · ${target} · running`
          : `${actionLabel(call.name)} · running`;
        lines.push(`- ${head}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function PlanBoard(props: {
  state: SessionState | null;
  onOpenQa?: (() => void) | undefined;
  planning?: boolean;
  compact?: boolean;
}) {
  const phases = props.state?.planPhases ?? [];
  const questions = props.state?.planQuestions ?? [];
  const planStatus = props.state?.planStatus ?? "drafting";
  const mode = props.state?.mode ?? "plan";
  const planning =
    props.planning ??
    (mode === "plan" || planStatus === "drafting");
  const [justDoneIds, setJustDoneIds] = useState<Set<string>>(() => new Set());
  const knownDoneRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (planning) {
      knownDoneRef.current = null;
      return;
    }
    const doneIds = new Set<string>();
    for (const phase of phases) {
      for (const item of phase.checklist) {
        if (item.done) doneIds.add(item.id);
      }
    }
    if (knownDoneRef.current === null) {
      knownDoneRef.current = doneIds;
      return;
    }
    const newly: string[] = [];
    for (const id of doneIds) {
      if (!knownDoneRef.current.has(id)) newly.push(id);
    }
    knownDoneRef.current = doneIds;
    if (newly.length === 0) return;
    setJustDoneIds((prev) => {
      const next = new Set(prev);
      for (const id of newly) next.add(id);
      return next;
    });
    playChecklistChime();
    const t = window.setTimeout(() => {
      setJustDoneIds((prev) => {
        const next = new Set(prev);
        for (const id of newly) next.delete(id);
        return next;
      });
    }, 1200);
    return () => window.clearTimeout(t);
  }, [phases, planning]);

  if (phases.length === 0) {
    return (
      <div className="empty-state verify-empty">
        <strong>{planning ? "Draft plan" : "Delivery plan"}</strong>
        <p>
          {planning
            ? "Shape phases and checklist items with the agent. Clarifying questions refine the plan — progress tracking starts in Build."
            : "No plan defined for this chat yet."}
        </p>
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
    <div
      className={`plan-board ${planning ? "plan-board-drafting" : ""} ${props.compact ? "plan-board-compact" : ""}`}
    >
      <div className="plan-board-scroll">
        <div className="plan-board-header">
          <div>
            <strong>{planning ? "Draft plan" : "Executing"}</strong>
            <p className="verify-hint">
              {planning
                ? `${phases.length} phase${phases.length === 1 ? "" : "s"} · ${totalCount} checklist item${totalCount === 1 ? "" : "s"}`
                : `${doneCount}/${totalCount} checklist · ${phases.length} phase${phases.length === 1 ? "" : "s"}`}
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
                              <span className="plan-question-option-key">
                                {key}
                              </span>
                              {opt.label}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {(() => {
                      const options = q.options ?? [];
                      const pickedIds = q.selectedOptionIds ?? [];
                      const pillsShowAnswer =
                        options.length > 0 && pickedIds.length > 0;
                      if (pillsShowAnswer) return null;
                      if (q.answer) {
                        return (
                          <div className="plan-question-answer">{q.answer}</div>
                        );
                      }
                      return (
                        <div className="plan-question-answer muted">
                          Waiting for answer in Q&A dialog…
                        </div>
                      );
                    })()}
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
              className={`plan-phase ${planning ? "plan-phase-draft" : `plan-phase-${phase.status}`}`}
              aria-current={
                !planning && phase.status === "in_progress" ? "step" : undefined
              }
            >
              <div className="plan-phase-header">
                <span className="plan-phase-index">{index + 1}</span>
                <span className="plan-phase-title">{phase.title}</span>
                {!planning ? (
                  <span className="plan-phase-status">
                    {PHASE_STATUS_LABEL[phase.status]}
                  </span>
                ) : null}
              </div>
              <ul className="plan-checklist">
                {phase.checklist.map((item) => (
                  <li
                    key={item.id}
                    className={`plan-check ${
                      !planning && item.done ? "plan-check-done" : ""
                    } ${justDoneIds.has(item.id) ? "plan-check-just-done" : ""}`}
                  >
                    <span className="plan-check-mark" aria-hidden>
                      {planning ? "·" : item.done ? "✓" : "○"}
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
  onBuildStarted?: (() => void) | undefined;
  onBuildCommitted?: (() => void) | undefined;
}) {
  const { state, sessions, activeSessionId, onBuildStarted, onBuildCommitted } =
    props;
  const bridge = getBridge();
  const busy = isBusy(state?.status);
  const canCancel = typeof bridge?.session.cancel === "function";
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const turns = state?.turns ?? [];
  const showThinking =
    busy &&
    (state?.status === "thinking" ||
      state?.status === "running" ||
      (state?.status === "streaming" && Boolean(state?.activityLabel))) &&
    !state?.partialAssistantText;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [copyDeepState, setCopyDeepState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyDeepResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTabTitle =
    sessions.find((s) => s.id === activeSessionId)?.title ?? "Chat";

  async function copyChat(mode: ChatClipboardMode) {
    if (turns.length === 0) return;
    const text = formatChatForClipboard(
      turns,
      {
        title: activeTabTitle,
        workspaceName: state?.workspace?.name ?? null,
      },
      mode,
    );
    const setState = mode === "deep" ? setCopyDeepState : setCopyState;
    const resetRef = mode === "deep" ? copyDeepResetRef : copyResetRef;
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      window.dispatchEvent(
        new CustomEvent("aici:copy-open-chat-result", {
          detail: { mode, ok: true },
        }),
      );
    } catch {
      setState("failed");
      window.dispatchEvent(
        new CustomEvent("aici:copy-open-chat-result", {
          detail: { mode, ok: false },
        }),
      );
    }
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setState("idle"), 1600);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "d") return;
      if (turns.length === 0) return;
      e.preventDefault();
      void copyChat(key === "d" ? "deep" : "visible");
    }
    function onCopyEvent() {
      void copyChat("visible");
    }
    function onCopyDeepEvent() {
      void copyChat("deep");
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("aici:copy-open-chat", onCopyEvent);
    window.addEventListener("aici:copy-open-chat-deep", onCopyDeepEvent);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("aici:copy-open-chat", onCopyEvent);
      window.removeEventListener("aici:copy-open-chat-deep", onCopyDeepEvent);
    };
  }, [turns, activeTabTitle, state?.workspace?.name]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      if (copyDeepResetRef.current) clearTimeout(copyDeepResetRef.current);
    };
  }, []);

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

  // copyState kept so clipboard feedback still resets after keyboard shortcuts
  void copyState;
  void copyDeepState;

  return (
    <>
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
            <span className="error-banner-detail">{state.error}</span>
          </div>
        ) : null}

        <div className="transcript" aria-live="polite">
          {turns.map((turn) => (
            <div key={turn.id} className="transcript-block">
              {turn.role === "user" ? (
                <div className="transcript-user">
                  <TranscriptLabel tone="user">You</TranscriptLabel>
                  {turn.attachments?.length ? (
                    <div className="transcript-attachments" aria-label="Attachments">
                      {turn.attachments.map((att) =>
                        att.kind === "image" && att.previewDataUrl ? (
                          <img
                            key={att.id}
                            className="transcript-thumb"
                            src={att.previewDataUrl}
                            alt={att.name}
                            title={att.name}
                          />
                        ) : (
                          <span
                            key={att.id}
                            className="transcript-file-chip"
                            title={att.path ?? att.name}
                          >
                            {att.name}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
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
                      <ToolLogCard
                        key={result.callId}
                        toolName={toolName}
                        status={result.success ? "done" : "failed"}
                        {...(result.summary ? { summary: result.summary } : {})}
                        {...(result.error ? { error: result.error } : {})}
                        {...(toolCall?.arguments
                          ? { arguments: toolCall.arguments }
                          : {})}
                        {...(result.output !== undefined
                          ? { output: result.output }
                          : {})}
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
                <ToolLogCard
                  key={tool.id}
                  toolName={tool.name}
                  status={tool.status}
                  label={tool.label}
                  {...(tool.summary ? { summary: tool.summary } : {})}
                  {...(tool.arguments ? { arguments: tool.arguments } : {})}
                  {...(tool.output !== undefined ? { output: tool.output } : {})}
                  {...(tool.error ? { error: tool.error } : {})}
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

        <StartBuildBanner state={state} onConfirmed={onBuildStarted} />
        <BuildContinueBanner state={state} />
        <CommitBuildBanner state={state} onCommitted={onBuildCommitted} />
        <IntegrateBuildBanner state={state} onDone={onBuildCommitted} />
        <ArchiveChatBanner state={state} />

        {(state?.pendingApprovals ?? []).map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} />
        ))}
      </div>
    </>
  );
}

function formatApprovalArgs(toolCall: ToolCall): string | null {
  const args = toolCall.arguments ?? {};
  if (toolCall.name === "run_command" && typeof args.command === "string") {
    return args.command;
  }
  if (toolCall.name === "git_commit" && typeof args.message === "string") {
    return args.message;
  }
  if (toolCall.name === "write_file" && typeof args.path === "string") {
    const content =
      typeof args.content === "string"
        ? args.content.slice(0, 400)
        : undefined;
    return content ? `${args.path}\n\n${content}` : args.path;
  }
  if (toolCall.name === "replace_in_file" && typeof args.path === "string") {
    const search =
      typeof args.search === "string" ? args.search.slice(0, 200) : "";
    const replace =
      typeof args.replace === "string" ? args.replace.slice(0, 200) : "";
    return `${args.path}\n\n- ${search}\n+ ${replace}`;
  }
  try {
    const json = JSON.stringify(args, null, 2);
    return json === "{}" ? null : json.slice(0, 2000);
  } catch {
    return null;
  }
}

const TERMINAL_AUTO_APPROVE_MS = 3000;

function isTerminalCommandApproval(toolName: string): boolean {
  return toolName === "run_command";
}

function ApprovalCard(props: {
  approval: {
    id: string;
    description: string;
    riskLevel: string;
    toolCall: ToolCall;
  };
}) {
  const { approval } = props;
  const argsPreview = formatApprovalArgs(approval.toolCall);
  const autoApprove = isTerminalCommandApproval(approval.toolCall.name);
  const [progress, setProgress] = useState(0);
  const settledRef = useRef(false);
  const approvalIdRef = useRef(approval.id);
  approvalIdRef.current = approval.id;

  const settle = (action: "approve" | "approve_session" | "reject") => {
    if (settledRef.current) return;
    settledRef.current = true;
    const id = approvalIdRef.current;
    if (action === "reject") {
      void getBridge()?.session.reject(id);
      return;
    }
    void getBridge()?.session.approve(id, action === "approve_session");
  };

  useEffect(() => {
    settledRef.current = false;
    setProgress(0);
    if (!autoApprove) return;

    const startedAt = Date.now();
    const tick = () => {
      if (settledRef.current) return;
      const p = Math.min(1, (Date.now() - startedAt) / TERMINAL_AUTO_APPROVE_MS);
      setProgress(p);
      if (p >= 1) {
        settledRef.current = true;
        void getBridge()?.session.approve(approvalIdRef.current);
      }
    };
    tick();
    const id = window.setInterval(tick, 32);
    return () => window.clearInterval(id);
  }, [approval.id, autoApprove]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle("reject");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        settle("approve");
        return;
      }
      if (e.key === "1" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        settle("approve");
        return;
      }
      if (e.key === "2" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        settle("approve_session");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [approval.id]);

  return (
    <div className="approval-card" role="dialog" aria-label="Approval required">
      {autoApprove ? (
        <div className="approval-progress" aria-hidden>
          <div
            className="approval-progress-fill"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      ) : null}
      <div className="approval-card-body">
        <strong>
          {autoApprove
            ? "Command — auto-approves in 3s"
            : "Approval required"}
        </strong>
        <p>{approval.description}</p>
        <p className="approval-meta">
          Tool: {approval.toolCall.name} · Risk: {approval.riskLevel}
        </p>
        {argsPreview ? (
          <pre className="approval-command" tabIndex={0}>
            {argsPreview}
          </pre>
        ) : null}
        <div className="approval-actions">
          <button
            type="button"
            className="btn"
            onClick={() => settle("approve")}
          >
            Approve once · Enter
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => settle("approve_session")}
          >
            Approve for session · 2
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => settle("reject")}
          >
            Reject · Esc
          </button>
        </div>
      </div>
    </div>
  );
}

function BuildCockpit(props: {
  state: SessionState | null;
  onOpenQa?: (() => void) | undefined;
}) {
  const turns = props.state?.turns ?? [];
  const commandHistory = useMemo(() => extractCommandHistory(turns), [turns]);
  const refreshToken = useMemo(() => {
    let n = 0;
    for (const turn of turns) {
      for (const call of turn.toolCalls ?? []) {
        if (
          call.name === "write_file" ||
          call.name === "replace_in_file" ||
          call.name === "run_command" ||
          call.name === "git_commit"
        ) {
          n += 1;
        }
      }
      n += turn.toolResults?.length ?? 0;
    }
    n += props.state?.liveTerminals?.length ?? 0;
    return `${props.state?.status ?? ""}:${n}`;
  }, [turns, props.state?.liveTerminals?.length, props.state?.status]);

  const showTerminal = (props.state?.liveTerminals?.length ?? 0) > 0;
  const phase = props.state ? deriveProductPhase(props.state) : "building";
  const showTestingReport = phase === "testing" || phase === "checking";

  return (
    <div className={`build-cockpit ${showTerminal ? "build-cockpit-with-terminal" : ""}`}>
      <section
        className="build-cockpit-plan"
        aria-label={
          phase === "checking"
            ? "Check report"
            : showTestingReport
              ? "Testing report"
              : "Plan"
        }
      >
        {showTestingReport ? (
          <TestingReportBoard state={props.state} />
        ) : (
          <PlanBoard state={props.state} onOpenQa={props.onOpenQa} planning={false} />
        )}
      </section>
      <section className="build-cockpit-side" aria-label="Branch diff">
        <DiffNavigator
          workspaceRoot={props.state?.workspace?.resolvedRootPath}
          refreshToken={refreshToken}
        />
      </section>
      {showTerminal ? (
        <section className="build-cockpit-terminal" aria-label="Terminal">
          <LiveTerminalPane state={props.state} commandHistory={commandHistory} />
        </section>
      ) : null}
    </div>
  );
}

export function VerifyPane(props: {
  state: SessionState | null;
  onOpenQa?: (() => void) | undefined;
  onOpenArchitecture?: (() => void) | undefined;
  planning?: boolean;
}) {
  const {
    state,
    onOpenQa,
    onOpenArchitecture,
    planning = false,
  } = props;

  if (planning) {
    return (
      <div className="pane-body plan-side-pane" role="region" aria-label="Plan">
        <ArchitectureSummary
          workspaceRoot={state?.workspace?.resolvedRootPath}
          planning
          onOpenArchitecture={onOpenArchitecture}
        />
        <PlanBoard state={state} onOpenQa={onOpenQa} planning />
      </div>
    );
  }

  return (
    <div className="pane-body build-side-pane" role="region" aria-label="Build">
      <BuildCockpit state={state} onOpenQa={onOpenQa} />
    </div>
  );
}

