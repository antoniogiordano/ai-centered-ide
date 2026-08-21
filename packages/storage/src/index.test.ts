import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "./config.js";
import { getSchemaVersion, openDatabase, ProjectStorage } from "./database.js";

describe("ConfigStore precedence", () => {
  it("merges global < workspace < project", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-config-"));
    const globalPath = join(dir, "global.json");
    const workspacePath = join(dir, "workspace.json");
    const projectPath = join(dir, "project.json");

    writeFileSync(globalPath, JSON.stringify({ theme: "dark", model: "a" }));
    writeFileSync(workspacePath, JSON.stringify({ model: "b" }));
    writeFileSync(projectPath, JSON.stringify({ model: "c" }));

    const store = new ConfigStore({
      global: globalPath,
      workspace: workspacePath,
      project: projectPath,
    });

    expect(store.read()).toEqual({ theme: "dark", model: "c" });
    rmSync(dir, { recursive: true });
  });
});

describe("database migrations", () => {
  it("creates schema at version 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    expect(getSchemaVersion(db)).toBe(3);
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("purges project data", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const storage = new ProjectStorage(db);
    storage.insertAudit({
      id: "a1",
      projectId: "p1",
      action: "tool",
      createdAt: new Date().toISOString(),
    });
    storage.purgeProject("p1");
    const count = db
      .prepare("SELECT COUNT(*) as c FROM audit WHERE project_id = ?")
      .get("p1") as { c: number };
    expect(count.c).toBe(0);
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("opens existing database without corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const dbPath = join(dir, "test.sqlite");
    const first = openDatabase(dbPath);
    first.close();
    const second = openDatabase(dbPath);
    expect(getSchemaVersion(second)).toBe(3);
    second.close();
    rmSync(dir, { recursive: true });
  });

  it("persists conversations and turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    const storage = new ProjectStorage(db);
    const now = new Date().toISOString();
    storage.upsertConversation({
      id: "c1",
      projectId: "p1",
      title: "Hello world",
      mode: "ask",
      workspace: null,
      planSteps: [],
      planPhases: [],
      planStatus: "drafting",
      planQuestions: [],
      planReadyProposal: null,
      sessionKind: "delivery",
      approvalGrants: [],
      createdAt: now,
      updatedAt: now,
    });
    storage.replaceTurns("c1", [
      {
        id: "t1",
        role: "user",
        content: "Hello world",
        createdAt: now,
      },
    ]);
    const listed = storage.listConversations();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Hello world");
    expect(storage.loadTurns("c1")).toHaveLength(1);
    storage.deleteConversation("c1");
    expect(storage.listConversations()).toHaveLength(0);
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("round-trips the blocking human setup checklist", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const db = openDatabase(join(dir, "test.sqlite"));
    const storage = new ProjectStorage(db);
    const now = new Date().toISOString();
    storage.upsertConversation({
      id: "c1",
      projectId: "p1",
      title: "Setup",
      mode: "agent",
      workspace: null,
      planSteps: [],
      planPhases: [],
      planStatus: "executing",
      planQuestions: [],
      planReadyProposal: null,
      sessionKind: "delivery",
      approvalGrants: [],
      humanSetup: {
        id: "h1",
        reason: "e2e cannot reach the database",
        items: [
          {
            id: "i1",
            title: "Paste the e2e connection string",
            detail: "",
            envFile: ".env.e2e",
            envKeys: ["DATABASE_URL"],
            envKeysPresent: [],
            docUrl: null,
            done: false,
          },
        ],
        createdAt: now,
        checkedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });

    const loaded = storage.getConversation("c1");
    expect(loaded?.humanSetup?.items[0]?.envKeys).toEqual(["DATABASE_URL"]);
    expect(loaded?.humanSetup?.items[0]?.envKeysPresent).toEqual([]);
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("round-trips session chrome notices", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const db = openDatabase(join(dir, "test.sqlite"));
    const storage = new ProjectStorage(db);
    const now = new Date().toISOString();
    storage.upsertConversation({
      id: "c1",
      projectId: "p1",
      title: "Vision",
      mode: "agent",
      workspace: null,
      planSteps: [],
      planPhases: [],
      planStatus: "executing",
      planQuestions: [],
      planReadyProposal: null,
      sessionKind: "delivery",
      approvalGrants: [],
      notices: [
        {
          id: "harness:vision-downgrade",
          kind: "error",
          title: "Images were not sent",
          detail: "deepseek-v4-flash refused them",
          blocking: true,
          expiresAt: null,
          createdAt: now,
          source: "harness",
          action: "switch_model",
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    const loaded = storage.getConversation("c1");
    expect(loaded?.notices).toHaveLength(1);
    expect(loaded?.notices[0]?.id).toBe("harness:vision-downgrade");
    expect(loaded?.notices[0]?.action).toBe("switch_model");
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("round-trips the chain of thought without a schema change", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const db = openDatabase(join(dir, "test.sqlite"));
    const storage = new ProjectStorage(db);
    const now = new Date().toISOString();
    storage.upsertConversation({
      id: "c1",
      projectId: "p1",
      title: "Thinking",
      mode: "agent",
      workspace: null,
      planSteps: [],
      planPhases: [],
      planStatus: "drafting",
      planQuestions: [],
      planReadyProposal: null,
      sessionKind: "delivery",
      approvalGrants: [],
      createdAt: now,
      updatedAt: now,
    });
    storage.replaceTurns("c1", [
      {
        id: "t1",
        role: "assistant",
        content: "Done.",
        reasoning: "Weighed two options, picked the simpler one.",
        createdAt: now,
      },
      { id: "t2", role: "assistant", content: "No thoughts.", createdAt: now },
    ]);

    const loaded = storage.loadTurns("c1");
    expect(loaded[0]?.reasoning).toBe(
      "Weighed two options, picked the simpler one.",
    );
    // Turns from providers that stream no reasoning stay clean rather than
    // carrying an empty string around.
    expect(loaded[1]?.reasoning).toBeUndefined();
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("persists session analytics logs after the conversation is closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-db-"));
    const db = openDatabase(join(dir, "test.sqlite"));
    const storage = new ProjectStorage(db);
    const now = new Date().toISOString();
    storage.upsertSessionLog({
      sessionId: "s1",
      projectId: "p1",
      title: "Roman icons",
      workspaceName: "chess-openings",
      startedAt: now,
      endedAt: now,
      updatedAt: now,
      outcome: "commit",
      outcomeDetail: "feat/roman-svg-icons",
      featBranch: "feat/roman-svg-icons",
      buildBaseBranch: "main",
      models: [
        {
          model: "deepseek-v4-pro",
          providerId: "p",
          providerName: "DeepSeek",
          paid: true,
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 0,
          costUsd: 0.002,
          pricing: {
            model: "deepseek-v4-pro",
            providerId: "p",
            providerName: "DeepSeek",
            paid: true,
            inputPer1M: 0.14,
            outputPer1M: 0.28,
            capturedAt: now,
          },
        },
      ],
      phases: [],
      errors: [],
    });
    expect(storage.getSessionLog("s1")?.outcome).toBe("commit");
    expect(storage.listSessionLogs("p1")).toHaveLength(1);
    storage.deleteConversation("s1");
    expect(storage.getSessionLog("s1")?.title).toBe("Roman icons");
    storage.purgeProject("p1");
    expect(storage.getSessionLog("s1")).toBeNull();
    db.close();
    rmSync(dir, { recursive: true });
  });
});
