import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatChunk, ChatOptions } from "@ai-ide/provider";
import {
  expandMessagesForOpenAi,
  flattenVisionToText,
  messagesHaveVision,
} from "@ai-ide/provider";
import type { AgentAskAnswer } from "@ai-ide/tools";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import { newSession, runAgentTurn } from "./index.js";

/**
 * Replays a real debugging session: an e2e suite fails, the failure is only
 * explicable from the screenshot, and the fix has two legitimate shapes so the
 * user has to pick one.
 *
 * The point of the scenario is the two capabilities that plain text cannot
 * cover — the agent looking at pixels (read_image) and the agent blocking on a
 * structural decision (ask_user) — exercised through the real loop, gateway and
 * provider message construction.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("joyride-overlay-covering-the-search-bar"),
]);

const SPEC_BEFORE = `describe("Chess Openings", () => {
  it("filters the opening list", () => {
    cy.visit("/");
    cy.get('[data-testid="search"]').type("Amar");
  });
});
`;

const E2E_LOG = `Timed out retrying after 4000ms: cy.type() failed because this element is being covered by another element:
<path d="M0,0h100v100h-100z" class="react-joyride__overlay">
1 of 1 failed (100%)  openings.cy.ts
Screenshot: cypress/screenshots/openings.cy.ts/filters (failed).png
`;

const SHOT_PATH = "cypress/screenshots/openings.cy.ts/filters (failed).png";

type Round = {
  name: string;
  args: Record<string, unknown>;
};

const SCRIPT: Round[] = [
  { name: "read_test_log", args: { suiteId: "e2e" } },
  {
    name: "read_image",
    args: { path: SHOT_PATH, reason: "what is covering the search bar" },
  },
  {
    name: "ask_user",
    args: {
      context:
        "The onboarding tour overlay (react-joyride) covers the whole page, so Cypress refuses to type into the search bar. localStorage is cleared before each test, so every test looks like a first visit.",
      prompt: "How should the tour be kept out of the e2e runs?",
      options: [
        { id: "seed", label: "Seed localStorage in the tests (Recommended)" },
        { id: "env", label: "Disable the tour behind an env flag" },
      ],
    },
  },
  {
    name: "replace_in_file",
    args: {
      path: "cypress/e2e/openings.cy.ts",
      search: 'cy.visit("/");',
      replace: "cy.visitApp();",
    },
  },
];

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "aici-harness-"));
  mkdirSync(join(root, "cypress/e2e"), { recursive: true });
  mkdirSync(join(root, "cypress/screenshots/openings.cy.ts"), {
    recursive: true,
  });
  writeFileSync(join(root, "cypress/e2e/openings.cy.ts"), SPEC_BEFORE);
  writeFileSync(join(root, SHOT_PATH), PNG);
  return root;
}

/** Test gate has run and failed; the checklist is done, so the phase is Test. */
function failedGateSession(root: string) {
  return {
    ...newSession("s-harness", "agent"),
    mode: "agent" as const,
    planStatus: "executing" as const,
    planPhases: [
      {
        id: "p1",
        title: "Opening list",
        status: "completed" as const,
        checklist: [{ id: "c1", text: "Filterable list", done: true }],
      },
    ],
    // Left null on purpose: it keeps tank mode off so the turn ends when the
    // agent stops calling tools, instead of being nudged to continue.
    testingConfirmedAt: null,
    testRun: {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "failed" as const,
      specs: [],
      suites: [
        {
          id: "e2e",
          kind: "e2e" as const,
          command: "pnpm test:e2e",
          status: "failed" as const,
          exitCode: 1,
          durationMs: 8_000,
          summary: "1 failing",
          logChars: E2E_LOG.length,
          logChunkSize: 8_000,
          logChunks: 1,
          failedTests: ["Chess Openings > filters the opening list"],
        },
      ],
      digest: "[IDE · TEST GATE] e2e failed",
    },
    workspace: {
      projectId: "p1",
      rootPath: root,
      resolvedRootPath: root,
      name: "chess-openings",
    },
  };
}

describe("harness scenario: e2e failure diagnosed from a screenshot", () => {
  it("reads the log, looks at the screenshot, asks the user, then applies the chosen fix", async () => {
    const root = makeWorkspace();
    const seenMessages: ChatMessage[][] = [];
    const offeredTools: string[][] = [];
    let round = 0;
    let askResolvedAt = -1;
    let askCalledAt = -1;

    const provider = {
      async listModels() {
        return [{ id: "mock-vision" }];
      },
      cancel() {},
      async *chat(
        messages: ChatMessage[],
        options?: ChatOptions,
      ): AsyncIterable<ChatChunk> {
        seenMessages.push(structuredClone(messages));
        offeredTools.push((options?.tools ?? []).map((t) => t.name));
        const step = SCRIPT[round];
        round += 1;
        if (step) {
          yield {
            type: "tool_call",
            id: `call_${round}`,
            name: step.name,
            argumentsDelta: JSON.stringify(step.args),
            index: 0,
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "content",
          delta:
            "The tour overlay was blocking the click. I seeded localStorage in the spec as you chose.",
        };
        yield { type: "done", finishReason: "stop" };
      },
    };

    const askHost = {
      ask: async (): Promise<AgentAskAnswer> => {
        askCalledAt = round;
        await new Promise((r) => setTimeout(r, 10));
        askResolvedAt = round;
        return {
          selectedOptionIds: ["seed"],
          selectedLabels: ["Seed localStorage in the tests (Recommended)"],
          text: "",
          cancelled: false,
        };
      },
    };

    const result = await runAgentTurn(
      failedGateSession(root),
      "the e2e suite is red, figure out why",
      {
        provider,
        toolCtx: {
          workspaceRoot: root,
          fs: new FilesystemService(root),
          git: new GitService(root),
          checkpoint: new CheckpointService(root, join(root, ".checkpoints")),
          ask: askHost,
          testLogs: { get: (id: string) => (id === "e2e" ? E2E_LOG : undefined) },
        },
      },
    );

    // 1. The agent ran the full diagnosis, in order.
    expect(
      result.toolResults.map((r) => r.summary.split(" ")[0]),
    ).toHaveLength(SCRIPT.length);
    const names = SCRIPT.map((s) => s.name);
    expect(names).toEqual([
      "read_test_log",
      "read_image",
      "ask_user",
      "replace_in_file",
    ]);
    expect(result.toolResults.every((r) => r.success)).toBe(true);

    // 2. Both new tools were actually offered to the model in this phase.
    expect(offeredTools[0]).toContain("read_image");
    expect(offeredTools[0]).toContain("ask_user");
    expect(offeredTools[0]).toContain("read_test_log");

    // 3. The screenshot pixels reached the model, attached to the tool result
    //    and never persisted into the session state.
    const afterImage = seenMessages[2] ?? [];
    const imageMessage = afterImage.find(
      (m) => m.role === "tool" && m.images?.length,
    );
    expect(imageMessage).toBeDefined();
    expect(
      imageMessage?.role === "tool" ? imageMessage.images?.[0] : null,
    ).toMatchObject({
      mime: "image/png",
      dataBase64: PNG.toString("base64"),
    });
    expect(JSON.stringify(result.state.turns)).not.toContain(
      PNG.toString("base64"),
    );

    // 4. On the wire the pixels move to a user message — OpenAI rejects images
    //    on tool messages.
    const wire = expandMessagesForOpenAi(afterImage);
    const hoisted = wire.filter(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(JSON.stringify(hoisted)).toContain("image_url");
    for (const m of wire.filter((m) => m.role === "tool")) {
      expect(JSON.stringify(m)).not.toContain("image_url");
    }

    // 5. ask_user blocked the turn and its answer came back in the tool result.
    expect(askCalledAt).toBeGreaterThan(0);
    expect(askResolvedAt).toBe(askCalledAt);
    const askResult = result.toolResults[2];
    expect(askResult?.summary).toContain("Seed localStorage");
    expect(
      seenMessages[3]?.some(
        (m) => m.role === "tool" && m.content.includes("selectedOptionIds"),
      ),
    ).toBe(true);

    // 6. The chosen fix was applied to the real file.
    const spec = readFileSync(join(root, "cypress/e2e/openings.cy.ts"), "utf8");
    expect(spec).toContain("cy.visitApp();");
    expect(spec).not.toContain('cy.visit("/");');

    expect(result.assistantContent).toContain("tour overlay");
    rmSync(root, { recursive: true });
  });

  it("keeps working on a model without vision by degrading to text", async () => {
    const root = makeWorkspace();
    const seenMessages: ChatMessage[][] = [];
    let round = 0;

    const provider = {
      async listModels() {
        return [{ id: "mock-text" }];
      },
      cancel() {},
      async *chat(messages: ChatMessage[]): AsyncIterable<ChatChunk> {
        seenMessages.push(structuredClone(messages));
        round += 1;
        if (round === 1) {
          yield {
            type: "tool_call",
            id: "call_1",
            name: "read_image",
            argumentsDelta: JSON.stringify({ path: SHOT_PATH }),
            index: 0,
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "content", delta: "I cannot see the screenshot." };
        yield { type: "done", finishReason: "stop" };
      },
    };

    const result = await runAgentTurn(
      failedGateSession(root),
      "look at the screenshot",
      {
        provider,
        toolCtx: {
          workspaceRoot: root,
          fs: new FilesystemService(root),
          git: new GitService(root),
          checkpoint: new CheckpointService(root, join(root, ".checkpoints")),
        },
      },
    );

    // The tool still succeeds; only the wire encoding drops the pixels, and the
    // model is told so instead of silently losing them.
    expect(result.toolResults[0]?.success).toBe(true);

    const afterImage = seenMessages[1] ?? [];
    expect(messagesHaveVision(afterImage)).toBe(true);
    const flattened = flattenVisionToText(afterImage);
    expect(messagesHaveVision(flattened)).toBe(false);
    const toolMessage = flattened.find((m) => m.role === "tool");
    expect(toolMessage?.role === "tool" ? toolMessage.content : "").toContain(
      "cannot view images",
    );
    expect(JSON.stringify(flattened)).not.toContain(PNG.toString("base64"));
    rmSync(root, { recursive: true });
  });
});
