import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import type { AgentAskAnswer } from "./ask-host.js";
import { createDefaultRegistry } from "./builtins.js";
import type { ToolExecutionContext } from "./gateway.js";

function makeCtx(
  dir: string,
  answer?: AgentAskAnswer | (() => Promise<AgentAskAnswer>),
): ToolExecutionContext {
  return {
    workspaceRoot: dir,
    mode: "agent" as const,
    grants: [],
    fs: new FilesystemService(dir),
    git: new GitService(dir),
    checkpoint: new CheckpointService(dir, join(dir, ".checkpoints")),
    audit: () => undefined,
    redact: (v: unknown) => v,
    approvedCategories: new Set(),
    ...(answer
      ? {
          ask: {
            ask: async () =>
              typeof answer === "function" ? answer() : answer,
          },
        }
      : {}),
  } satisfies ToolExecutionContext;
}

const OPTIONS = [
  { id: "seed", label: "Seed localStorage in the tests" },
  { id: "env", label: "Disable the tour behind an env flag" },
];

describe("ask_user", () => {
  it("returns the user's choice inside the same tool result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-ask-"));
    const tool = createDefaultRegistry().get("ask_user");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        context: "The onboarding tour overlay blocks every Cypress click.",
        prompt: "How should we unblock the e2e suite?",
        options: OPTIONS,
      },
      makeCtx(dir, {
        selectedOptionIds: ["seed"],
        selectedLabels: ["Seed localStorage in the tests"],
        text: "",
        cancelled: false,
      }),
    );

    expect(result.summary).toContain("Seed localStorage in the tests");
    expect(result.output).toMatchObject({
      asked: true,
      cancelled: false,
      selectedOptionIds: ["seed"],
    });
    rmSync(dir, { recursive: true });
  });

  it("blocks until the host resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-ask-"));
    const tool = createDefaultRegistry().get("ask_user");
    let resolved = false;

    const promise = tool!.execute(
      { prompt: "Which fix?", options: OPTIONS },
      makeCtx(dir, async () => {
        await new Promise((r) => setTimeout(r, 20));
        resolved = true;
        return {
          selectedOptionIds: ["env"],
          selectedLabels: ["Disable the tour behind an env flag"],
          text: "",
          cancelled: false,
        };
      }),
    );

    expect(resolved).toBe(false);
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result.summary).toContain("env flag");
    rmSync(dir, { recursive: true });
  });

  it("tells the agent to decide alone when the user skips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-ask-"));
    const tool = createDefaultRegistry().get("ask_user");

    const result = await tool!.execute(
      { prompt: "Which fix?", options: OPTIONS },
      makeCtx(dir, {
        selectedOptionIds: [],
        selectedLabels: [],
        text: "",
        cancelled: true,
      }),
    );

    expect(result.output).toMatchObject({ cancelled: true });
    expect(JSON.stringify(result.output)).toContain("reversible");
    rmSync(dir, { recursive: true });
  });

  it("degrades gracefully with no interactive host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aici-ask-"));
    const tool = createDefaultRegistry().get("ask_user");

    const result = await tool!.execute(
      { prompt: "Which fix?", options: OPTIONS },
      makeCtx(dir),
    );

    expect(result.output).toMatchObject({ asked: false });
    rmSync(dir, { recursive: true });
  });

  it("is not offered while planning, where set_questions owns the dialog", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("ask_user")?.phases).toEqual([
      "checking",
      "building",
      "testing",
    ]);
    expect(
      registry.listForPhase("planning").map((t) => t.name),
    ).not.toContain("ask_user");
    expect(
      registry.listForPhase("building").map((t) => t.name),
    ).toContain("ask_user");
  });
});
