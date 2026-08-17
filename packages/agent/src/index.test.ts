import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, chatContentText } from "@ai-ide/provider";
import { AppError } from "@ai-ide/shared";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import {
  applyAddCheck,
  applyAddPhase,
  applyDeleteCheck,
  applyProposePlanReady,
  applyProposeTestingReady,
  applyReplaceCheck,
  applyStartBuilding,
  applyUpsertPlan,
  buildContext,
  BUILD_CONTEXT_TAIL_TURNS,
  compactProviderMessages,
  isAgentTankMode,
  mergePlanQuestionFromAgent,
  newSession,
  normalizeFeatBranchName,
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
            id: "call_ready",
            name: "propose_plan_ready",
            argumentsDelta: JSON.stringify({
              suggestedBranch: "feat/foundation",
              summary: "Ready for confirmation",
            }),
            index: 0,
          };
          yield { type: "done" as const, finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "content" as const,
          delta: "Plan is ready — confirm in the IDE to start building.",
        };
        yield { type: "done" as const, finishReason: "stop" };
      },
    };

    const session = newSession("s-plan", "plan");
    const patches: string[] = [];
    const result = await runAgentTurn(session, "please draft a plan", {
      provider,
      onProgress: (e) => {
        if (e.type === "session_patch" && e.patch.planStatus) {
          patches.push(e.patch.planStatus);
        }
      },
    });

    expect(result.state.planPhases).toHaveLength(1);
    expect(result.state.planPhases[0]?.title).toBe("Foundation");
    expect(result.state.mode).toBe("plan");
    expect(result.state.planStatus).toBe("finalized");
    expect(result.state.planReadyProposal?.suggestedBranch).toBe(
      "feat/foundation",
    );
    expect(patches).toContain("drafting");
    expect(patches).toContain("finalized");
  });

  it("ignores checklist done flags while planning", () => {
    const applied = applyUpsertPlan(newSession("s-done", "plan"), {
      phases: [
        {
          title: "Foundation",
          status: "completed",
          checklist: [{ text: "Scaffold", done: true }],
        },
      ],
      questions: [],
    });
    expect(applied.state.planPhases[0]?.status).toBe("pending");
    expect(applied.state.planPhases[0]?.checklist[0]?.done).toBe(false);
  });

  it("build mode only allows done flags and phase status", () => {
    const base = {
      ...newSession("s-build-lock", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress" as const,
          checklist: [
            { id: "c1", text: "Scaffold", done: false },
            { id: "c2", text: "Tests", done: false },
          ],
        },
      ],
    };

    const ok = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: false },
          ],
        },
      ],
    });
    expect(ok.result.success).toBe(true);
    expect(ok.state.planPhases[0]?.checklist[0]?.done).toBe(true);
    expect(ok.state.planPhases[0]?.checklist[1]?.done).toBe(false);

    const rename = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Renamed",
          status: "completed",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: true },
          ],
        },
      ],
    });
    expect(rename.result.success).toBe(false);
    expect(rename.result.error).toBe("Structure locked");

    const addItem = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: false },
            { id: "c3", text: "Extra", done: false },
          ],
        },
      ],
    });
    expect(addItem.result.success).toBe(false);

    const addPhase = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "completed",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: true },
          ],
        },
        {
          id: "p2",
          title: "Extra phase",
          status: "pending",
          checklist: [{ id: "c9", text: "No", done: false }],
        },
      ],
    });
    expect(addPhase.result.success).toBe(false);
  });

  it("build mode rejects unchecking already-done items", () => {
    const base = {
      ...newSession("s-sticky", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress" as const,
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: false },
          ],
        },
      ],
    };

    const uncheck = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress",
          checklist: [
            { id: "c1", text: "Scaffold", done: false },
            { id: "c2", text: "Tests", done: false },
          ],
        },
      ],
    });
    expect(uncheck.result.success).toBe(false);
    expect(uncheck.result.error).toBe("Progress locked");
    expect(uncheck.state.planPhases[0]?.checklist[0]?.done).toBe(true);

    const advance = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "completed",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: true },
          ],
        },
      ],
    });
    expect(advance.result.success).toBe(true);
    expect(advance.state.planPhases[0]?.checklist.map((c) => c.done)).toEqual([
      true,
      true,
    ]);
  });

  it("build mode allows marking multiple newly finished checklist items per upsert", () => {
    const base = {
      ...newSession("s-one-check", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress" as const,
          checklist: [
            { id: "c1", text: "Scaffold", done: false },
            { id: "c2", text: "Tests", done: false },
            { id: "c3", text: "Docs", done: false },
          ],
        },
      ],
    };

    const batch = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "completed",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: true },
            { id: "c3", text: "Docs", done: true },
          ],
        },
      ],
    });
    expect(batch.result.success).toBe(true);
    expect(batch.state.planPhases[0]?.checklist.every((c) => c.done)).toBe(true);
    expect(batch.result.output).toMatchObject({
      newlyDone: [
        "Foundation → Scaffold",
        "Foundation → Tests",
        "Foundation → Docs",
      ],
    });

    const one = applyUpsertPlan(base, {
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "in_progress",
          checklist: [
            { id: "c1", text: "Scaffold", done: true },
            { id: "c2", text: "Tests", done: false },
            { id: "c3", text: "Docs", done: false },
          ],
        },
      ],
    });
    expect(one.result.success).toBe(true);
    expect(one.state.planPhases[0]?.checklist.map((c) => c.done)).toEqual([
      true,
      false,
      false,
    ]);
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

  it("propose_plan_ready then applyStartBuilding switches to build", () => {
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
    const proposed = applyProposePlanReady(session, {
      suggestedBranch: "User Auth Flow",
    });
    expect(proposed.result.success).toBe(true);
    expect(proposed.state.planReadyProposal?.suggestedBranch).toBe(
      "feat/user-auth-flow",
    );
    expect(normalizeFeatBranchName("feat/ok")).toBe("feat/ok");

    const started = applyStartBuilding(proposed.state);
    expect(started.error).toBeUndefined();
    expect(started.state.mode).toBe("agent");
    expect(started.state.planStatus).toBe("executing");
    expect(started.state.planReadyProposal).toBeNull();
    expect(started.state.testingConfirmedAt).toBeNull();
  });

  it("applyStartBuilding works after Check (planStatus checking)", () => {
    const session = {
      ...newSession("s-check", "plan"),
      mode: "agent" as const,
      planStatus: "checking" as const,
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "pending" as const,
          checklist: [{ id: "c1", text: "Do thing", done: false }],
        },
      ],
      planQuestions: [],
      planReadyProposal: {
        suggestedBranch: "feat/demo",
        proposedAt: new Date().toISOString(),
      },
      testGatePassedAt: new Date().toISOString(),
    };
    expect(isAgentTankMode(session)).toBe(false);
    const started = applyStartBuilding(session);
    expect(started.error).toBeUndefined();
    expect(started.state.planStatus).toBe("executing");
    expect(started.state.testGatePassedAt).toBeNull();
  });

  it("isAgentTankMode is false while Check awaits the IDE gate", () => {
    const awaiting = {
      ...newSession("s-check-tank", "agent"),
      mode: "agent" as const,
      planStatus: "checking" as const,
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "pending" as const,
          checklist: [{ id: "c1", text: "Do thing", done: false }],
        },
      ],
      planReadyProposal: {
        suggestedBranch: "feat/demo",
        proposedAt: new Date().toISOString(),
      },
      testRun: null,
      testGatePassedAt: null,
    };
    expect(isAgentTankMode(awaiting)).toBe(false);
    expect(
      isAgentTankMode({
        ...awaiting,
        testRun: {
          startedAt: new Date().toISOString(),
          status: "running",
          specs: [],
          suites: [],
        },
      }),
    ).toBe(false);
  });

  it("isAgentTankMode is true during Check only after a failed report", () => {
    const failed = {
      ...newSession("s-check-fail", "agent"),
      mode: "agent" as const,
      planStatus: "checking" as const,
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "pending" as const,
          checklist: [{ id: "c1", text: "Do thing", done: false }],
        },
      ],
      testGatePassedAt: null,
      testRun: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed" as const,
        specs: [],
        suites: [],
        digest: "fail",
      },
    };
    expect(isAgentTankMode(failed)).toBe(true);
  });

  it("isAgentTankMode stays off in Testing until a failed gate report", () => {
    const completePhases = [
      {
        id: "p1",
        title: "Phase 1",
        status: "completed" as const,
        checklist: [{ id: "c1", text: "Do thing", done: true }],
      },
    ];
    const awaitingConfirm = {
      ...newSession("s-test-await", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: completePhases,
      testingConfirmedAt: null,
      testRun: null,
    };
    expect(isAgentTankMode(awaitingConfirm)).toBe(false);

    const awaitingGate = {
      ...awaitingConfirm,
      testingConfirmedAt: new Date().toISOString(),
      testRun: null,
    };
    expect(isAgentTankMode(awaitingGate)).toBe(false);

    const failed = {
      ...awaitingGate,
      testRun: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed" as const,
        specs: [],
        suites: [],
        digest: "fail",
      },
    };
    expect(isAgentTankMode(failed)).toBe(true);

    expect(
      isAgentTankMode({ ...failed, testGateCircuitOpen: true }),
    ).toBe(false);
  });

  it("propose_testing_ready rejects open checklist and confirms when complete", () => {
    const open = {
      ...newSession("s-test-open", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "in_progress" as const,
          checklist: [{ id: "c1", text: "Do thing", done: false }],
        },
      ],
    };
    const rejected = applyProposeTestingReady(open, {});
    expect(rejected.result.success).toBe(false);
    expect(rejected.state.testingConfirmedAt).toBeNull();

    const complete = {
      ...open,
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "completed" as const,
          checklist: [{ id: "c1", text: "Do thing", done: true }],
        },
      ],
    };
    const ok = applyProposeTestingReady(complete, { summary: "Ready" });
    expect(ok.result.success).toBe(true);
    expect(ok.state.testingConfirmedAt).toBeTruthy();
  });

  it("plan micro CRUD clears readiness and edits by id/index", () => {
    let state = newSession("s-crud", "plan");
    const added = applyAddPhase(state, {
      title: "Data",
      checklist: ["Model openings", "Wire move engine"],
    });
    expect(added.result.success).toBe(true);
    state = added.state;
    expect(state.planPhases).toHaveLength(1);
    expect(state.planPhases[0]?.checklist).toHaveLength(2);

    const phaseId = state.planPhases[0]!.id;
    const more = applyAddCheck(state, {
      phaseId,
      text: "Tests",
      afterCheckIndex: 0,
    });
    expect(more.result.success).toBe(true);
    state = more.state;
    expect(state.planPhases[0]?.checklist.map((c) => c.text)).toEqual([
      "Model openings",
      "Tests",
      "Wire move engine",
    ]);

    const proposed = applyProposePlanReady(state, {
      suggestedBranch: "feat/crud",
    });
    expect(proposed.state.planReadyProposal).not.toBeNull();
    state = proposed.state;

    const renamed = applyReplaceCheck(state, {
      phaseIndex: 0,
      checkIndex: 1,
      text: "Unit tests",
    });
    expect(renamed.result.success).toBe(true);
    expect(renamed.state.planReadyProposal).toBeNull();
    expect(renamed.state.planStatus).toBe("drafting");
    state = renamed.state;

    const deleted = applyDeleteCheck(state, {
      phaseId,
      checkId: state.planPhases[0]!.checklist[0]!.id,
    });
    expect(deleted.result.success).toBe(true);
    expect(deleted.state.planPhases[0]?.checklist.map((c) => c.text)).toEqual([
      "Unit tests",
      "Wire move engine",
    ]);
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

  it("tank mode stops on provider error instead of retrying forever", async () => {
    let chatCalls = 0;
    const provider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat() {
        chatCalls += 1;
        yield {
          type: "error" as const,
          error: new AppError({
            code: "PROVIDER_ERROR",
            userMessage: "The AI provider returned an error.",
            technicalDetail: "HTTP 500",
          }),
        };
      },
    };

    const session = {
      ...newSession("s-tank-err", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Phase 1",
          status: "in_progress" as const,
          checklist: [
            { id: "c1", text: "Done item", done: true },
            { id: "c2", text: "Open item", done: false },
          ],
        },
      ],
    };

    const result = await runAgentTurn(session, "continue build", { provider });

    expect(chatCalls).toBe(1);
    expect(result.state.status).toBe("error");
    expect(result.state.error).toContain("The AI provider returned an error.");
    expect(result.state.error).toContain("HTTP 500");
    expect(
      result.state.turns.some((t) => t.content.includes("Build paused")),
    ).toBe(true);
  });

  it("buildContext keeps goal + short tail, not full chat history", () => {
    const turns = [];
    turns.push({
      id: "u0",
      role: "user" as const,
      content: "Build a news alert CLI",
      createdAt: new Date().toISOString(),
    });
    for (let i = 0; i < 40; i++) {
      turns.push({
        id: `a${i}`,
        role: "assistant" as const,
        content: `Old narration ${i}`,
        createdAt: new Date().toISOString(),
      });
      turns.push({
        id: `u${i + 1}`,
        role: "user" as const,
        content: `Follow-up ${i}`,
        createdAt: new Date().toISOString(),
      });
    }
    const session = {
      ...newSession("s-ctx", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Scaffold",
          status: "in_progress" as const,
          checklist: [
            { id: "c1", text: "Init package", done: true },
            { id: "c2", text: "Add fetch", done: false },
          ],
        },
      ],
      turns,
    };

    const ctx = buildContext(session, "keep going");
    const userContents = ctx
      .filter((t) => t.role === "user")
      .map((t) => t.content);
    expect(userContents.some((c) => c.includes("Build a news alert CLI"))).toBe(
      true,
    );
    expect(ctx.some((t) => t.content.includes("Old narration 0"))).toBe(false);
    expect(ctx.some((t) => t.content.includes("Focus"))).toBe(true);
    expect(ctx.some((t) => t.content.includes("Next open item: Add fetch"))).toBe(
      true,
    );
    // system + goal + <=10 history + current user
    expect(ctx.length).toBeLessThanOrEqual(1 + 1 + BUILD_CONTEXT_TAIL_TURNS + 1);
  });

  it("compactProviderMessages refreshes system and bounds the live tail", () => {
    const state = {
      ...newSession("s-compact", "agent"),
      mode: "agent" as const,
      planStatus: "executing" as const,
      planPhases: [
        {
          id: "p1",
          title: "Scaffold",
          status: "in_progress" as const,
          checklist: [{ id: "c1", text: "Ship it", done: false }],
        },
      ],
      turns: [
        {
          id: "u0",
          role: "user" as const,
          content: "Make the app",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    const bloated = [
      { role: "system" as const, content: "old system" },
      { role: "user" as const, content: "Original goal:\nstale" },
      ...Array.from({ length: 80 }, (_, i) => ({
        role: "user" as const,
        content: `noise ${i}`,
      })),
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          { id: "call_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
        ],
      },
      { role: "tool" as const, tool_call_id: "call_1", content: "ok" },
    ];
    const compacted = compactProviderMessages(bloated, state, 6);
    expect(compacted[0]?.role).toBe("system");
    expect(compacted[0]?.content).toContain("Next open item: Ship it");
    expect(
      compacted.some(
        (m) =>
          m.role === "user" &&
          chatContentText(m.content).includes("Make the app"),
      ),
    ).toBe(true);
    expect(compacted.length).toBeLessThanOrEqual(1 + 1 + 6);
    expect(compacted[compacted.length - 1]?.role).toBe("tool");
    expect(compacted[compacted.length - 2]?.role).toBe("assistant");
  });

  it("planning tank keeps going on prose until upsert_plan / questions / ready", async () => {
    let chatCalls = 0;
    const provider = {
      async listModels() {
        return [{ id: "mock" }];
      },
      cancel() {},
      async *chat() {
        chatCalls += 1;
        if (chatCalls < 3) {
          yield {
            type: "content" as const,
            delta: "I explored the repo and here is a long analysis with no tools.",
          };
          yield { type: "done" as const, finishReason: "stop" };
          return;
        }
        if (chatCalls === 3) {
          yield {
            type: "tool_call" as const,
            id: "call_plan",
            name: "upsert_plan",
            argumentsDelta: JSON.stringify({
              phases: [
                {
                  title: "Unit tests",
                  checklist: [
                    { text: "Add Jest config" },
                    { text: "Cover services" },
                  ],
                },
              ],
              questions: [
                {
                  text: "Which test runner?",
                  selection: "single",
                  options: [
                    { id: "jest", label: "Jest" },
                    { id: "vitest", label: "Vitest" },
                  ],
                },
              ],
            }),
            index: 0,
          };
          yield { type: "done" as const, finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "content" as const,
          delta: "Open the Plan Q&A dialog to answer.",
        };
        yield { type: "done" as const, finishReason: "stop" };
      },
    };

    const session = newSession("s-plan-tank", "plan");
    const result = await runAgentTurn(session, "define unit tests for current code", {
      provider,
    });

    expect(chatCalls).toBeGreaterThanOrEqual(3);
    expect(result.state.planPhases.length).toBe(1);
    expect(result.state.planQuestions.some((q) => q.status === "open")).toBe(true);
    expect(result.state.status).toBe("idle");
  });

  it("isAgentTankMode is true while planning without ready proposal or open Q&A", () => {
    const drafting = newSession("s-tank-plan", "plan");
    expect(isAgentTankMode(drafting)).toBe(true);

    const awaitingQa = {
      ...drafting,
      planQuestions: [
        {
          id: "q1",
          text: "Pick runner",
          selection: "single" as const,
          options: [{ id: "a", label: "A" }],
          status: "open" as const,
        },
      ],
    };
    expect(isAgentTankMode(awaitingQa)).toBe(false);

    const awaitingBuild = {
      ...drafting,
      planReadyProposal: {
        suggestedBranch: "feat/tests",
        summary: "ready",
        proposedAt: new Date().toISOString(),
      },
    };
    expect(isAgentTankMode(awaitingBuild)).toBe(false);
  });
});
