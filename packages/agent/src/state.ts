import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  PlanPhase,
  PlanQuestion,
  PlanStatus,
  SessionState,
  ToolCall,
  ToolResult,
  Turn,
} from "@ai-ide/shared";
import { createEmptySessionState } from "@ai-ide/shared";
import {
  formatArchitectureForPrompt,
  planChecklistProgress as sharedPlanChecklistProgress,
  planHasOpenWork as sharedPlanHasOpenWork,
  CHECKLIST_CONTINUE_USER_MESSAGE,
  PLAN_CONTINUE_USER_MESSAGE,
} from "@ai-ide/shared";
import { ArchitectureStore } from "@ai-ide/workspace";
import type { ChatMessage } from "@ai-ide/provider";

export type TurnPhase =
  | "idle"
  | "building_context"
  | "awaiting_provider"
  | "executing_tools"
  | "awaiting_approval"
  | "completed"
  | "failed";

export class TurnStateMachine {
  phase: TurnPhase = "idle";
  iteration = 0;
  consecutiveToolFailures = 0;
  lastToolName: string | null = null;
  sameToolStreak = 0;

  begin(): void {
    this.phase = "building_context";
    this.iteration = 0;
    this.consecutiveToolFailures = 0;
    this.lastToolName = null;
    this.sameToolStreak = 0;
  }

  /**
   * @param tank When true (build + open checklist), never stop on iteration cap —
   * local models keep going until the plan is done or the user hits Stop.
   */
  nextIteration(tank = false): boolean {
    this.iteration += 1;
    if (!tank && this.iteration > MAX_ITERATIONS) {
      this.phase = "failed";
      return false;
    }
    return true;
  }

  /**
   * @param tank In tank mode, tool failure / same-tool streak do not abort the loop.
   */
  recordToolResult(
    toolName: string,
    success: boolean,
    tank = false,
  ): boolean {
    if (!success) {
      this.consecutiveToolFailures += 1;
    } else {
      this.consecutiveToolFailures = 0;
    }

    if (toolName === this.lastToolName) {
      this.sameToolStreak += 1;
    } else {
      this.lastToolName = toolName;
      this.sameToolStreak = 1;
    }

    if (tank) return true;

    if (this.consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      this.phase = "failed";
      return false;
    }
    if (this.sameToolStreak >= MAX_SAME_TOOL_STREAK) {
      this.phase = "failed";
      return false;
    }
    return true;
  }

  complete(): void {
    this.phase = "completed";
  }
}

/** Planning / ask caps. Building tank mode ignores this via nextIteration(true). */
export const MAX_ITERATIONS = 12;
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
export const MAX_SAME_TOOL_STREAK = 8;

function formatPlanForPrompt(state: SessionState): string {
  if (state.planPhases.length === 0) {
    return "Current plan: (empty — call upsert_plan with draft phases + open questions).";
  }
  const planning = productPhaseForState(state) === "planning";
  const lines = state.planPhases.map((phase, i) => {
    const checks = phase.checklist
      .map((c) =>
        planning
          ? `    - ${c.text}`
          : `    - [${c.done ? "x" : " "}] ${c.text}`,
      )
      .join("\n");
    return planning
      ? `${i + 1}. ${phase.title}\n${checks || "    (no checklist items yet)"}`
      : `${i + 1}. [${phase.status}] ${phase.title}\n${checks || "    (no checklist items yet)"}`;
  });
  const questions =
    state.planQuestions.length === 0
      ? "Open questions: (none)"
      : [
          "Open questions:",
          ...state.planQuestions.map((q, i) => {
            const kind = q.selection === "multiple" ? "multi" : "single";
            const opts =
              q.options.length > 0
                ? ` options=[${q.options.map((o) => o.label).join(" | ")}]`
                : "";
            const ans = q.answer ? ` → ${q.answer}` : "";
            return `${i + 1}. [${q.status}] [${kind}] ${q.text}${opts}${ans}`;
          }),
        ].join("\n");
  const ready = state.planReadyProposal
    ? `User confirmation pending for branch ${state.planReadyProposal.suggestedBranch}. Do not call propose_plan_ready again unless the plan changes.`
    : null;

  const focus = (() => {
    if (planning) return null;
    const { done, total } = sharedPlanChecklistProgress(state);
    const current =
      state.planPhases.find((p) => p.status === "in_progress") ??
      state.planPhases.find(
        (p) =>
          p.status === "pending" ||
          p.status === "failed" ||
          p.checklist.some((c) => !c.done),
      );
    const nextItem = current?.checklist.find((c) => !c.done);
    return [
      "Focus (authoritative — prefer this over chat history):",
      `- Checklist progress: ${done}/${total}`,
      `- Current phase: ${current ? `${current.title} [${current.status}]` : "(none)"}`,
      `- Next open item: ${nextItem ? nextItem.text : "(all done)"}`,
    ].join("\n");
  })();

  return [
    `Plan status: ${state.planStatus}`,
    ...(focus ? [focus, ""] : []),
    "Current plan:",
    ...lines,
    questions,
    ...(ready ? [ready] : []),
  ].join("\n");
}

export function buildSystemPrompt(state: SessionState): string {
  const root = state.workspace?.resolvedRootPath ?? state.workspace?.rootPath;
  const phase = productPhaseForState(state);
  const planning = phase === "planning";

  const identity = [
    "You are the product manager of this AI-First IDE.",
    "You collaborate with the user through a planning Q&A, then drive development against an agreed plan.",
    "Keep replies concise. Prefer short turns over long monologues.",
  ];

  const workspaceLine = root
    ? [
        `Active workspace root: ${root}`,
        "Paths are relative to the workspace root (never absolute OS paths).",
        "When the codebase index is ready, prefer graph tools: search_graph, get_code_snippet, trace_path, get_architecture, search_code.",
        "When the index is not ready, use list_dir / read_file / search_text as fallback.",
      ]
    : [
        "No workspace is open yet. Ask the user to open a project folder before reading files.",
      ];

  const architectureBlock = (() => {
    if (!root) return formatArchitectureForPrompt(null);
    try {
      const view = new ArchitectureStore(root).loadOrDetect();
      return formatArchitectureForPrompt(view.profile, {
        intent: view.intent,
        drift: view.drift,
        fromFile: view.fromFile,
      });
    } catch {
      return formatArchitectureForPrompt(null);
    }
  })();

  const planningRules = [
    "PHASE: PLANNING — the plan is being created (not executed).",
    "Available tools: codebase graph tools (when indexed) OR list_dir/read_file/search_text (fallback), plus read_architecture, upsert_architecture, upsert_plan, propose_plan_ready.",
    "Unavailable: write_file, git_*, run_command, terminal_*, checkpoint_restore.",
    "IMPORTANT: Never tell the user you cannot run shell commands. Commands run only after Start Build. When the user asks to run npm/git/shell now, call propose_plan_ready so the IDE can switch to Build — then you will get run_command / terminal_*.",
    "",
    architectureBlock,
    "",
    "Stack & dependencies:",
    "- Call read_architecture early for detected stack + ARCHITECTURE.md intent/overrides.",
    "- Prefer search_graph / get_architecture over dumping whole files when the index is ready.",
    "- Declare languages, frameworks, and packages in the plan (phases/checklist + clarifying questions). Do not invent a parallel Architecture chat.",
    "- Do NOT install packages in planning. Installs happen in DEVELOPMENT via run_command / terminal_* after the user starts build.",
    "- Use upsert_architecture only for sparse intent/overrides when detection is wrong — never dump the whole stack into the file.",
    "",
    "Plan structure (CRUD only — no progress tracking yet):",
    "- Use upsert_plan to create/update/remove phases and checklist item texts.",
    "- Do NOT mark checklist items done. Do NOT set phase status to completed/failed/skipped. Progress marking starts only after development begins.",
    "- Checklist items are a draft outline of work, not a live todo board.",
    "",
    "Clarifying questions (critical — dedicated Plan Q&A dialog; USER answers there, never you):",
    "- ALWAYS put open questions in upsert_plan.questions. NEVER ask multiple-choice / A-B-C questions only in chat prose — the Plan Q&A UI will not open.",
    "- EVERY question MUST include selection: \"single\" OR \"multiple\", plus 2–8 concrete options[{id,label}].",
    "- Leave status=\"open\". Do NOT invent answers. Do NOT re-ask in prose after upsert_plan.",
    "- Prefer 1–3 open questions per turn. If the user already answered or said to skip and just run something, clear questions=[] and proceed.",
    "- Chat may briefly say that the Plan Q&A dialog is open — do not paste the options as a numbered list in the message.",
    "",
    "Turn discipline (critical):",
    "1) First broad request: lightly explore the repo, then upsert_plan with draft phases + checklist texts + open questions if needed. Do NOT dump a full analysis essay.",
    "2) After user answers (or says to proceed / only run a command): upsert_plan to reshape; if they want execution now, call propose_plan_ready.",
    "3) Never implement, rewrite files, or pretend development has started.",
    "4) When the user explicitly wants to run shell/npm/git (e.g. \"npm init\", \"install\", \"just initialize\"): keep a minimal plan focused on that, set questions=[], then call propose_plan_ready immediately. Do not keep interviewing.",
    "5) Otherwise, when the plan is solid AND all open questions are answered, call propose_plan_ready with a short suggestedBranch (feat/kebab-case). The IDE opens Start Build — do NOT start building yourself.",
    "6) Do NOT call propose_plan_ready while upsert_plan.questions still has status=open items.",
    "TANK MODE (planning): until propose_plan_ready is accepted by the user (Start Build), you must keep using tools — upsert_plan (phases + checks) and/or open questions. NEVER stop on exploration-only narration. Brief explore → upsert_plan. The IDE re-prompts until the plan is ready or open questions await the user.",
    formatPlanForPrompt(state),
  ];

  const buildRules = [
    "PHASE: DEVELOPMENT — now you may mark checklist progress and run commands.",
    architectureBlock,
    "The plan structure was agreed in planning. Implement it phase by phase using tools (including write/git/commands/terminals).",
    "On the first build turn after Start Build: take action immediately — run tools for the first incomplete checklist item. Do not only acknowledge Build mode.",
    "Code reading: use search_graph → get_code_snippet / trace_path when indexed; do not invent qualified_name values — take them from search results.",
    "When the user asks to run a command: DO IT with run_command (one-shot) or terminal_open + terminal_write (interactive). Prefer run_command for npm init / short installs.",
    "Never claim you cannot execute shell commands in this phase — you can.",
    "One-shot commands: run_command. Interactive / long-running shells: terminal_open → terminal_write (user gets 3s confirm/edit) → terminal_read. When the user must choose interactively, use terminal_ask.",
    "Install packages when the plan calls for them (never during planning).",
    "Shell / listing hygiene:",
    "- Prefer list_dir / search_text / search_graph over shell ls/find. Never recursively list node_modules, .git, dist, or build output.",
    "- Command stdout is auto-filtered (noise dirs stripped + size-capped); still avoid generating that noise.",
    "Checklist progress (critical — structure is locked):",
    "- The plan phases/checklist texts are frozen from planning. Do NOT add, remove, or rename phases or checklist items. Do NOT change questions.",
    "- upsert_plan may ONLY flip checklist done=true/false and phase status (pending|in_progress|completed|skipped|failed).",
    "- Always pass the full phases array with the same ids/titles/texts; change only done and status.",
    "- After EACH completed checklist item, immediately call upsert_plan with that item done=true (keep prior done items true). Prefer one item per upsert_plan so the Plan UI animates and chimes per check.",
    "- Do not batch many newly completed items into a single upsert_plan at the end of a long turn when you can mark them as you go.",
    "- Update phase status (in_progress / completed) as work moves forward.",
    "Keep the plan truthful: only mark items done when the work is actually done.",
    "TANK MODE: while any checklist item is open, NEVER stop with prose only — keep calling tools (upsert_plan progress + implementation) until every item is done=true and phases are completed. The IDE will keep re-prompting forever until the checklist is complete (or the user hits Stop). No waiting for the user.",
    "When ALL checklist items are done and phases are completed, say so clearly. Do not invent a separate test phase unless the plan already includes testing work.",
    formatPlanForPrompt(state),
  ];

  return [
    ...identity,
    ...workspaceLine,
    ...(planning ? planningRules : buildRules),
  ].join("\n");
}

/** Ordered chat turns for the provider (system first, then history, then new user if needed). */
export function buildContext(state: SessionState, userMessage: string): Turn[] {
  const systemTurn: Turn = {
    id: randomUUID(),
    role: "system",
    content: buildSystemPrompt(state),
    createdAt: new Date().toISOString(),
  };

  const building = productPhaseForState(state) === "building";
  if (!building) {
    const history = state.turns.filter(
      (t) => t.role === "user" || t.role === "assistant",
    );
    const last = history[history.length - 1];
    const alreadyHasUser =
      last?.role === "user" && last.content === userMessage;
    return [
      systemTurn,
      ...history,
      ...(alreadyHasUser
        ? []
        : [
            {
              id: randomUUID(),
              role: "user" as const,
              content: userMessage,
              createdAt: new Date().toISOString(),
            },
          ]),
    ];
  }

  // Building: goal + plan (in system) + short fresh tail — not the full chat.
  const goal = sessionGoal(state);
  const history = state.turns.filter(
    (t) =>
      (t.role === "user" || t.role === "assistant") &&
      !isNoiseTranscriptTurn(t),
  );
  const tail = history.slice(-BUILD_CONTEXT_TAIL_TURNS);
  const turns: Turn[] = [systemTurn];
  if (goal) {
    const goalAlreadyInTail = tail.some(
      (t) => t.role === "user" && t.content === goal,
    );
    if (!goalAlreadyInTail) {
      turns.push({
        id: randomUUID(),
        role: "user",
        content: `Original goal:\n${goal}`,
        createdAt: new Date().toISOString(),
      });
    }
  }
  turns.push(...tail);
  const last = turns[turns.length - 1];
  const alreadyHasUser =
    last?.role === "user" && last.content === userMessage;
  if (!alreadyHasUser) {
    turns.push({
      id: randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString(),
    });
  }
  return turns;
}

/** First real user ask for this session (skips IDE/tank synthetic prompts). */
export function sessionGoal(
  state: Pick<SessionState, "turns">,
): string | null {
  for (const turn of state.turns) {
    if (turn.role !== "user") continue;
    const text = turn.content.trim();
    if (!text || isSyntheticUserPrompt(text)) continue;
    return text;
  }
  return null;
}

export function isSyntheticUserPrompt(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  if (text === CHECKLIST_CONTINUE_USER_MESSAGE) return true;
  if (text.startsWith("[IDE · TANK]")) return true;
  if (text.startsWith("Build mode is active.")) return true;
  if (text.startsWith("Continue: update the checklist")) return true;
  if (text.startsWith("Continue planning:")) return true;
  if (text === PLAN_CONTINUE_USER_MESSAGE) return true;
  return false;
}

function isNoiseTranscriptTurn(turn: Turn): boolean {
  if (turn.role === "user") return isSyntheticUserPrompt(turn.content);
  if (turn.role !== "assistant") return false;
  const c = turn.content.trim();
  return (
    c.startsWith("**Tank mode**") ||
    c.startsWith("**Build paused**") ||
    c.startsWith("**Stopped**") ||
    c.startsWith("**Paused**")
  );
}

/**
 * Rebuild provider messages for a long build: fresh system/plan + original goal
 * + a bounded live tail (tool chains kept intact).
 */
export function compactProviderMessages(
  messages: ChatMessage[],
  state: SessionState,
  tailMax = BUILD_LIVE_MESSAGE_TAIL,
): ChatMessage[] {
  const system: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(state),
  };
  const goal = sessionGoal(state);
  const goalMsg: ChatMessage | null = goal
    ? { role: "user", content: `Original goal:\n${goal}` }
    : null;

  const body = messages.filter((m) => {
    if (m.role === "system") return false;
    if (m.role === "user" && m.content.startsWith("Original goal:")) return false;
    return true;
  });
  const tail = takeSafeMessageTail(body, tailMax);
  return [system, ...(goalMsg ? [goalMsg] : []), ...tail];
}

/** Keep assistant→tool groups intact when slicing a live message list. */
export function takeSafeMessageTail(
  messages: ChatMessage[],
  max: number,
): ChatMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }
  const at = messages[start];
  if (
    at?.role === "assistant" &&
    at.tool_calls &&
    at.tool_calls.length > 0 &&
    start > 0
  ) {
    // already on the assistant that owns following tools — good
  } else if (start > 0 && messages[start - 1]?.role === "assistant") {
    const prev = messages[start - 1];
    if (
      prev &&
      prev.role === "assistant" &&
      prev.tool_calls &&
      prev.tool_calls.length > 0
    ) {
      start -= 1;
    }
  }
  return messages.slice(start);
}

/** Max transcript turns kept after the goal in building context. */
export const BUILD_CONTEXT_TAIL_TURNS = 10;
/** Max live provider messages kept after system+goal during a long build turn. */
export const BUILD_LIVE_MESSAGE_TAIL = 28;

export function bumpSessionSequence(state: SessionState): SessionState {
  return { ...state, sequence: state.sequence + 1 };
}

export function newSession(
  sessionId: string,
  mode: AgentMode = "plan",
): SessionState {
  return { ...createEmptySessionState(sessionId), mode };
}

export function parseToolCallsFromText(text: string): ToolCall[] {
  const match = text.match(/```tool\s+([\s\S]*?)```/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]!) as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    return [
      {
        id: randomUUID(),
        name: parsed.name,
        arguments: parsed.arguments ?? {},
        riskLevel: "safe",
      },
    ];
  } catch {
    return [];
  }
}

export function applyUpsertPlan(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const rawPhases = args.phases;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary: "upsert_plan requires a non-empty phases array.",
        error: "Invalid arguments",
      },
    };
  }

  const planning = productPhaseForState(state) === "planning";

  if (!planning) {
    return applyBuildPlanProgress(state, rawPhases, args, callId);
  }

  const phases: PlanPhase[] = rawPhases.map((raw, index) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const checklistRaw = Array.isArray(p.checklist) ? p.checklist : [];
    // Planning: structure only — no execution progress.
    return {
      id: typeof p.id === "string" && p.id ? p.id : randomUUID(),
      title:
        typeof p.title === "string" && p.title.trim()
          ? p.title.trim()
          : `Phase ${index + 1}`,
      status: "pending",
      checklist: checklistRaw.map((item, itemIndex) => {
        const c = (item ?? {}) as Record<string, unknown>;
        return {
          id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
          text:
            typeof c.text === "string" && c.text.trim()
              ? c.text.trim()
              : `Item ${itemIndex + 1}`,
          done: false,
        };
      }),
    };
  });

  const questions: PlanQuestion[] =
    args.questions === undefined
      ? state.planQuestions
      : Array.isArray(args.questions)
        ? args.questions.map((raw, index) =>
            mergePlanQuestionFromAgent(raw, index, state.planQuestions),
          )
        : [];

  const next: SessionState = {
    ...state,
    planPhases: phases,
    planQuestions: questions,
    planSteps: [],
    planStatus:
      state.planStatus === "finalized" || state.planStatus === "executing"
        ? "executing"
        : "drafting",
  };

  const openCount = questions.filter((q) => q.status === "open").length;
  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary: `Plan updated: ${phases.length} phase(s), ${openCount} open question(s).`,
      output: {
        planPhases: phases,
        planQuestions: questions,
        planStatus: next.planStatus,
      },
    },
  };
}

/**
 * Building: plan structure is frozen. Only checklist done flags and phase
 * status may change — no add/remove/rename of phases or checklist texts.
 */
function applyBuildPlanProgress(
  state: SessionState,
  rawPhases: unknown[],
  args: Record<string, unknown>,
  callId: string,
): { state: SessionState; result: ToolResult; callId: string } {
  const existing = state.planPhases;
  if (existing.length === 0) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary:
          "No plan to update in Build. Structure was fixed in planning — cannot create phases here.",
        error: "Empty plan",
      },
    };
  }

  // Questions are planning-only; ignore if echoed in build payloads.
  void args.questions;

  if (rawPhases.length !== existing.length) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary: `Build mode cannot add/remove phases (have ${existing.length}, got ${rawPhases.length}). Only mark checks done and update phase status.`,
        error: "Structure locked",
      },
    };
  }

  const incomingById = new Map<string, Record<string, unknown>>();
  for (const raw of rawPhases) {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (typeof p.id === "string" && p.id) incomingById.set(p.id, p);
  }

  const phases: PlanPhase[] = [];
  for (let index = 0; index < existing.length; index++) {
    const prev = existing[index]!;
    const rawMatch =
      incomingById.get(prev.id) ??
      ((rawPhases[index] ?? {}) as Record<string, unknown>);

    const incomingTitle =
      typeof rawMatch.title === "string" ? rawMatch.title.trim() : "";
    if (incomingTitle && incomingTitle !== prev.title) {
      return {
        callId,
        state,
        result: {
          callId,
          success: false,
          summary: `Build mode cannot rename phases ("${prev.title}" → "${incomingTitle}"). Only status/done.`,
          error: "Structure locked",
        },
      };
    }

    const checklistRaw = Array.isArray(rawMatch.checklist)
      ? rawMatch.checklist
      : null;
    if (!checklistRaw || checklistRaw.length !== prev.checklist.length) {
      return {
        callId,
        state,
        result: {
          callId,
          success: false,
          summary: `Build mode cannot add/remove checklist items on "${prev.title}" (have ${prev.checklist.length}, got ${checklistRaw?.length ?? 0}). Only check/uncheck.`,
          error: "Structure locked",
        },
      };
    }

    const itemById = new Map<string, Record<string, unknown>>();
    for (const item of checklistRaw) {
      const c = (item ?? {}) as Record<string, unknown>;
      if (typeof c.id === "string" && c.id) itemById.set(c.id, c);
    }

    const checklist = [];
    for (let itemIndex = 0; itemIndex < prev.checklist.length; itemIndex++) {
      const prevItem = prev.checklist[itemIndex]!;
      const incomingItem =
        itemById.get(prevItem.id) ??
        ((checklistRaw[itemIndex] ?? {}) as Record<string, unknown>);

      const incomingText =
        typeof incomingItem.text === "string" ? incomingItem.text.trim() : "";
      if (incomingText && incomingText !== prevItem.text) {
        return {
          callId,
          state,
          result: {
            callId,
            success: false,
            summary: `Build mode cannot edit checklist text ("${prevItem.text}"). Only done=true/false.`,
            error: "Structure locked",
          },
        };
      }

      checklist.push({
        id: prevItem.id,
        text: prevItem.text,
        done:
          typeof incomingItem.done === "boolean"
            ? incomingItem.done
            : prevItem.done,
      });
    }

    phases.push({
      id: prev.id,
      title: prev.title,
      status: normalizePhaseStatus(rawMatch.status, prev.status),
      checklist,
    });
  }

  const next: SessionState = {
    ...state,
    planPhases: phases,
    planSteps: [],
    planStatus: "executing",
  };

  const { done, total } = sharedPlanChecklistProgress(next);
  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary: `Progress updated: ${done}/${total} checklist · phase statuses synced.`,
      output: {
        planPhases: phases,
        planQuestions: next.planQuestions,
        planStatus: next.planStatus,
      },
    },
  };
}

const FEAT_PREFIX = "feat/";
const MAX_BRANCH_SLUG = 40;

/** Normalize to `feat/<kebab>` (short). Returns null if empty after cleanup. */
export function normalizeFeatBranchName(raw: string): string | null {
  let slug = raw.trim().toLowerCase();
  if (slug.startsWith(FEAT_PREFIX)) slug = slug.slice(FEAT_PREFIX.length);
  slug = slug
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SLUG)
    .replace(/-+$/g, "");
  if (!slug) return null;
  return `${FEAT_PREFIX}${slug}`;
}

export function applyProposePlanReady(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  if (state.planPhases.length === 0) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary: "Cannot propose readiness on an empty plan. Call upsert_plan first.",
        error: "Empty plan",
      },
    };
  }

  const openQuestions = state.planQuestions.filter((q) => q.status === "open");
  if (openQuestions.length > 0) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary: `Cannot propose readiness yet: ${openQuestions.length} open question(s) remain.`,
        error: "Open questions remain",
        output: { openQuestions },
      },
    };
  }

  const branchRaw =
    typeof args.suggestedBranch === "string" ? args.suggestedBranch : "";
  const suggestedBranch = normalizeFeatBranchName(branchRaw);
  if (!suggestedBranch) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary:
          "suggestedBranch is required (feat/kebab-case, e.g. feat/user-auth). Keep it short.",
        error: "Invalid branch name",
      },
    };
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim()
      ? args.summary.trim().slice(0, 500)
      : undefined;

  const proposal = {
    suggestedBranch,
    ...(summary ? { summary } : {}),
    proposedAt: new Date().toISOString(),
  };

  const next: SessionState = {
    ...state,
    planStatus: "finalized",
    planReadyProposal: proposal,
  };

  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary: `Plan marked ready for user confirmation. Suggested branch: ${suggestedBranch}. Wait — the user confirms in the IDE.`,
      output: {
        planReadyProposal: proposal,
        planStatus: next.planStatus,
        mode: next.mode,
      },
    },
  };
}

/** IDE-only: user confirmed → Build mode. */
export function applyStartBuilding(
  state: SessionState,
): { state: SessionState; error?: string } {
  if (state.planPhases.length === 0) {
    return { state, error: "Cannot start building with an empty plan." };
  }
  const openQuestions = state.planQuestions.filter((q) => q.status === "open");
  if (openQuestions.length > 0) {
    return {
      state,
      error: `Cannot start building: ${openQuestions.length} open question(s) remain.`,
    };
  }
  if (!state.planReadyProposal) {
    return {
      state,
      error: "Agent has not proposed plan readiness yet.",
    };
  }

  const phases = state.planPhases.map((phase, index) => ({
    ...phase,
    status:
      index === 0
        ? ("in_progress" as const)
        : phase.status === "completed"
          ? phase.status
          : ("pending" as const),
  }));

  return {
    state: {
      ...state,
      mode: "agent",
      planStatus: "executing",
      planPhases: phases,
      planReadyProposal: null,
    },
  };
}

/** @deprecated Prefer propose_plan_ready + applyStartBuilding. */
export function applyFinalizePlan(
  state: SessionState,
  args: Record<string, unknown>,
  _opts?: { userMessage?: string },
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  return {
    callId,
    state,
    result: {
      callId,
      success: false,
      summary:
        "finalize_plan is retired. Call propose_plan_ready so the user can confirm in the IDE.",
      error: "Use propose_plan_ready",
      output: { confirmed: args.confirmed },
    },
  };
}

function normalizePhaseStatus(
  value: unknown,
  fallback: PlanPhase["status"] | boolean = "pending",
): PlanPhase["status"] {
  const allowed = new Set([
    "pending",
    "in_progress",
    "completed",
    "skipped",
    "failed",
  ]);
  if (typeof value === "string" && allowed.has(value)) {
    return value as PlanPhase["status"];
  }
  if (typeof fallback === "boolean") {
    return fallback ? "in_progress" : "pending";
  }
  return fallback;
}

function parsePlanQuestion(raw: unknown, index: number): PlanQuestion {
  const q = (raw ?? {}) as Record<string, unknown>;
  const status =
    q.status === "answered" || q.status === "open" ? q.status : "open";
  const selection = q.selection === "multiple" ? "multiple" : "single";
  const optionsRaw = Array.isArray(q.options) ? q.options : [];
  const options = optionsRaw
    .map((item, optionIndex) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const label =
        typeof o.label === "string" && o.label.trim()
          ? o.label.trim()
          : typeof o.text === "string" && o.text.trim()
            ? o.text.trim()
            : "";
      if (!label) return null;
      return {
        id:
          typeof o.id === "string" && o.id
            ? o.id
            : `opt-${index + 1}-${optionIndex + 1}`,
        label,
      };
    })
    .filter((o): o is { id: string; label: string } => o !== null)
    .slice(0, 26);

  const selectedOptionIds = Array.isArray(q.selectedOptionIds)
    ? q.selectedOptionIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : undefined;

  return {
    id: typeof q.id === "string" && q.id ? q.id : randomUUID(),
    text:
      typeof q.text === "string" && q.text.trim()
        ? q.text.trim()
        : `Question ${index + 1}`,
    status,
    selection,
    options,
    ...(typeof q.answer === "string" && q.answer.trim()
      ? { answer: q.answer.trim() }
      : {}),
    ...(selectedOptionIds && selectedOptionIds.length > 0
      ? { selectedOptionIds }
      : {}),
  };
}

function findPreviousQuestion(
  previous: PlanQuestion[],
  parsed: PlanQuestion,
): PlanQuestion | undefined {
  return (
    previous.find((p) => p.id === parsed.id) ??
    previous.find(
      (p) =>
        p.status === "answered" &&
        p.text.trim().toLowerCase() === parsed.text.trim().toLowerCase(),
    )
  );
}

/**
 * Agent may propose questions/options, but must not invent answers.
 * Only preserve answered state that already exists from the user/dialog.
 */
export function mergePlanQuestionFromAgent(
  raw: unknown,
  index: number,
  previous: PlanQuestion[],
): PlanQuestion {
  const parsed = parsePlanQuestion(raw, index);
  const prev = findPreviousQuestion(previous, parsed);

  if (prev?.status === "answered" && prev.answer?.trim()) {
    return {
      id: prev.id,
      text: parsed.text,
      selection: parsed.selection,
      options: parsed.options.length > 0 ? parsed.options : prev.options,
      status: "answered",
      answer: prev.answer,
      ...(prev.selectedOptionIds?.length
        ? { selectedOptionIds: prev.selectedOptionIds }
        : {}),
    };
  }

  return {
    id: prev?.id ?? parsed.id,
    text: parsed.text,
    selection: parsed.selection,
    options: parsed.options,
    status: "open",
  };
}

/** Best-effort parse of incomplete JSON while tool arguments stream in. */
export function tryParsePartialJson(input: string): unknown | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* try to close open structures */
  }

  let candidate = trimmed.replace(/,\s*$/, "");
  let inString = false;
  let escape = false;
  const stack: Array<"{" | "["> = [];

  for (const ch of candidate) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    if (ch === "}" || ch === "]") stack.pop();
  }

  if (inString) candidate += '"';
  candidate = candidate.replace(/,\s*$/, "");
  // Drop a trailing incomplete key like `"foo":` or `"foo"`
  candidate = candidate.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  candidate = candidate.replace(/,?\s*"[^"]*"\s*$/, "");
  candidate = candidate.replace(/:\s*$/, ": null");
  candidate = candidate.replace(/,\s*$/, "");

  while (stack.length > 0) {
    const open = stack.pop();
    candidate += open === "{" ? "}" : "]";
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export type PlanAnswerInput = {
  questionId: string;
  answer: string;
  selectedOptionIds?: string[] | undefined;
};

/** Ensure persisted / partial plan questions have selection + options arrays. */
export function normalizePlanQuestions(
  questions: PlanQuestion[] | undefined | null,
): PlanQuestion[] {
  if (!questions?.length) return [];
  return questions.map((q, index) => parsePlanQuestion(q, index));
}

/** Apply structured Q&A dialog answers onto planQuestions. */
export function applyPlanAnswers(
  state: SessionState,
  answers: PlanAnswerInput[],
): SessionState {
  if (answers.length === 0) return state;
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const planQuestions = normalizePlanQuestions(state.planQuestions).map((q) => {
    const hit = byId.get(q.id);
    if (!hit) return q;
    const answer = hit.answer.trim();
    if (!answer) return q;
    return {
      ...q,
      status: "answered" as const,
      answer,
      ...(hit.selectedOptionIds && hit.selectedOptionIds.length > 0
        ? { selectedOptionIds: hit.selectedOptionIds }
        : {}),
    };
  });
  return { ...state, planQuestions };
}

export function isPlanMutationTool(name: string): boolean {
  return (
    name === "upsert_plan" ||
    name === "propose_plan_ready" ||
    name === "finalize_plan"
  );
}

export type PlanMutationPatch = {
  planPhases: PlanPhase[];
  planQuestions: PlanQuestion[];
  planStatus: PlanStatus;
  mode: AgentMode;
  planReadyProposal: SessionState["planReadyProposal"];
};

export function productPhaseForState(
  state: Pick<SessionState, "mode" | "planStatus" | "sessionKind">,
): "planning" | "building" {
  void state.sessionKind;
  if (state.mode === "plan" || state.planStatus === "drafting") return "planning";
  return "building";
}

/** True when build plan still has unfinished checklist items or open phases. */
export function planHasOpenWork(
  state: Pick<SessionState, "planPhases">,
): boolean {
  return sharedPlanHasOpenWork(state);
}

export function planChecklistProgress(
  state: Pick<SessionState, "planPhases">,
): { done: number; total: number } {
  return sharedPlanChecklistProgress(state);
}

/** Open Plan Q&A items waiting on the user. */
export function hasOpenPlanQuestions(
  state: Pick<SessionState, "planQuestions">,
): boolean {
  return state.planQuestions.some((q) => q.status === "open");
}

/**
 * Keep the agent loop running without user input:
 * - building: until checklist/phases are complete
 * - planning (mode=plan): until propose_plan_ready (Start Build) or open questions await the user
 */
export function isAgentTankMode(state: SessionState): boolean {
  const phase = productPhaseForState(state);
  if (phase === "building") {
    return sharedPlanHasOpenWork(state);
  }
  // Only the Plan workflow tanks — not casual ask/autonomous with drafting status.
  if (phase === "planning" && state.mode === "plan") {
    if (state.planReadyProposal) return false;
    if (hasOpenPlanQuestions(state)) return false;
    return true;
  }
  return false;
}

export const CHECKLIST_CONTINUE_NUDGE = [
  "[IDE · TANK] Checklist still incomplete — do not stop.",
  "Plan structure is locked: upsert_plan may only flip checklist done and phase status (no add/remove/rename).",
  "Immediately with tools:",
  "1) upsert_plan: mark finished items done=true; update phase status.",
  "2) Execute the next open checklist item (write_file / run_command / …).",
  "Prefer tools over narration. Keep going until the checklist is fully done.",
].join("\n");

export const PLAN_CONTINUE_NUDGE = [
  "[IDE · TANK] Planning is not finished — do not stop on narration.",
  "Immediately with tools:",
  "1) upsert_plan with concrete phases + checklist item texts (draft outline).",
  "2) If anything is unclear, add open questions with selection + options (Plan Q&A UI).",
  "3) When the plan is solid and questions are cleared, call propose_plan_ready.",
  "Do not only explore/list files. Produce plan structure or questions now.",
].join("\n");

export { CHECKLIST_CONTINUE_USER_MESSAGE, PLAN_CONTINUE_USER_MESSAGE };

