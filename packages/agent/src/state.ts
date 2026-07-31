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

export const MAX_ITERATIONS = 25;
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
export const MAX_SAME_TOOL_STREAK = 8;

function formatPlanForPrompt(state: SessionState): string {
  if (state.planPhases.length === 0) {
    return "Current plan: (empty — call upsert_plan with draft phases + open questions).";
  }
  const lines = state.planPhases.map((phase, i) => {
    const checks = phase.checklist
      .map((c) => `    - [${c.done ? "x" : " "}] ${c.text}`)
      .join("\n");
    return `${i + 1}. [${phase.status}] ${phase.title}\n${checks || "    (no checklist items yet)"}`;
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
  return [
    `Plan status: ${state.planStatus}`,
    "Current plan:",
    ...lines,
    questions,
  ].join("\n");
}

export function buildSystemPrompt(state: SessionState): string {
  const root = state.workspace?.resolvedRootPath ?? state.workspace?.rootPath;
  const planning = state.mode === "plan" || state.planStatus === "drafting";

  const identity = [
    "You are the product manager of this AI-First IDE.",
    "You collaborate with the user through a planning Q&A, then drive development against an agreed plan.",
    "Keep replies concise. Prefer short turns over long monologues.",
  ];

  const workspaceLine = root
    ? [
        `Active workspace root: ${root}`,
        "All file tool paths are relative to that workspace root (never absolute OS paths).",
        'Examples: list_dir with path "." ; read_file with path "README.md".',
      ]
    : [
        "No workspace is open yet. Ask the user to open a project folder before reading files.",
      ];

  const planningRules = [
    "PHASE: PLANNING (Q&A — not execution)",
    "Available tools: list_dir, read_file, search_text, upsert_plan, finalize_plan.",
    "Unavailable: write_file, git_*, run_command, checkpoint_restore.",
    "",
    "Clarifying questions (critical — UI dialog; USER answers, never you):",
    "- ALWAYS put open questions in upsert_plan.questions (never only in chat prose).",
    "- EVERY question MUST include selection: \"single\" OR \"multiple\", plus 2–8 concrete options[{id,label}].",
    "- single = mutually exclusive choices (UI keys A–Z). multiple = multi-select (UI keys 1–9).",
    "- Leave status=\"open\". Do NOT set answer, selectedOptionIds, or status=\"answered\" — the user answers in a dialog; inventing answers is forbidden.",
    "- Prefer 1–3 open questions per turn. Keep previously user-answered questions with their existing answers when you re-upsert.",
    "",
    "Turn discipline (critical):",
    "1) First broad request: lightly explore the repo, then upsert_plan with draft phases + checklist + open choice questions (unanswered). Do NOT dump a full analysis essay. Do NOT call finalize_plan.",
    "2) Subsequent turns: ONLY after the user answered via the dialog/message, update upsert_plan. Ask the next unanswered questions. Never answer on the user's behalf.",
    "3) Never implement, rewrite files, or pretend development has started.",
    "4) Only when the plan is solid AND open questions are answered by the user, ask: \"Is this plan ready to start development?\"",
    "5) Call finalize_plan(confirmed=true) ONLY after the user's latest message clearly confirms starting development (e.g. yes, start building / confermo / iniziamo lo sviluppo). An analysis request is NOT confirmation.",
    formatPlanForPrompt(state),
  ];

  const buildRules = [
    "PHASE: DEVELOPMENT",
    "The plan is locked. Implement it phase by phase using tools (including write/git/commands).",
    "After meaningful progress, call upsert_plan to mark checklist items done and update phase status.",
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

  const phases: PlanPhase[] = rawPhases.map((raw, index) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const checklistRaw = Array.isArray(p.checklist) ? p.checklist : [];
    const status = normalizePhaseStatus(p.status, index === 0);
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
          done: Boolean(c.done),
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

const BUILD_CONFIRM_RE =
  /\b(start (building|development|dev)|ready to (build|start|develop)|go ahead( and build)?|proceed with (the )?plan|iniziamo( lo sviluppo)?|procedi( con lo sviluppo)?|confermo( il piano)?|passa allo sviluppo|inizia( lo sviluppo)?)\b/i;

export function looksLikeBuildConfirmation(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  if (BUILD_CONFIRM_RE.test(text)) return true;
  // Short affirmative only after a plan exists is handled by caller context;
  // bare "yes"/"ok"/"sì" count when the message is short.
  return /^(yes|yep|yeah|ok|okay|sure|sì|si|confermo|vai|proceed)\.?$/i.test(
    text,
  );
}

export function applyFinalizePlan(
  state: SessionState,
  args: Record<string, unknown>,
  opts?: { userMessage?: string },
): { state: SessionState; result: ToolResult; callId: string } {
  const callId = randomUUID();
  if (args.confirmed !== true) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary:
          "finalize_plan requires confirmed=true after the user explicitly agrees to start building.",
        error: "Not confirmed",
      },
    };
  }
  if (state.planPhases.length === 0) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary: "Cannot finalize an empty plan. Call upsert_plan first.",
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
        summary: `Cannot finalize yet: ${openQuestions.length} open question(s) remain. Continue the Q&A and update upsert_plan.`,
        error: "Open questions remain",
        output: { openQuestions },
      },
    };
  }

  const userMessage = opts?.userMessage ?? "";
  if (!looksLikeBuildConfirmation(userMessage)) {
    return {
      callId,
      state,
      result: {
        callId,
        success: false,
        summary:
          "User has not clearly confirmed starting development. Ask: \"Is this plan ready to start development?\" and wait for an explicit yes.",
        error: "No user confirmation",
      },
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

  const next: SessionState = {
    ...state,
    mode: "agent",
    planStatus: "executing",
    planPhases: phases,
  };

  return {
    callId,
    state: next,
    result: {
      callId,
      success: true,
      summary: "Plan finalized. Switched to development mode.",
      output: {
        mode: next.mode,
        planStatus: next.planStatus,
        planPhases: phases,
      },
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
  return name === "upsert_plan" || name === "finalize_plan";
}

export type PlanMutationPatch = {
  planPhases: PlanPhase[];
  planQuestions: PlanQuestion[];
  planStatus: PlanStatus;
  mode: AgentMode;
};

export function productPhaseForState(
  state: Pick<SessionState, "mode" | "planStatus">,
): "planning" | "building" {
  if (state.mode === "plan" || state.planStatus === "drafting") return "planning";
  return "building";
}
