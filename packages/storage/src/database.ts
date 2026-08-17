import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentMode,
  ApprovalGrant,
  PlanPhase,
  PlanQuestion,
  PlanReadyProposal,
  PlanStatus,
  PlanStep,
  SessionKind,
  SessionModelUsage,
  Turn,
  WorkspaceRef,
} from "@ai-ide/shared";
import { backupFile } from "./config.js";

export const CURRENT_SCHEMA_VERSION = 2;

type Migration = {
  version: number;
  up: (db: Database.Database) => void;
};

const migrations: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          payload_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
        CREATE TABLE IF NOT EXISTS audit (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          tool_name TEXT,
          action TEXT NOT NULL,
          payload_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS artifacts_index (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checkpoints_index (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          label TEXT,
          paths_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS preferences (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'ask';
        ALTER TABLE conversations ADD COLUMN workspace_json TEXT;
        ALTER TABLE conversations ADD COLUMN meta_json TEXT;
      `);
    },
  },
];

export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db, dbPath);
  return db;
}

export function migrate(db: Database.Database, dbPath: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `);

  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1")
    .get() as { version: number } | undefined;

  const current = row?.version ?? 0;

  if (current < CURRENT_SCHEMA_VERSION && existsSync(dbPath)) {
    backupFile(dbPath);
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(
        migration.version,
      );
    })();
  }
}

export class ProjectStorage {
  constructor(private readonly db: Database.Database) {}

  purgeProject(projectId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)")
        .run(projectId);
      this.db.prepare("DELETE FROM conversations WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM audit WHERE project_id = ?").run(projectId);
      this.db
        .prepare("DELETE FROM artifacts_index WHERE project_id = ?")
        .run(projectId);
      this.db
        .prepare("DELETE FROM checkpoints_index WHERE project_id = ?")
        .run(projectId);
    })();
  }

  insertAudit(entry: {
    id: string;
    projectId: string;
    toolName?: string;
    action: string;
    payload?: unknown;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit (id, project_id, tool_name, action, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.projectId,
        entry.toolName ?? null,
        entry.action,
        entry.payload ? JSON.stringify(entry.payload) : null,
        entry.createdAt,
      );
  }

  listAudit(projectId: string): Array<{
    id: string;
    projectId: string;
    toolName: string | null;
    action: string;
    payloadJson: string;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id as projectId, tool_name as toolName, action,
                COALESCE(payload_json, '{}') as payloadJson, created_at as createdAt
         FROM audit WHERE project_id = ? ORDER BY created_at DESC LIMIT 500`,
      )
      .all(projectId) as Array<{
      id: string;
      projectId: string;
      toolName: string | null;
      action: string;
      payloadJson: string;
      createdAt: string;
    }>;
    return rows;
  }

  setPreference(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO preferences (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }

  getPreference<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value_json FROM preferences WHERE key = ?")
      .get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value_json) as T;
  }

  upsertConversation(row: {
    id: string;
    projectId: string;
    title: string;
    mode: AgentMode;
    workspace: WorkspaceRef | null;
    planSteps: PlanStep[];
    planPhases: PlanPhase[];
    planStatus: PlanStatus;
    planQuestions: PlanQuestion[];
    planReadyProposal: PlanReadyProposal | null;
    buildBaseBranch?: string | null;
  buildFlowCompletedAt?: string | null;
  sessionKind: SessionKind;
  approvalGrants: ApprovalGrant[];
  sessionModelUsage?: SessionModelUsage[];
  contextSummary?: string | null;
  contextCompactionCount?: number;
  agentHistoryPath?: string | null;
  createdAt: string;
  updatedAt: string;
}): void {
    this.db
      .prepare(
        `INSERT INTO conversations (
           id, project_id, title, created_at, updated_at, mode, workspace_json, meta_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           title = excluded.title,
           updated_at = excluded.updated_at,
           mode = excluded.mode,
           workspace_json = excluded.workspace_json,
           meta_json = excluded.meta_json`,
      )
      .run(
        row.id,
        row.projectId,
        row.title,
        row.createdAt,
        row.updatedAt,
        row.mode,
        row.workspace ? JSON.stringify(row.workspace) : null,
        JSON.stringify({
          planSteps: row.planSteps,
          planPhases: row.planPhases,
          planStatus: row.planStatus,
          planQuestions: row.planQuestions,
          planReadyProposal: row.planReadyProposal,
          buildBaseBranch: row.buildBaseBranch ?? null,
          buildFlowCompletedAt: row.buildFlowCompletedAt ?? null,
          sessionKind: row.sessionKind,
          approvalGrants: row.approvalGrants,
          sessionModelUsage: row.sessionModelUsage ?? [],
          contextSummary: row.contextSummary ?? null,
          contextCompactionCount: row.contextCompactionCount ?? 0,
          agentHistoryPath: row.agentHistoryPath ?? null,
        }),
      );
  }

  listConversations(): Array<{
    id: string;
    projectId: string;
    title: string;
    mode: AgentMode;
    workspace: WorkspaceRef | null;
    planSteps: PlanStep[];
    planPhases: PlanPhase[];
    planStatus: PlanStatus;
    planQuestions: PlanQuestion[];
    planReadyProposal: PlanReadyProposal | null;
    buildBaseBranch: string | null;
    buildFlowCompletedAt: string | null;
    sessionKind: SessionKind;
    approvalGrants: ApprovalGrant[];
    sessionModelUsage: SessionModelUsage[];
    contextSummary: string | null;
    contextCompactionCount: number;
    agentHistoryPath: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, project_id as projectId, COALESCE(title, 'New chat') as title,
                created_at as createdAt, updated_at as updatedAt,
                COALESCE(mode, 'plan') as mode,
                workspace_json as workspaceJson,
                meta_json as metaJson
         FROM conversations
         ORDER BY created_at ASC`,
      )
      .all() as Array<{
      id: string;
      projectId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      mode: AgentMode;
      workspaceJson: string | null;
      metaJson: string | null;
    }>;

    return rows.map((row) => {
      const meta = row.metaJson
        ? (JSON.parse(row.metaJson) as {
            planSteps?: PlanStep[];
            planPhases?: PlanPhase[];
            planStatus?: PlanStatus;
            planQuestions?: PlanQuestion[];
            planReadyProposal?: PlanReadyProposal | null;
            buildBaseBranch?: string | null;
            buildFlowCompletedAt?: string | null;
            sessionKind?: SessionKind;
            approvalGrants?: ApprovalGrant[];
            sessionModelUsage?: SessionModelUsage[];
            contextSummary?: string | null;
            contextCompactionCount?: number;
            agentHistoryPath?: string | null;
          })
        : {};
      return {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        mode: row.mode === "ask" ? "plan" : row.mode,
        workspace: row.workspaceJson
          ? (JSON.parse(row.workspaceJson) as WorkspaceRef)
          : null,
        planSteps: meta.planSteps ?? [],
        planPhases: meta.planPhases ?? [],
        planStatus: meta.planStatus ?? "drafting",
        planQuestions: meta.planQuestions ?? [],
        planReadyProposal: meta.planReadyProposal ?? null,
        buildBaseBranch: meta.buildBaseBranch ?? null,
        buildFlowCompletedAt: meta.buildFlowCompletedAt ?? null,
        sessionKind: meta.sessionKind ?? "delivery",
        approvalGrants: meta.approvalGrants ?? [],
        sessionModelUsage: meta.sessionModelUsage ?? [],
        contextSummary: meta.contextSummary ?? null,
        contextCompactionCount: meta.contextCompactionCount ?? 0,
        agentHistoryPath: meta.agentHistoryPath ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  getConversation(id: string): {
    id: string;
    projectId: string;
    title: string;
    mode: AgentMode;
    workspace: WorkspaceRef | null;
    planSteps: PlanStep[];
    planPhases: PlanPhase[];
    planStatus: PlanStatus;
    planQuestions: PlanQuestion[];
    planReadyProposal: PlanReadyProposal | null;
    buildBaseBranch: string | null;
    buildFlowCompletedAt: string | null;
    sessionKind: SessionKind;
    approvalGrants: ApprovalGrant[];
    sessionModelUsage: SessionModelUsage[];
    contextSummary: string | null;
    contextCompactionCount: number;
    agentHistoryPath: string | null;
    createdAt: string;
    updatedAt: string;
  } | null {
    return this.listConversations().find((c) => c.id === id) ?? null;
  }

  deleteConversation(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    })();
  }

  replaceTurns(conversationId: string, turns: Turn[]): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM turns WHERE conversation_id = ?")
        .run(conversationId);
      const insert = this.db.prepare(
        `INSERT INTO turns (id, conversation_id, role, content, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const turn of turns) {
        const payload =
          turn.toolCalls || turn.toolResults
            ? JSON.stringify({
                toolCalls: turn.toolCalls,
                toolResults: turn.toolResults,
              })
            : null;
        insert.run(
          turn.id,
          conversationId,
          turn.role,
          turn.content,
          payload,
          turn.createdAt,
        );
      }
    })();
  }

  loadTurns(conversationId: string): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT id, role, content, payload_json as payloadJson, created_at as createdAt
         FROM turns WHERE conversation_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId) as Array<{
      id: string;
      role: Turn["role"];
      content: string;
      payloadJson: string | null;
      createdAt: string;
    }>;

    return rows.map((row) => {
      const payload = row.payloadJson
        ? (JSON.parse(row.payloadJson) as {
            toolCalls?: Turn["toolCalls"];
            toolResults?: Turn["toolResults"];
          })
        : {};
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.createdAt,
        ...(payload.toolCalls ? { toolCalls: payload.toolCalls } : {}),
        ...(payload.toolResults ? { toolResults: payload.toolResults } : {}),
      };
    });
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1")
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}
