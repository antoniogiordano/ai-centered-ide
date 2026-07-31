import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "./config.js";
import { getSchemaVersion, openDatabase, ProjectStorage } from "./database.js";

describe("ConfigStore precedence", () => {
  it("merges global < workspace < project", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-config-"));
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
  it("creates schema at version 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-db-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase(dbPath);
    expect(getSchemaVersion(db)).toBe(2);
    db.close();
    rmSync(dir, { recursive: true });
  });

  it("purges project data", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-db-"));
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
    const dir = mkdtempSync(join(tmpdir(), "aifi-db-"));
    const dbPath = join(dir, "test.sqlite");
    const first = openDatabase(dbPath);
    first.close();
    const second = openDatabase(dbPath);
    expect(getSchemaVersion(second)).toBe(2);
    second.close();
    rmSync(dir, { recursive: true });
  });

  it("persists conversations and turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-db-"));
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
});
