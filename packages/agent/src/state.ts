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
} from "@ai-ide/shared";
import { ArchitectureStore } from "@ai-ide/workspace";

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

  nextIteration(): boolean {
    this.iteration += 1;
    if (this.iteration > MAX_ITERATIONS) {
      this.phase = "failed";
      return false;
    }
    return true;
  }

  recordToolResult(toolName: string, success: boolean): boolean {
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

  return [
    `Plan status: ${state.planStatus}`,
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
    "After meaningful progress, call upsert_plan to mark checklist items done=true and update phase status.",
    "Keep the plan truthful: only mark items done when the work is actually done.",
    "When all phases are completed, say so clearly.",
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

  const phases: PlanPhase[] = rawPhases.map((raw, index) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const checklistRaw = Array.isArray(p.checklist) ? p.checklist : [];
    // Planning: structure only — no execution progress.
    const status = planning
      ? "pending"
      : normalizePhaseStatus(p.status, index === 0);
    return {
      id: typeof p.id === "string" && p.id ? p.id : randomUUID(),
      title:
        typeof p.title === "string" && p.title.trim()
          ? p.title.trim()
          : `Phase ${index + 1}`,
      status,
      checklist: checklistRaw.map((item, itemIndex) => {
        const c = (item ?? {}) as Record<string, unknown>;
        return {
          id: typeof c.id === "string" && c.id ? c.id : randomUUID(),
          text:
            typeof c.text === "string" && c.text.trim()
              ? c.text.trim()
              : `Item ${itemIndex + 1}`,
          done: planning ? false : Boolean(c.done),
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
  isFirst: boolean,
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
  return isFirst ? "in_progress" : "pending";
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
