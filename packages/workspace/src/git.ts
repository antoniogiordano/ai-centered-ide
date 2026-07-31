import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { assertInsideWorkspace } from "./perimeter.js";
import { isEnvFile } from "./filesystem.js";

export class GitService {
  private readonly git;

  constructor(private readonly workspaceRoot: string) {
    this.git = simpleGit(workspaceRoot);
  }

  async status(): Promise<{ current: string; modified: string[]; not_added: string[] }> {
    const result = await this.git.status();
    return {
      current: result.current ?? "HEAD",
      modified: result.modified,
      not_added: result.not_added,
    };
  }

  async diff(staged = false): Promise<string> {
    return staged ? this.git.diff(["--cached"]) : this.git.diff();
  }

  async stage(paths: string[]): Promise<void> {
    for (const p of paths) {
      assertInsideWorkspace(this.workspaceRoot, p);
    }
    await this.git.add(paths);
  }

  async unstage(paths: string[]): Promise<void> {
    for (const p of paths) {
      assertInsideWorkspace(this.workspaceRoot, p);
    }
    await this.git.reset(["HEAD", ...paths]);
  }

  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message);
    return result.commit;
  }
}

export type CheckpointRecord = {
  id: string;
  label?: string;
  paths: string[];
  createdAt: string;
};

export class CheckpointService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly storageDir: string,
  ) {}

  create(id: string, touchedPaths: string[], label?: string): CheckpointRecord {
    const checkpointDir = join(this.storageDir, id);
    mkdirSync(checkpointDir, { recursive: true });
    const stored: string[] = [];

    for (const rel of touchedPaths) {
      if (isEnvFile(rel)) continue;
      const abs = assertInsideWorkspace(this.workspaceRoot, rel);
      if (!existsSync(abs)) continue;
      const dest = join(checkpointDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(abs, dest);
      stored.push(rel);
    }

    const record: CheckpointRecord = {
      id,
      paths: stored,
      createdAt: new Date().toISOString(),
    };
    if (label !== undefined) record.label = label;
    return record;
  }

  restore(record: CheckpointRecord): void {
    const checkpointDir = join(this.storageDir, record.id);
    for (const rel of record.paths) {
      const src = join(checkpointDir, rel);
      const dest = assertInsideWorkspace(this.workspaceRoot, rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
  }

  delete(id: string): void {
    const checkpointDir = join(this.storageDir, id);
    if (existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
  }
}
