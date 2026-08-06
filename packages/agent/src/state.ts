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
  TESTING_READY_CONTINUE_USER_MESSAGE,
  planBuildComplete,
  isTestGateSyntheticPrompt,
  formatTestGateForBuildPrompt,
  formatTestGateEscalationSystemRules,
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
    return "Current plan: (empty — use add_phase / set_questions, or upsert_plan for a full draft).";
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
        "When the codebase index is ready (see CODEBASE INDEX in the system prompt): MUST use search_graph / search_code / get_architecture / get_code_snippet / trace_path for discovery — not repeated list_dir.",
        "When the index is not ready, use list_dir / read_file / search_text. Never use shell cat/ls/find to browse the repo.",
        "read_file is windowed (startLine/maxLines). If truncated, continue with nextStartLine — do not expect whole large files in one call.",
      ]
    : [
        "No workspace is open yet. Ask the user to open a project folder before reading files.",
      ];

  const architectureProfile = (() => {
    if (!root) return null;
    try {
      return new ArchitectureStore(root).loadOrDetect();
    } catch {
      return null;
    }
  })();

  const architectureBlock = architectureProfile
    ? formatArchitectureForPrompt(architectureProfile.profile, {
        intent: architectureProfile.intent,
        drift: architectureProfile.drift,
        fromFile: architectureProfile.fromFile,
      })
    : formatArchitectureForPrompt(null);

  const testGateBlock = formatTestGateForBuildPrompt(
    architectureProfile?.profile ?? null,
  );
  const escalationBlock = formatTestGateEscalationSystemRules(
    state.testGateEscalationLevel ?? 0,
  );

  const planningRules = [
    "PHASE: PLANNING — the plan is being created (not executed).",
    "Available tools: when indexed — search_graph / search_code / get_architecture / get_code_snippet / trace_path (primary), plus list_dir/read_file/search_text (fallback), plus read_architecture, upsert_architecture, read_plan, add_phase, replace_phase, delete_phase, add_check, replace_check, delete_check, set_questions, upsert_plan (full rewrite), propose_plan_ready.",
    "Unavailable: write_file, git_*, run_command, terminal_*, checkpoint_restore.",
    "IMPORTANT: Never tell the user you cannot run shell commands. Commands run only after Start Build. When the user asks to run npm/git/shell now, call propose_plan_ready so the IDE can switch to Build — then you will get run_command / terminal_*.",
    "",
    architectureBlock,
    "",
    "Stack & dependencies:",
    "- Call read_architecture early for detected stack + ARCHITECTURE.md intent/overrides.",
    "- When indexed: search_graph / get_architecture first; do not explore with a chain of list_dir.",
    "- Declare languages, frameworks, and packages in the plan (phases/checklist + clarifying questions). Do not invent a parallel Architecture chat.",
    "- Do NOT install packages in planning. Installs happen in DEVELOPMENT via run_command / terminal_* after the user starts build.",
    "- Use upsert_architecture only for sparse intent/overrides when detection is wrong — never dump the whole stack into the file.",
    "",
    "Plan structure (prefer micro CRUD — ids preferred, index fallback):",
    "- read_plan to inspect the current plan.",
    "- add_phase / replace_phase / delete_phase for phases; add_check / replace_check / delete_check for checklist items.",
    "- Prefer small edits over rewriting the whole plan. Use upsert_plan only for a full rewrite when starting from empty or replacing everything.",
    "- Do NOT mark checklist items done. Do NOT set phase status to completed/failed/skipped. Progress marking starts only after development begins.",
    "- Checklist items are a draft outline of work, not a live todo board.",
    "- Checklist granularity: keep items ATOMIC but practical — one coherent unit of work (e.g. one component + its styles, or one module + tests). Too coarse (\"build the whole app\") is bad; too fine (\"create file 1…40\" / one check per tiny file) is also bad. Aim for checks the agent can finish in a few tool calls, not dozens of micro-files for one check.",
    "- When the stack has a test runner, include checklist items to author the matching test files (execution happens later in the IDE Test gate, not during planning).",
    "- Implementation shape (for the plan): prefer many small source modules (~500–700 characters each where practical). Plan for componentization/splitting instead of monolithic files. Exempt lockfiles, generated assets, and dense config that cannot sensibly split.",
    "",
    "Clarifying questions (critical — dedicated Plan Q&A dialog; USER answers there, never you):",
    "- ALWAYS put open questions via set_questions (or upsert_plan.questions). NEVER ask multiple-choice / A-B-C questions only in chat prose — the Plan Q&A UI will not open.",
    "- EVERY question MUST include selection: \"single\" OR \"multiple\", plus 2–8 concrete options[{id,label}].",
    "- Leave status=\"open\". Do NOT invent answers. Do NOT re-ask in prose after set_questions.",
    "- Prefer 1–3 open questions per turn. If the user already answered or said to skip and just run something, clear with set_questions({questions:[]}) and proceed.",
    "- Chat may briefly say that the Plan Q&A dialog is open — do not paste the options as a numbered list in the message.",
    "",
    "Turn discipline (critical):",
    "1) First broad request: when indexed, search_graph (or get_architecture) on the user's terms — NOT a list_dir tour — then add_phase (or upsert_plan once) with draft phases + checklist + set_questions if needed. Do NOT dump a full analysis essay.",
    "2) After user answers (or says to proceed / only run a command): reshape with micro CRUD; if they want execution now, call propose_plan_ready.",
    "3) Never implement, rewrite files, or pretend development has started.",
    "4) When the user explicitly wants to run shell/npm/git (e.g. \"npm init\", \"install\", \"just initialize\"): keep a minimal plan focused on that, set_questions({questions:[]}), then call propose_plan_ready immediately. Do not keep interviewing.",
    "5) Otherwise, when the plan is solid AND all open questions are answered, call propose_plan_ready with a short suggestedBranch (feat/kebab-case). The IDE opens Start Build for USER confirmation — do NOT start building yourself.",
    "6) Do NOT call propose_plan_ready while open questions remain.",
    "TANK MODE (planning): until propose_plan_ready is accepted by the user (Start Build), you must keep using tools — plan CRUD / set_questions. NEVER stop on exploration-only narration. Brief graph explore → plan tools. The IDE re-prompts until the plan is ready or open questions await the user.",
    formatPlanForPrompt(state),
  ];

  const buildRules = [
    "PHASE: DEVELOPMENT — now you may mark checklist progress and run commands.",
    architectureBlock,
    testGateBlock,
    ...(escalationBlock ? [escalationBlock] : []),
    "The plan structure was agreed in planning. Implement it phase by phase using tools (including write/git/commands/terminals).",
    "On the first build turn after Start Build: take action immediately — run tools for the first incomplete checklist item. Do not only acknowledge Build mode.",
    "Code reading (critical — do not use the shell as a file browser):",
    "- When indexed: search_graph → get_code_snippet / trace_path / search_code first. Do not discover files via repeated list_dir.",
    "- For a known path (from graph or user): use read_file / list_dir / search_text. NEVER run cat/ls/head/find via run_command to inspect source — those commands are blocked.",
    "- Large files: read_file returns a line window (default ~250 lines). If truncated=true, call again with startLine=nextStartLine. Do not try to load the whole file in one call.",
    "- Do not invent qualified_name values — take them from search_graph / search_code results.",
    "When the user asks to run a command: DO IT with tools — prefer a persistent terminal for Node/npm/pnpm workflows.",
    "Never claim you cannot execute shell commands in this phase — you can (installs, builds, dev servers, git). Verification suites (lint/typecheck/unit) are IDE-owned after the checklist — do not run them yourself.",
    "Shell / terminal workflow (critical — keep one solid session):",
    "- Prefer terminal_open → terminal_write → terminal_read for ANY multi-step shell work (nvm, npm/pnpm install, next/dev servers, git sequences).",
    "- Open ONE terminal per task stream and reuse its terminalId. Do NOT open a new terminal for every command. Do NOT re-run nvm use before every line once the session is active.",
    "- The IDE bootstraps nvm/fnm + .nvmrc/.node-version when a terminal opens and enriches PATH. After open, wait briefly / terminal_read until you see the node version banner if present, then run your commands.",
    "- run_command is for short one-shots only (also auto-loads nvm/.nvmrc in that same process). Env still does NOT carry to the next run_command — for sequences, use terminal_*.",
    "- Interactive / long-running: terminal_open → terminal_write (user gets 3s confirm/edit) → terminal_read. Choices: terminal_ask.",
    "Install packages when the plan calls for them (never during planning).",
    "Shell hygiene:",
    "- run_command / terminal_* are for install/build/dev-server/git workflows — not for reading files, listing trees, or running the IDE Test gate suites.",
    "- Never recursively list node_modules, .git, dist, or build output.",
    "- Command stdout is auto-filtered (noise dirs stripped + size-capped); still avoid generating that noise.",
    "- Host shell (not a container): cwd=workspace. Prefer project pins (.nvmrc, engines) over guessing Node versions.",
    "Code size (critical):",
    "- Keep hand-written source files short: target ~500–700 characters max per file when practical. If a file would grow larger, split/componentize (extract hooks, subcomponents, helpers, styles) instead of growing one blob.",
    "- Do NOT explode a single checklist item into dozens of tiny files (30–40 files for one check is wrong). Balance: small modules, atomic checks that still group related work.",
    "- Exempt: lockfiles, large generated/vendor assets, and configs that cannot sensibly split.",
    "Checklist progress (critical — structure is locked):",
    "- The plan phases/checklist texts are frozen from planning. Do NOT add, remove, or rename phases or checklist items. Do NOT change questions.",
    "- upsert_plan may ONLY set checklist done=true (never uncheck) and update phase status (pending|in_progress|completed|skipped|failed).",
    "- Always pass the full phases array with the same ids/titles/texts; change only done and status.",
    "- Prefer focusing on Focus → Next open item, then mark it done. If you genuinely finished several checklist items in the same round, you MAY flip multiple done=true in one upsert_plan (keep prior done items true).",
    "- RESUME / same chat: items already marked [x] / done=true are authoritative progress. Do NOT reset them or redo the whole plan from scratch. Continue from Focus → Next open item. You may briefly verify a done item still holds; if something is wrong, fix the code — leave the check done=true.",
    "- After the checklist is fully done, call propose_testing_ready (do not only narrate). The IDE then runs the Test gate before offering commit. If it fails: get_test_report (counts/platform per suite) → list_failed_tests → read_test_log only if needed. Do not invent a parallel test phase unless the plan already required it.",
    "- Update phase status (in_progress / completed) as work moves forward. Do not reopen completed phases without cause.",
    "Keep the plan truthful: only mark items done when the work is actually done (including required test files written, not executed).",
    "TANK MODE: while any checklist item is open, NEVER stop with prose only — keep calling tools (upsert_plan progress + implementation) until every item is done=true and phases are completed. The IDE will keep re-prompting forever until the checklist is complete (or the user hits Stop). No waiting for the user.",
    "When ALL checklist items are done and phases are completed, call propose_testing_ready so the IDE can run the Test gate. Do not launch lint/test yourself.",
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
  // Escalated test-fix: keep a longer tail so prior digests survive compaction.
  const goal = sessionGoal(state);
  const history = state.turns.filter(
    (t) =>
      (t.role === "user" || t.role === "assistant") &&
      !isNoiseTranscriptTurn(t),
  );
  const tailMax =
    (state.testGateEscalationLevel ?? 0) > 0
      ? BUILD_CONTEXT_TAIL_TURNS + 8
      : BUILD_CONTEXT_TAIL_TURNS;
  const pinnedDigests = history.filter(
    (t) => t.role === "user" && isTestGateSyntheticPrompt(t.content),
  );
  const recentDigests = pinnedDigests.slice(-2);
  const tail = history.slice(-tailMax);
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
  for (const dig of recentDigests) {
    if (!tail.some((t) => t.id === dig.id)) {
      turns.push(dig);
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
  if (text === TESTING_READY_CONTINUE_USER_MESSAGE) return true;
  if (text.startsWith("Testing phase:")) return true;
  if (isTestGateSyntheticPrompt(text)) return true;
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

  const next: SessionState = clearPlanReady({
    ...state,
    planPhases: phases,
    planQuestions: questions,
    planSteps: [],
    planStatus: "drafting",
  });

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

function clearPlanReady(state: SessionState): SessionState {
  if (!state.planReadyProposal && state.planStatus === "drafting") return state;
  return {
    ...state,
    planReadyProposal: null,
    planStatus:
      state.planStatus === "executing" ? "executing" : "drafting",
  };
}

function planningOnlyGuard(
  state: SessionState,
  callId: string,
  toolName: string,
): { state: SessionState; result: ToolResult; callId: string } | null {
  if (productPhaseForState(state) === "planning") return null;
  return {
    callId,
    state,
    result: {
      callId,
      success: false,
      summary: `${toolName} is only available while planning. Use upsert_plan to mark checklist progress during build.`,
      error: "Wrong phase",
    },
  };
}

function resolvePhaseIndex(
  phases: PlanPhase[],
  id?: unknown,
  index?: unknown,
): { index: number; error?: string } {
  if (typeof id === "string" && id.trim()) {
    const i = phases.findIndex((p) => p.id === id.trim());
    if (i >= 0) return { index: i };
    return { index: -1, error: `No phase with id "${id.trim()}".` };
  }
  if (typeof index === "number" && Number.isInteger(index)) {
    if (index >= 0 && index < phases.length) return { index };
    return {
      index: -1,
      error: `phaseIndex ${index} out of range (0..${Math.max(0, phases.length - 1)}).`,
    };
  }
  return {
    index: -1,
    error: "Provide phaseId or phaseIndex.",
  };
}

function resolveCheckIndex(
  checklist: PlanPhase["checklist"],
  id?: unknown,
  index?: unknown,
): { index: number; error?: string } {
  if (typeof id === "string" && id.trim()) {
    const i = checklist.findIndex((c) => c.id === id.trim());
    if (i >= 0) return { index: i };
    return { index: -1, error: `No checklist item with id "${id.trim()}".` };
  }
  if (typeof index === "number" && Number.isInteger(index)) {
    if (index >= 0 && index < checklist.length) return { index };
    return {
      index: -1,
      error: `checkIndex ${index} out of range (0..${Math.max(0, checklist.length - 1)}).`,
    };
  }
  return {
    index: -1,
    error: "Provide checkId or checkIndex.",
  };
}

function insertAfterIndex(
  length: number,
  afterId: unknown,
  afterIndex: unknown,
  findId: (id: string) => number,
): { at: number; error?: string } {
  if (typeof afterId === "string" && afterId.trim()) {
    const i = findId(afterId.trim());
    if (i < 0) return { at: -1, error: `after* id "${afterId.trim()}" not found.` };
    return { at: i + 1 };
  }
  if (typeof afterIndex === "number" && Number.isInteger(afterIndex)) {
    if (afterIndex < -1 || afterIndex >= length) {
      return {
        at: -1,
        error: `after* index ${afterIndex} out of range.`,
      };
    }
    return { at: afterIndex + 1 };
  }
  return { at: length };
}

function checklistFromTexts(raw: unknown): PlanPhase["checklist"] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, itemIndex) => {
    if (typeof item === "string") {
      return {
        id: randomUUID(),
        text: item.trim() || `Item ${itemIndex + 1}`,
        done: false,
      };
    }
    const c = (item ?? {}) as Record<string, unknown>;
    return {
      id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
      text:
        typeof c.text === "string" && c.text.trim()
          ? c.text.trim()
          : `Item ${itemIndex + 1}`,
      done: false,
    };
  });
}

function planMutationOk(
  callId: string,
  state: SessionState,
  summary: string,
): { state: SessionState; result: ToolResult; callId: string } {
  const next = clearPlanReady(state);
  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary,
      output: {
        planPhases: next.planPhases,
        planQuestions: next.planQuestions,
        planStatus: next.planStatus,
        planReadyProposal: next.planReadyProposal,
      },
    },
  };
}

function planMutationFail(
  callId: string,
  state: SessionState,
  summary: string,
): { state: SessionState; result: ToolResult; callId: string } {
  return {
    callId,
    state,
    result: {
      callId,
      success: false,
      summary,
      error: "Invalid arguments",
    },
  };
}

export function applyReadPlan(
  state: SessionState,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  return {
    callId,
    state,
    result: {
      callId,
      success: true,
      summary: `Plan: ${state.planPhases.length} phase(s), ${state.planQuestions.filter((q) => q.status === "open").length} open question(s), status=${state.planStatus}.`,
      output: {
        planPhases: state.planPhases,
        planQuestions: state.planQuestions,
        planStatus: state.planStatus,
        planReadyProposal: state.planReadyProposal,
      },
    },
  };
}

export function applyAddPhase(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "add_phase");
  if (blocked) return blocked;
  const title =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim()
      : "";
  if (!title) return planMutationFail(callId, state, "add_phase requires title.");
  const insert = insertAfterIndex(
    state.planPhases.length,
    args.afterPhaseId,
    args.afterPhaseIndex,
    (id) => state.planPhases.findIndex((p) => p.id === id),
  );
  if (insert.error) return planMutationFail(callId, state, insert.error);
  const phase: PlanPhase = {
    id: randomUUID(),
    title,
    status: "pending",
    checklist: checklistFromTexts(args.checklist),
  };
  const phases = [...state.planPhases];
  phases.splice(insert.at, 0, phase);
  return planMutationOk(callId, { ...state, planPhases: phases, planSteps: [] }, `Added phase "${title}".`);
}

export function applyReplacePhase(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "replace_phase");
  if (blocked) return blocked;
  const resolved = resolvePhaseIndex(
    state.planPhases,
    args.phaseId ?? args.id,
    args.phaseIndex,
  );
  if (resolved.error) return planMutationFail(callId, state, resolved.error);
  const prev = state.planPhases[resolved.index]!;
  const title =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim()
      : prev.title;
  const checklist =
    args.checklist === undefined
      ? prev.checklist
      : checklistFromTexts(args.checklist).map((c, i) => {
          const old = prev.checklist[i];
          return old && old.text === c.text ? { ...c, id: old.id } : c;
        });
  const phases = state.planPhases.map((p, i) =>
    i === resolved.index
      ? { ...p, title, checklist, status: "pending" as const }
      : p,
  );
  return planMutationOk(
    callId,
    { ...state, planPhases: phases, planSteps: [] },
    `Replaced phase "${title}".`,
  );
}

export function applyDeletePhase(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "delete_phase");
  if (blocked) return blocked;
  const resolved = resolvePhaseIndex(
    state.planPhases,
    args.phaseId ?? args.id,
    args.phaseIndex,
  );
  if (resolved.error) return planMutationFail(callId, state, resolved.error);
  const removed = state.planPhases[resolved.index]!;
  const phases = state.planPhases.filter((_, i) => i !== resolved.index);
  return planMutationOk(
    callId,
    { ...state, planPhases: phases, planSteps: [] },
    `Deleted phase "${removed.title}".`,
  );
}

export function applyAddCheck(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "add_check");
  if (blocked) return blocked;
  const resolved = resolvePhaseIndex(
    state.planPhases,
    args.phaseId,
    args.phaseIndex,
  );
  if (resolved.error) return planMutationFail(callId, state, resolved.error);
  const text =
    typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
  if (!text) return planMutationFail(callId, state, "add_check requires text.");
  const phase = state.planPhases[resolved.index]!;
  const insert = insertAfterIndex(
    phase.checklist.length,
    args.afterCheckId,
    args.afterCheckIndex,
    (id) => phase.checklist.findIndex((c) => c.id === id),
  );
  if (insert.error) return planMutationFail(callId, state, insert.error);
  const item = { id: randomUUID(), text, done: false };
  const checklist = [...phase.checklist];
  checklist.splice(insert.at, 0, item);
  const phases = state.planPhases.map((p, i) =>
    i === resolved.index ? { ...p, checklist } : p,
  );
  return planMutationOk(
    callId,
    { ...state, planPhases: phases, planSteps: [] },
    `Added checklist item to "${phase.title}".`,
  );
}

export function applyReplaceCheck(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "replace_check");
  if (blocked) return blocked;
  const phaseRes = resolvePhaseIndex(
    state.planPhases,
    args.phaseId,
    args.phaseIndex,
  );
  if (phaseRes.error) return planMutationFail(callId, state, phaseRes.error);
  const phase = state.planPhases[phaseRes.index]!;
  const checkRes = resolveCheckIndex(
    phase.checklist,
    args.checkId ?? args.id,
    args.checkIndex,
  );
  if (checkRes.error) return planMutationFail(callId, state, checkRes.error);
  const text =
    typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
  if (!text) return planMutationFail(callId, state, "replace_check requires text.");
  const checklist = phase.checklist.map((c, i) =>
    i === checkRes.index ? { ...c, text, done: false } : c,
  );
  const phases = state.planPhases.map((p, i) =>
    i === phaseRes.index ? { ...p, checklist } : p,
  );
  return planMutationOk(
    callId,
    { ...state, planPhases: phases, planSteps: [] },
    `Replaced checklist item in "${phase.title}".`,
  );
}

export function applyDeleteCheck(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "delete_check");
  if (blocked) return blocked;
  const phaseRes = resolvePhaseIndex(
    state.planPhases,
    args.phaseId,
    args.phaseIndex,
  );
  if (phaseRes.error) return planMutationFail(callId, state, phaseRes.error);
  const phase = state.planPhases[phaseRes.index]!;
  const checkRes = resolveCheckIndex(
    phase.checklist,
    args.checkId ?? args.id,
    args.checkIndex,
  );
  if (checkRes.error) return planMutationFail(callId, state, checkRes.error);
  const checklist = phase.checklist.filter((_, i) => i !== checkRes.index);
  const phases = state.planPhases.map((p, i) =>
    i === phaseRes.index ? { ...p, checklist } : p,
  );
  return planMutationOk(
    callId,
    { ...state, planPhases: phases, planSteps: [] },
    `Deleted checklist item from "${phase.title}".`,
  );
}

export function applySetQuestions(
  state: SessionState,
  args: Record<string, unknown>,
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  const blocked = planningOnlyGuard(state, callId, "set_questions");
  if (blocked) return blocked;
  if (!Array.isArray(args.questions)) {
    return planMutationFail(
      callId,
      state,
      "set_questions requires a questions array (use [] to clear).",
    );
  }
  const questions = args.questions.map((raw, index) =>
    mergePlanQuestionFromAgent(raw, index, state.planQuestions),
  );
  const openCount = questions.filter((q) => q.status === "open").length;
  return planMutationOk(
    callId,
    { ...state, planQuestions: questions },
    `Questions updated: ${questions.length} total, ${openCount} open.`,
  );
}

/** Dispatch plan tools used by the agent loop. */
export function applyPlanTool(
  name: string,
  state: SessionState,
  args: Record<string, unknown>,
  opts?: { userMessage?: string },
): { state: SessionState; result: ToolResult; callId: string } {
  switch (name) {
    case "read_plan":
      return applyReadPlan(state);
    case "add_phase":
      return applyAddPhase(state, args);
    case "replace_phase":
      return applyReplacePhase(state, args);
    case "delete_phase":
      return applyDeletePhase(state, args);
    case "add_check":
      return applyAddCheck(state, args);
    case "replace_check":
      return applyReplaceCheck(state, args);
    case "delete_check":
      return applyDeleteCheck(state, args);
    case "set_questions":
      return applySetQuestions(state, args);
    case "propose_plan_ready":
      return applyProposePlanReady(state, args);
    case "propose_testing_ready":
      return applyProposeTestingReady(state, args);
    case "finalize_plan":
      return applyFinalizePlan(state, args, {
        userMessage: opts?.userMessage ?? "",
      });
    case "upsert_plan":
    default:
      return applyUpsertPlan(state, args);
  }
}

/**
 * Building: plan structure is frozen. Only checklist done flags (monotonic:
 * false→true only) and phase status may change — no add/remove/rename of
 * phases or checklist texts, and no unchecking already-done items.
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

      if (prevItem.done && incomingItem.done === false) {
        return {
          callId,
          state,
          result: {
            callId,
            success: false,
            summary: `Cannot uncheck "${prevItem.text}" — already marked done. Keep done=true; resume from the next open item (spot-check only if unsure).`,
            error: "Progress locked",
          },
        };
      }

      checklist.push({
        id: prevItem.id,
        text: prevItem.text,
        // Sticky progress: done=true cannot be cleared in build.
        done: prevItem.done
          ? true
          : typeof incomingItem.done === "boolean"
            ? incomingItem.done
            : false,
      });
    }

    phases.push({
      id: prev.id,
      title: prev.title,
      status: normalizePhaseStatus(rawMatch.status, prev.status),
      checklist,
    });
  }

  // Count newly completed items (batch allowed — prefer one-at-a-time as guidance only).
  const newlyDone: string[] = [];
  for (let pi = 0; pi < existing.length; pi++) {
    const prevPhase = existing[pi]!;
    const nextPhase = phases[pi]!;
    for (let ci = 0; ci < prevPhase.checklist.length; ci++) {
      const before = prevPhase.checklist[ci]!;
      const after = nextPhase.checklist[ci]!;
      if (!before.done && after.done) {
        newlyDone.push(`${prevPhase.title} → ${after.text}`);
      }
    }
  }

  const next: SessionState = {
    ...state,
    planPhases: phases,
    planSteps: [],
    planStatus: "executing",
  };

  const { done, total } = sharedPlanChecklistProgress(next);
  const open = Math.max(0, total - done);
  const summary =
    newlyDone.length === 0
      ? `Phase statuses synced. Checklist ${done}/${total} done (${open} open).`
      : newlyDone.length === 1
        ? `Marked done: ${newlyDone[0]}. Checklist ${done}/${total} done (${open} open).`
        : `Marked ${newlyDone.length} items done. Checklist ${done}/${total} done (${open} open).`;
  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary,
      output: {
        planPhases: phases,
        planQuestions: next.planQuestions,
        planStatus: next.planStatus,
        done,
        total,
        newlyDone,
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

/**
 * Agent confirms the build is ready for the IDE Test gate.
 * Allowed only when the checklist is complete.
 */
export function applyProposeTestingReady(
  state: SessionState,
  args: Record<string, unknown> = {},
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  if (state.mode === "plan" || state.planStatus === "drafting") {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary:
          "propose_testing_ready is only available during Build after the checklist is done.",
        error: "Wrong phase",
      },
    };
  }
  if (!planBuildComplete(state)) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary:
          "Cannot propose testing ready: checklist still has open work. Finish all items first.",
        error: "Checklist incomplete",
      },
    };
  }
  if (state.buildCommitOffer || state.buildIntegrateOffer) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary: "Commit/integrate is already offered — testing confirm is not needed.",
        error: "Already past testing",
      },
    };
  }

  const note =
    typeof args.summary === "string" && args.summary.trim()
      ? args.summary.trim().slice(0, 500)
      : undefined;
  const confirmedAt = new Date().toISOString();
  const next: SessionState = {
    ...state,
    testingConfirmedAt: confirmedAt,
  };

  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary: note
        ? `Testing confirmed. IDE will run the Test gate next. ${note}`
        : "Testing confirmed. IDE will run the Test gate next.",
      output: {
        testingConfirmedAt: confirmedAt,
        ...(note ? { summary: note } : {}),
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
      testRun: null,
      testingConfirmedAt: null,
      testGatePassedAt: null,
      testGateAutoFixAttempts: 0,
      testGateCircuitOpen: false,
      testGateFailureFingerprint: null,
      testGateSameFailureStreak: 0,
      testGateEscalationLevel: 0,
      testGateRecentSuiteKeys: [],
      buildCommitOffer: null,
      buildIntegrateOffer: null,
      // buildBaseBranch is set by SessionManager.confirmPlan
    },
  };
}

/** User rejected Start Build — clear readiness so they can revise via chat. */
export function applyRejectPlanReady(state: SessionState): SessionState {
  if (!state.planReadyProposal && state.planStatus === "drafting") {
    return state;
  }
  return {
    ...state,
    planReadyProposal: null,
    planStatus:
      state.planStatus === "executing" ? "executing" : "drafting",
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
    name === "propose_testing_ready" ||
    name === "finalize_plan" ||
    name === "read_plan" ||
    name === "add_phase" ||
    name === "replace_phase" ||
    name === "delete_phase" ||
    name === "add_check" ||
    name === "replace_check" ||
    name === "delete_check" ||
    name === "set_questions"
  );
}

export type PlanMutationPatch = {
  planPhases: PlanPhase[];
  planQuestions: PlanQuestion[];
  planStatus: PlanStatus;
  mode: AgentMode;
  planReadyProposal: SessionState["planReadyProposal"];
  testingConfirmedAt?: SessionState["testingConfirmedAt"];
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
  "Plan structure is locked; done checks are sticky (never uncheck [x] items).",
  "Prefer Focus → Next open item; if you finished several items this round, mark them all done=true in one upsert_plan.",
  "Resume from Focus — do not restart the plan from scratch.",
  "Write required test files as you implement; do NOT run lint/test/typecheck suites yourself — the IDE Test gate runs after the checklist.",
  "Immediately with tools:",
  "1) upsert_plan: set finished items done=true (keep prior done=true); update phase status.",
  "2) Execute the next open checklist item with read_file / write_file / tools. For Node/npm sequences: reuse ONE terminal_* session (do not reopen per command). run_command only for short one-shots (not test suites).",
  "Prefer tools over narration. Keep going until the checklist is fully done.",
].join("\n");

export const PLAN_CONTINUE_NUDGE = [
  "[IDE · TANK] Planning is not finished — do not stop on narration.",
  "Immediately with tools:",
  "1) If exploring: prefer search_graph / get_architecture / search_code (not list_dir tours), then add_phase / add_check (or upsert_plan once for a full draft).",
  "2) If anything is unclear, set_questions with selection + options (Plan Q&A UI).",
  "3) When the plan is solid and questions are cleared, call propose_plan_ready.",
  "Do not only explore/list files. Produce plan structure or questions now.",
].join("\n");

export {
  CHECKLIST_CONTINUE_USER_MESSAGE,
  PLAN_CONTINUE_USER_MESSAGE,
  TESTING_READY_CONTINUE_USER_MESSAGE,
};

