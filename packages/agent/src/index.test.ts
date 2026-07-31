import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@ai-ide/provider";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import {
  applyFinalizePlan,
  applyUpsertPlan,
  looksLikeBuildConfirmation,
  mergePlanQuestionFromAgent,
  newSession,
  runAgentTurn,
  tryParsePartialJson,
  TurnStateMachine,
} from "./index.js";

describe("agent runtime", () => {
  it("runs a turn with mock provider", async () => {
    const provider = new MockProvider({
      name: "test",
      steps: [{ type: "content", text: "Done." }],
    });
    const session = newSession("s1", "ask");
    const result = await runAgentTurn(session, "hello", { provider });
    expect(result.assistantContent).toContain("Done");
    expect(result.state.turns.length).toBeGreaterThan(0);
  });

  it("calls read_file via tool_call then answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-ws-"));
    writeFileSync(join(root, "README.md"), "# Hello workspace\n");

    let round = 0;
    const provider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat() {
        round += 1;
        if (round === 1) {
          yield {
            type: "tool_call" as const,
            id: "call_1",
            name: "read_file",
            argumentsDelta: JSON.stringify({ path: "README.md" }),
            index: 0,
          };
          yield { type: "done" as const, finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "content" as const,
          delta: "The README says: Hello workspace",
        };
        yield { type: "done" as const, finishReason: "stop" };
      },
    };

    const session = {
      ...newSession("s2", "ask"),
      workspace: {
        projectId: "p1",
        rootPath: root,
        resolvedRootPath: root,
        name: "ws",
      },
    };

    const result = await runAgentTurn(session, "cosa c'è nel README?", {
      provider,
      toolCtx: {
        workspaceRoot: root,
        fs: new FilesystemService(root),
        git: new GitService(root),
        checkpoint: new CheckpointService(root, join(root, ".checkpoints")),
      },
    });

    expect(result.toolResults.some((r) => r.success && r.summary.includes("README"))).toBe(
      true,
    );
    expect(result.assistantContent).toContain("Hello workspace");
  });

  it("emits thinking and token progress events", async () => {
    const provider = new MockProvider({
      name: "test",
      steps: [{ type: "content", text: "Hello stream" }],
    });
    const session = newSession("s-progress", "ask");
    const events: string[] = [];
    const result = await runAgentTurn(session, "hi", {
      provider,
      onProgress: (e) => {
        if (e.type === "activity") events.push(`activity:${e.status}`);
        if (e.type === "token") events.push("token");
      },
    });
    expect(events.some((e) => e.startsWith("activity:"))).toBe(true);
    expect(events.includes("token")).toBe(true);
    expect(result.assistantContent).toContain("Hello");
  });

  it("upserts and finalizes a delivery plan", async () => {
    let round = 0;
    const provider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat() {
        round += 1;
        if (round === 1) {
          yield {
            type: "tool_call" as const,
            id: "call_plan",
            name: "upsert_plan",
            argumentsDelta: JSON.stringify({
              phases: [
                {
                  title: "Foundation",
                  checklist: [{ text: "Open workspace", done: false }],
                },
              ],
            }),
            index: 0,
          };
          yield { type: "done" as const, finishReason: "tool_calls" };
          return;
        }
        if (round === 2) {
          yield {
            type: "tool_call" as const,
            id: "call_fin",
            name: "finalize_plan",
            argumentsDelta: JSON.stringify({ confirmed: true }),
            index: 0,
          };
          yield { type: "done" as const, finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "content" as const,
          delta: "Plan locked. Ready to build.",
        };
        yield { type: "done" as const, finishReason: "stop" };
      },
    };

    const session = newSession("s-plan", "plan");
    const patches: string[] = [];
    const result = await runAgentTurn(session, "start building", {
      provider,
      onProgress: (e) => {
        if (e.type === "session_patch") patches.push(e.patch.planStatus);
      },
    });

    expect(result.state.planPhases).toHaveLength(1);
    expect(result.state.planPhases[0]?.title).toBe("Foundation");
    expect(result.state.mode).toBe("agent");
    expect(result.state.planStatus).toBe("executing");
    expect(patches).toContain("drafting");
    expect(patches).toContain("executing");
  });

  it("strips agent-invented clarifying answers", () => {
    const session = newSession("s-q", "plan");
    const applied = applyUpsertPlan(session, {
      phases: [
        {
          title: "Discovery",
          checklist: [{ text: "Explore", done: false }],
        },
      ],
      questions: [
        {
          id: "q1",
          text: "Which stack?",
          selection: "single",
          options: [
            { id: "a", label: "React" },
            { id: "b", label: "Vue" },
          ],
          status: "answered",
          answer: "React (I decided for you)",
        },
      ],
    });
    expect(applied.result.success).toBe(true);
    expect(applied.state.planQuestions[0]?.status).toBe("open");
    expect(applied.state.planQuestions[0]?.answer).toBeUndefined();
  });

  it("keeps user answers when agent re-upserts", () => {
    const merged = mergePlanQuestionFromAgent(
      {
        id: "q1",
        text: "Which stack?",
        selection: "single",
        options: [
          { id: "a", label: "React" },
          { id: "b", label: "Vue" },
        ],
        status: "open",
      },
      0,
      [
        {
          id: "q1",
          text: "Which stack?",
          selection: "single",
          options: [
            { id: "a", label: "React" },
            { id: "b", label: "Vue" },
          ],
          status: "answered",
          answer: "React",
          selectedOptionIds: ["a"],
        },
      ],
    );
    expect(merged.status).toBe("answered");
    expect(merged.answer).toBe("React");
  });

  it("parses partial JSON for streaming tool args", () => {
    const partial = tryParsePartialJson(
      '{"phases":[{"title":"Foundation","checklist":[{"text":"Boot"',
    );
    expect(partial).toBeTruthy();
    const obj = partial as { phases: Array<{ title: string }> };
    expect(obj.phases[0]?.title).toBe("Foundation");
  });

  it("emits provisional plan patches while upsert_plan streams", async () => {
    const fullArgs = JSON.stringify({
      phases: [
        {
          title: "Foundation",
          checklist: [{ text: "Open workspace", done: false }],
        },
      ],
      questions: [
        {
          id: "q1",
          text: "Target platform?",
          selection: "single",
          options: [
            { id: "web", label: "Web" },
            { id: "desktop", label: "Desktop" },
          ],
          status: "open",
        },
      ],
    });
    const provider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat() {
        yield {
          type: "tool_call" as const,
          id: "call_stream",
          name: "upsert_plan",
          argumentsDelta: fullArgs.slice(0, 40),
          index: 0,
        };
        yield {
          type: "tool_call" as const,
          id: "call_stream",
          name: "upsert_plan",
          argumentsDelta: fullArgs.slice(40),
          index: 0,
        };
        yield { type: "done" as const, finishReason: "tool_calls" };
        yield {
          type: "content" as const,
          delta: "Please answer the clarifying questions.",
        };
        yield { type: "done" as const, finishReason: "stop" };
      },
    };

    const events: string[] = [];
    const result = await runAgentTurn(newSession("s-stream", "plan"), "plan it", {
      provider,
      onProgress: (e) => {
        if (e.type === "session_patch") {
          events.push(e.provisional ? "provisional" : "final");
        }
        if (e.type === "tool_args") events.push("tool_args");
      },
    });

    expect(events).toContain("tool_args");
    expect(events).toContain("final");
    expect(result.state.planQuestions[0]?.status).toBe("open");
    expect(result.state.planQuestions[0]?.answer).toBeUndefined();
  });

  it("blocks finalize without clear user confirmation", () => {
    const session = {
      ...newSession("s-fin", "plan"),
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "pending" as const,
          checklist: [{ id: "c1", text: "Do thing", done: false }],
        },
      ],
      planQuestions: [],
    };
    const blocked = applyFinalizePlan(
      session,
      { confirmed: true },
      { userMessage: "vorrei un'analisi completa del progetto" },
    );
    expect(blocked.result.success).toBe(false);
    expect(looksLikeBuildConfirmation("start building")).toBe(true);
  });

  it("stops after max iterations", () => {
    const machine = new TurnStateMachine();
    machine.begin();
    for (let i = 0; i < 30; i++) {
      if (!machine.nextIteration()) break;
    }
    expect(machine.phase).toBe("failed");
  });

  it("detects consecutive tool failures", () => {
    const machine = new TurnStateMachine();
    machine.begin();
    machine.recordToolResult("read_file", false);
    machine.recordToolResult("read_file", false);
    machine.recordToolResult("read_file", false);
    expect(machine.phase).toBe("failed");
  });
});
