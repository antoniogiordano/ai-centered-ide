import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AiProvider, ChatMessage } from "@ai-ide/provider";
import { chatContentText } from "@ai-ide/provider";
import type { SessionState } from "@ai-ide/shared";
import { buildSystemPrompt, sessionGoal, takeSafeMessageTail } from "./state.js";

/** Soft trigger fallback when the provider has no contextWindowTokens. */
export const CONTEXT_COMPACT_TRIGGER_TOKENS = 48_000;
/** Compact around this fraction of the configured context window. */
export const CONTEXT_COMPACT_WINDOW_RATIO = 0.75;
/** Do not compact until the live body is at least this large (chars). */
export const CONTEXT_COMPACT_MIN_CHARS = 24_000;
/** After summarization, keep this many recent live messages (tool groups intact). */
export const CONTEXT_COMPACT_KEEP_TAIL = 12;
/** Cap transcript text sent to the summarizer. */
export const CONTEXT_SUMMARY_SOURCE_MAX_CHARS = 120_000;

export function triggerTokensForContextWindow(
  contextWindowTokens: number | null | undefined,
): number {
  if (
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens >= 4_000
  ) {
    return Math.max(
      8_000,
      Math.floor(contextWindowTokens * CONTEXT_COMPACT_WINDOW_RATIO),
    );
  }
  return CONTEXT_COMPACT_TRIGGER_TOKENS;
}

export const AGENT_HISTORY_DIR = ".aici/agent-history";

export function agentHistoryRelPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `${AGENT_HISTORY_DIR}/${safe}.md`;
}

/**
 * Flat per-image token estimate. Vision cost scales with the image's dimensions
 * rather than its byte size, so counting base64 length would be wrong in both
 * directions; a conservative constant keeps the trigger honest. Without this,
 * `chatContentText` drops image parts and a screenshot-heavy session looks tiny
 * to the budget while actually filling the context window.
 */
export const ESTIMATED_TOKENS_PER_IMAGE = 1_000;

/** Images the provider will actually send: user/system parts + tool payloads. */
export function countMessageImages(messages: ChatMessage[]): number {
  let images = 0;
  for (const m of messages) {
    if (m.role === "tool") {
      images += m.images?.length ?? 0;
      continue;
    }
    if (m.role === "assistant") continue;
    if (typeof m.content === "string") continue;
    images += m.content.filter((p) => p.type === "image_url").length;
  }
  return images;
}

/** Rough token estimate (~4 chars/token) for trigger decisions without a tokenizer. */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      chars += (m.content ?? "").length;
      if (m.reasoning_content) chars += m.reasoning_content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          chars += tc.name.length + tc.arguments.length + 24;
        }
      }
    } else if (m.role === "tool") {
      chars += m.content.length + 16;
    } else {
      chars += chatContentText(m.content).length;
    }
  }
  return (
    Math.ceil(chars / 4) +
    countMessageImages(messages) * ESTIMATED_TOKENS_PER_IMAGE
  );
}

export function shouldCompactContext(
  messages: ChatMessage[],
  opts?: {
    lastInputTokens?: number;
    triggerTokens?: number;
    minChars?: number;
  },
): boolean {
  const trigger = opts?.triggerTokens ?? CONTEXT_COMPACT_TRIGGER_TOKENS;
  const minChars = opts?.minChars ?? CONTEXT_COMPACT_MIN_CHARS;
  const body = messages.filter((m) => m.role !== "system");
  const chars = body.reduce((n, m) => {
    if (m.role === "assistant") {
      return (
        n +
        (m.content ?? "").length +
        (m.reasoning_content?.length ?? 0) +
        (m.tool_calls?.reduce(
          (s, tc) => s + tc.name.length + tc.arguments.length,
          0,
        ) ?? 0)
      );
    }
    if (m.role === "tool") return n + m.content.length;
    return n + chatContentText(m.content).length;
  }, 0);
  const imageChars =
    countMessageImages(body) * ESTIMATED_TOKENS_PER_IMAGE * 4;
  if (chars + imageChars < minChars) return false;
  if (
    typeof opts?.lastInputTokens === "number" &&
    opts.lastInputTokens >= trigger
  ) {
    return true;
  }
  return estimateMessagesTokens(messages) >= trigger;
}

export function formatMessagesForSummary(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const text = chatContentText(m.content).trim();
      if (!text || text.startsWith("Original goal:")) continue;
      if (text.startsWith("[Context summary")) continue;
      if (text.startsWith("[IDE · TANK]")) continue;
      lines.push(`USER:\n${truncateBlock(text, 4000)}`);
      continue;
    }
    if (m.role === "assistant") {
      const bits: string[] = [];
      if (m.content?.trim()) bits.push(truncateBlock(m.content.trim(), 3000));
      if (m.tool_calls?.length) {
        bits.push(
          m.tool_calls
            .map(
              (tc) =>
                `tool_call ${tc.name}(${truncateBlock(tc.arguments, 800)})`,
            )
            .join("\n"),
        );
      }
      if (bits.length) lines.push(`ASSISTANT:\n${bits.join("\n")}`);
      continue;
    }
    if (m.role === "tool") {
      lines.push(
        `TOOL[${m.tool_call_id}]:\n${truncateBlock(m.content.trim(), 2500)}`,
      );
    }
  }
  let out = lines.join("\n\n");
  if (out.length > CONTEXT_SUMMARY_SOURCE_MAX_CHARS) {
    out = `${out.slice(0, CONTEXT_SUMMARY_SOURCE_MAX_CHARS)}\n\n… [truncated for summarizer]`;
  }
  return out;
}

function truncateBlock(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

const SUMMARIZE_SYSTEM = [
  "You compress an AI coding-agent trajectory into a durable working memory.",
  "Preserve: user goal, decisions, file paths touched, key code facts, errors hit, what is done vs remaining, and any constraints.",
  "Omit: raw file dumps, repeated tool noise, tank nudges, and decorative narration.",
  "Write in concise English bullet points (or short paragraphs). No tools. No preamble.",
].join(" ");

export async function summarizeAgentTrajectory(
  provider: AiProvider,
  messages: ChatMessage[],
  state: SessionState,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const prior = state.contextSummary?.trim();
  const transcript = formatMessagesForSummary(messages);
  const goal = sessionGoal(state);
  const userParts = [
    goal ? `Original goal:\n${goal}` : null,
    prior
      ? `Previous compaction summary (#${state.contextCompactionCount}):\n${prior}`
      : null,
    `New trajectory to fold in:\n${transcript || "(empty)"}`,
    "Produce an updated working-memory summary for continuing the task.",
  ].filter(Boolean);

  let out = "";
  const chatOpts = opts?.signal ? { signal: opts.signal } : undefined;
  for await (const chunk of provider.chat(
    [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: userParts.join("\n\n") },
    ],
    chatOpts,
  )) {
    if (chunk.type === "content") out += chunk.delta;
    if (chunk.type === "error") {
      throw new Error(chunk.error.userMessage || "Summarization failed");
    }
  }
  return out.trim();
}

export function buildContextSummaryMessage(
  summary: string,
  compactionCount: number,
  historyPath: string | null,
): ChatMessage {
  const historyNote = historyPath
    ? `\n\nFull prior transcript (search/read if details are missing):\n${historyPath}`
    : "";
  return {
    role: "user",
    content: `[Context summary #${compactionCount} — prior trajectory compacted]\n${summary}${historyNote}`,
  };
}

/**
 * Rebuild live provider messages after summarization:
 * fresh system + goal + summary (+ history pointer) + recent tail.
 */
export function applySummarizedCompaction(
  messages: ChatMessage[],
  state: SessionState,
  summary: string,
  opts?: { keepTail?: number; historyPath?: string | null },
): ChatMessage[] {
  const keepTail = opts?.keepTail ?? CONTEXT_COMPACT_KEEP_TAIL;
  const historyPath =
    opts?.historyPath !== undefined
      ? opts.historyPath
      : state.agentHistoryPath;
  const system: ChatMessage = {
    role: "system",
    content: buildSystemPrompt({
      ...state,
      contextSummary: summary,
      agentHistoryPath: historyPath ?? state.agentHistoryPath,
    }),
  };
  const goal = sessionGoal(state);
  const goalMsg: ChatMessage | null = goal
    ? { role: "user", content: `Original goal:\n${goal}` }
    : null;
  const body = messages.filter((m) => {
    if (m.role === "system") return false;
    if (
      m.role === "user" &&
      chatContentText(m.content).startsWith("Original goal:")
    ) {
      return false;
    }
    if (
      m.role === "user" &&
      chatContentText(m.content).startsWith("[Context summary")
    ) {
      return false;
    }
    return true;
  });
  const tail = takeSafeMessageTail(body, keepTail);
  const count = (state.contextCompactionCount ?? 0) + 1;
  return [
    system,
    ...(goalMsg ? [goalMsg] : []),
    buildContextSummaryMessage(summary, count, historyPath ?? null),
    ...tail,
  ];
}

/** Sliding-window fallback when summarization fails (legacy behavior). */
export function fallbackSlideCompact(
  messages: ChatMessage[],
  state: SessionState,
  tailMax: number,
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
    if (
      m.role === "user" &&
      chatContentText(m.content).startsWith("Original goal:")
    ) {
      return false;
    }
    return true;
  });
  return [system, ...(goalMsg ? [goalMsg] : []), ...takeSafeMessageTail(body, tailMax)];
}

export function refreshSystemMessage(
  messages: ChatMessage[],
  state: SessionState,
): void {
  const system: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(state),
  };
  if (messages[0]?.role === "system") {
    messages[0] = system;
  } else {
    messages.unshift(system);
  }
}

export async function appendAgentHistoryFile(
  workspaceRoot: string,
  sessionId: string,
  compactedAway: ChatMessage[],
  compactionIndex: number,
): Promise<string> {
  const rel = agentHistoryRelPath(sessionId);
  const abs = join(workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });
  const stamp = new Date().toISOString();
  const body = formatMessagesForSummary(compactedAway);
  const section = [
    "",
    `## Compaction #${compactionIndex} — ${stamp}`,
    "",
    body || "(no body)",
    "",
  ].join("\n");
  await appendFile(abs, section, "utf8");
  return rel;
}

export type CompactContextResult = {
  messages: ChatMessage[];
  state: SessionState;
  compacted: boolean;
  method: "summary" | "fallback" | "none";
};

/**
 * Cursor-style compaction: keep growing until near the token trigger, then
 * summarize + pin summary + keep a short live tail + archive to history file.
 */
export async function maybeCompactProviderMessages(opts: {
  messages: ChatMessage[];
  state: SessionState;
  provider: AiProvider;
  workspaceRoot?: string | null;
  lastInputTokens?: number;
  /** Active provider context window (tokens). */
  contextWindowTokens?: number | null;
  signal?: AbortSignal;
  /** Force compact (tests / manual). */
  force?: boolean;
}): Promise<CompactContextResult> {
  const { messages, state, provider } = opts;
  const triggerTokens = triggerTokensForContextWindow(opts.contextWindowTokens);
  const needs =
    opts.force === true ||
    shouldCompactContext(messages, {
      ...(typeof opts.lastInputTokens === "number"
        ? { lastInputTokens: opts.lastInputTokens }
        : {}),
      triggerTokens,
    });
  if (!needs) {
    refreshSystemMessage(messages, state);
    return { messages, state, compacted: false, method: "none" };
  }

  const nextCount = (state.contextCompactionCount ?? 0) + 1;
  let historyPath = state.agentHistoryPath;
  const root = opts.workspaceRoot?.trim() || null;
  if (root) {
    try {
      historyPath = await appendAgentHistoryFile(
        root,
        state.sessionId,
        messages,
        nextCount,
      );
    } catch {
      // History archive is best-effort; still compact in-memory.
    }
  }

  try {
    const summary = await summarizeAgentTrajectory(
      provider,
      messages,
      state,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    if (!summary) throw new Error("Empty summary");
    const nextState: SessionState = {
      ...state,
      contextSummary: summary,
      contextCompactionCount: nextCount,
      agentHistoryPath: historyPath ?? state.agentHistoryPath,
    };
    const nextMessages = applySummarizedCompaction(messages, nextState, summary, {
      historyPath: nextState.agentHistoryPath,
    });
    return {
      messages: nextMessages,
      state: nextState,
      compacted: true,
      method: "summary",
    };
  } catch {
    const nextState: SessionState = {
      ...state,
      contextCompactionCount: nextCount,
      agentHistoryPath: historyPath ?? state.agentHistoryPath,
    };
    const nextMessages = fallbackSlideCompact(
      messages,
      nextState,
      CONTEXT_COMPACT_KEEP_TAIL * 2,
    );
    return {
      messages: nextMessages,
      state: nextState,
      compacted: true,
      method: "fallback",
    };
  }
}
