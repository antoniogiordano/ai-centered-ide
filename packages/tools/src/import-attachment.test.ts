import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import { createDefaultRegistry } from "./builtins.js";
import type { ToolExecutionContext } from "./gateway.js";

describe("import_attachment", () => {
  it("copies attachment bytes into the workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aifi-att-"));
    const registry = createDefaultRegistry();
    const tool = registry.get("import_attachment");
    expect(tool).toBeDefined();
    const bytes = Buffer.from("hello-attach");
    const ctx = {
      workspaceRoot: dir,
      mode: "agent" as const,
      grants: [],
      fs: new FilesystemService(dir),
      git: new GitService(dir),
      checkpoint: new CheckpointService(dir, join(dir, ".checkpoints")),
      audit: () => undefined,
      redact: (v: unknown) => v,
      approvedCategories: new Set(),
      attachments: {
        get: (id: string) =>
          id === "att1"
            ? {
                id: "att1",
                kind: "file" as const,
                name: "note.txt",
                mime: "text/plain",
                bytes,
              }
            : undefined,
        list: () => [
          { id: "att1", kind: "file" as const, name: "note.txt", mime: "text/plain" },
        ],
      },
    } satisfies ToolExecutionContext;

    const result = await tool!.execute(
      { attachmentId: "att1", destPath: "imports/note.txt" },
      ctx,
    );
    expect(result.summary).toContain("Imported note.txt");
    expect(readFileSync(join(dir, "imports/note.txt"), "utf8")).toBe(
      "hello-attach",
    );
    rmSync(dir, { recursive: true });
  });
});
