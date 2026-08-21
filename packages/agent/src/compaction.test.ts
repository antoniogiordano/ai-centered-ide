import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AiProvider, ChatMessage } from "@ai-ide/provider";
import {
  applySummarizedCompaction,
  CONTEXT_COMPACT_MIN_CHARS,
  countMessageImages,
  ESTIMATED_TOKENS_PER_IMAGE,
  estimateMessagesTokens,
  formatMessagesForSummary,
  maybeCompactProviderMessages,
  shouldCompactContext,
} from "./compaction.js";
import { newSession } from "./state.js";

function bloatedMessages(chars: number): ChatMessage[] {
  const chunk = "x".repeat(2000);
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "Original goal:\nShip the tour" },
  ];
  let n = 0;
  while (n < chars) {
    msgs.push({ role: "user", content: `noise ${msgs.length} ${chunk}` });
    n += chunk.length + 20;
  }
  return msgs;
}

describe("context compaction (Cursor-style)", () => {
  it("estimates tokens from message text", () => {
    const tokens = estimateMessagesTokens([
      { role: "user", content: "abcd".repeat(100) },
    ]);
    expect(tokens).toBeGreaterThan(50);
  });

  it("charges tokens for images, which carry no countable text", () => {
    const textOnly: ChatMessage[] = [
      { role: "tool", tool_call_id: "c1", content: '{"summary":"ok"}' },
    ];
    const withImage: ChatMessage[] = [
      {
        role: "tool",
        tool_call_id: "c1",
        content: '{"summary":"ok"}',
        images: [{ mime: "image/png", dataBase64: "abc" }],
      },
    ];
    expect(countMessageImages(withImage)).toBe(1);
    expect(estimateMessagesTokens(withImage)).toBe(
      estimateMessagesTokens(textOnly) + ESTIMATED_TOKENS_PER_IMAGE,
    );
  });

  it("counts images attached to user messages too", () => {
    expect(
      countMessageImages([
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,a" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,b" } },
          ],
        },
      ]),
    ).toBe(2);
  });

  it("lets a screenshot-heavy session trigger compaction", () => {
    // Text alone is far below the floor; without image accounting this session
    // would never compact while actually filling the context window.
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "why is the e2e red?" },
    ];
    for (let i = 0; i < 8; i += 1) {
      messages.push({
        role: "tool",
        tool_call_id: `c${i}`,
        content: '{"summary":"Viewing shot.png"}',
        images: [{ mime: "image/png", dataBase64: "abc" }],
      });
    }
    expect(shouldCompactContext(messages, { triggerTokens: 6_000 })).toBe(true);
    const withoutImages: ChatMessage[] = messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", tool_call_id: m.tool_call_id, content: m.content }
        : m,
    );
    expect(
      shouldCompactContext(withoutImages, { triggerTokens: 6_000 }),
    ).toBe(false);
  });

  it("does not compact under min chars even if tokens look high", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "short" },
    ];
    expect(
      shouldCompactContext(messages, {
        lastInputTokens: 99_000,
        minChars: CONTEXT_COMPACT_MIN_CHARS,
      }),
    ).toBe(false);
  });

  it("compacts when body is large and lastInputTokens exceeds trigger", () => {
    const messages = bloatedMessages(CONTEXT_COMPACT_MIN_CHARS + 1000);
    expect(
      shouldCompactContext(messages, {
        lastInputTokens: 50_000,
        triggerTokens: 48_000,
      }),
    ).toBe(true);
  });

  it("formats transcript without system/goal noise", () => {
    const text = formatMessagesForSummary([
      { role: "system", content: "ignore" },
      { role: "user", content: "Original goal:\nx" },
      { role: "user", content: "Read AppHeader" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", name: "read_file", arguments: '{"path":"a.ts"}' },
        ],
      },
      { role: "tool", tool_call_id: "1", content: "export function Header() {}" },
    ]);
    expect(text).toContain("Read AppHeader");
    expect(text).toContain("read_file");
    expect(text).not.toContain("ignore");
    expect(text).not.toContain("Original goal");
  });

  it("applySummarizedCompaction pins summary + keeps tool-tail intact", () => {
    const state = {
      ...newSession("s-sum", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Tour",
          status: "in_progress" as const,
          checklist: [{ id: "c1", text: "Add tour lib", done: false }],
        },
      ],
      turns: [
        {
          id: "u0",
          role: "user" as const,
          content: "Add a product tour",
          createdAt: new Date().toISOString(),
        },
      ],
      contextCompactionCount: 0,
      agentHistoryPath: ".aici/agent-history/s-sum.md",
    };
    const messages: ChatMessage[] = [
      { role: "system", content: "old" },
      { role: "user", content: "Original goal:\nAdd a product tour" },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: "user" as const,
        content: `step ${i}`,
      })),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ];
    const next = applySummarizedCompaction(
      messages,
      state,
      "- Touched AppHeader\n- Next: tour.ts",
    );
    expect(next[0]?.role).toBe("system");
    expect(
      next.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("Context summary #1"),
      ),
    ).toBe(true);
    expect(
      next.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes(".aici/agent-history/s-sum.md"),
      ),
    ).toBe(true);
    expect(next[next.length - 1]?.role).toBe("tool");
    expect(next.length).toBeLessThan(messages.length);
  });

  it("maybeCompactProviderMessages summarizes via provider and archives history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-compact-"));
    let sawSummarize = false;
    const provider: AiProvider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat(messages) {
        const sys =
          typeof messages[0]?.content === "string" ? messages[0].content : "";
        if (sys.includes("compress an AI coding-agent")) {
          sawSummarize = true;
          yield {
            type: "content" as const,
            delta: "- Goal: product tour\n- Files: AppHeader, page.tsx",
          };
          yield { type: "done" as const, finishReason: "stop" };
          return;
        }
        yield { type: "content" as const, delta: "unexpected" };
        yield { type: "done" as const, finishReason: "stop" };
      },
    };

    const state = {
      ...newSession("s-hist", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      workspace: {
        projectId: "p",
        name: "t",
        rootPath: dir,
        resolvedRootPath: dir,
      },
      planPhases: [
        {
          id: "p1",
          title: "Tour",
          status: "in_progress" as const,
          checklist: [{ id: "c1", text: "Ship", done: false }],
        },
      ],
      turns: [
        {
          id: "u0",
          role: "user" as const,
          content: "Add a product tour",
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const messages = bloatedMessages(CONTEXT_COMPACT_MIN_CHARS + 2000);
    const result = await maybeCompactProviderMessages({
      messages,
      state,
      provider,
      workspaceRoot: dir,
      force: true,
    });

    expect(sawSummarize).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.method).toBe("summary");
    expect(result.state.contextSummary).toContain("product tour");
    expect(result.state.contextCompactionCount).toBe(1);
    expect(result.state.agentHistoryPath).toMatch(/\.aici\/agent-history\//);
    const hist = readFileSync(
      join(dir, result.state.agentHistoryPath!),
      "utf8",
    );
    expect(hist).toContain("Compaction #1");
  });

  it("triggerTokensForContextWindow uses 75% of configured window", async () => {
    const { triggerTokensForContextWindow, CONTEXT_COMPACT_TRIGGER_TOKENS } =
      await import("./compaction.js");
    expect(triggerTokensForContextWindow(128_000)).toBe(96_000);
    expect(triggerTokensForContextWindow(null)).toBe(
      CONTEXT_COMPACT_TRIGGER_TOKENS,
    );
    expect(triggerTokensForContextWindow(1000)).toBe(
      CONTEXT_COMPACT_TRIGGER_TOKENS,
    );
    // 4k–8k local models must trigger *below* n_ctx, not at the old 8k floor.
    expect(triggerTokensForContextWindow(4_096)).toBe(3_072);
    expect(triggerTokensForContextWindow(8_192)).toBe(6_144);
  });

  it("lowers the char floor on small local windows so the system prompt counts", async () => {
    const { minCharsForContextWindow, CONTEXT_COMPACT_MIN_CHARS } =
      await import("./compaction.js");
    expect(minCharsForContextWindow(null)).toBe(CONTEXT_COMPACT_MIN_CHARS);
    expect(minCharsForContextWindow(128_000)).toBe(CONTEXT_COMPACT_MIN_CHARS);
    expect(minCharsForContextWindow(4_096)).toBe(2_000);
  });

  it("falls back to sliding tail when summarizer fails", async () => {
    const provider: AiProvider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat() {
        yield {
          type: "error" as const,
          error: {
            code: "PROVIDER_ERROR",
            userMessage: "nope",
            technicalDetail: "nope",
            name: "AppError",
            message: "nope",
          } as never,
        };
      },
    };
    const state = {
      ...newSession("s-fb", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      turns: [
        {
          id: "u0",
          role: "user" as const,
          content: "Build it",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const result = await maybeCompactProviderMessages({
      messages: bloatedMessages(CONTEXT_COMPACT_MIN_CHARS + 500),
      state,
      provider,
      force: true,
    });
    expect(result.compacted).toBe(true);
    expect(result.method).toBe("fallback");
    expect(result.messages[0]?.role).toBe("system");
  });
});
