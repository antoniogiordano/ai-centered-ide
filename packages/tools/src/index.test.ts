import { describe, expect, it } from "vitest";
import type { AgentMode } from "@ai-ide/shared";
import {
  analyzeCommand,
  evaluatePolicy,
  getToolRisk,
  READONLY_COMMAND_ALLOWLIST,
  COMMAND_DENYLIST,
} from "./policy.js";
import { createDefaultRegistry } from "./builtins.js";
import type { ToolExecutionContext } from "./gateway.js";

describe("policy matrix", () => {
  it("ask allows only safe tools", () => {
    expect(
      evaluatePolicy({ mode: "ask", toolName: "read_file", grants: [] }).allowed,
    ).toBe(true);
    expect(evaluatePolicy({ mode: "ask", toolName: "write_file", grants: [] })).toEqual(
      expect.objectContaining({ allowed: false }),
    );
  });

  it("autonomous requires approval for destructive", () => {
    const decision = evaluatePolicy({
      mode: "autonomous",
      toolName: "delete_all",
      riskLevel: "destructive",
      grants: [],
      category: "destructive",
    });
    expect("requiresApproval" in decision && decision.requiresApproval).toBe(true);
  });

  it("classifies tool risk", () => {
    expect(getToolRisk("read_file")).toBe("safe");
    expect(getToolRisk("import_attachment")).toBe("safe");
    expect(getToolRisk("git_commit")).toBe("sensitive");
  });

  it("has non-empty denylist and allowlist", () => {
    expect(COMMAND_DENYLIST.length).toBeGreaterThan(0);
    expect(READONLY_COMMAND_ALLOWLIST.length).toBeGreaterThan(0);
  });
});

describe("command analysis", () => {
  const modes: AgentMode[] = ["ask", "plan", "agent", "autonomous"];

  it("blocks rm -rf variants", () => {
    expect(analyzeCommand("rm -rf /").blocked).toBe(true);
  });

  it("allowlists git status", () => {
    expect(analyzeCommand("git status").allowlisted).toBe(true);
  });

  it("lets commands outside the allowlist through to the mode matrix", () => {
    const analysis = analyzeCommand("curl https://evil.com");
    expect(analysis.blocked).toBe(false);
    expect(analysis.allowlisted).toBe(false);
  });

  it("defines matrix for every mode", () => {
    for (const mode of modes) {
      expect(evaluatePolicy({ mode, toolName: "read_file", grants: [] })).toBeDefined();
    }
  });
});

describe("phase tool gating", () => {
  it("planning exposes reads/plan tools but not write/git/commands", () => {
    const registry = createDefaultRegistry();
    const names = registry.listForPhase("planning").map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_dir",
        "read_file",
        "search_text",
        "upsert_plan",
        "read_plan",
        "add_phase",
        "replace_phase",
        "delete_phase",
        "add_check",
        "replace_check",
        "delete_check",
        "set_questions",
        "propose_plan_ready",
        "read_architecture",
        "upsert_architecture",
        "import_attachment",
        "web_fetch",
        "web_search",
      ]),
    );
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("replace_in_file");
    expect(names).not.toContain("git_status");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("terminal_open");
    expect(names).not.toContain("get_test_report");
    expect(names).not.toContain("checkpoint_restore");
  });

  it("building exposes implementation tools but not test-report tools", () => {
    const registry = createDefaultRegistry();
    const names = registry.listForPhase("building").map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "write_file",
        "replace_in_file",
        "import_attachment",
        "web_fetch",
        "web_search",
        "git_status",
        "run_command",
        "terminal_open",
        "terminal_write",
        "terminal_ask",
        "terminal_read",
        "search_graph",
        "get_code_snippet",
        "upsert_plan",
        "propose_testing_ready",
        "read_architecture",
        "checkpoint_restore",
      ]),
    );
    expect(names).not.toContain("propose_plan_ready");
    expect(names).not.toContain("add_phase");
    expect(names).not.toContain("set_questions");
    expect(names).not.toContain("get_test_report");
    expect(names).not.toContain("list_failed_tests");
    expect(names).not.toContain("read_test_log");
  });

  it("checking exposes report + fix tools like testing (plan frozen)", () => {
    const registry = createDefaultRegistry();
    const names = registry.listForPhase("checking").map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "read_plan",
        "get_test_report",
        "list_failed_tests",
        "read_test_log",
        "replace_in_file",
        "write_file",
        "run_command",
        "terminal_open",
        "git_status",
        "read_file",
        "search_graph",
      ]),
    );
    expect(names).not.toContain("upsert_plan");
    expect(names).not.toContain("propose_plan_ready");
    expect(names).not.toContain("propose_testing_ready");
    expect(names).not.toContain("checkpoint_restore");
  });

  it("testing exposes report + fix tools but freezes plan and checkpoints", () => {
    const registry = createDefaultRegistry();
    const names = registry.listForPhase("testing").map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "read_plan",
        "get_test_report",
        "list_failed_tests",
        "read_test_log",
        "replace_in_file",
        "write_file",
        "run_command",
        "terminal_open",
        "git_status",
        "read_file",
        "search_graph",
      ]),
    );
    expect(names).not.toContain("upsert_plan");
    expect(names).not.toContain("add_phase");
    expect(names).not.toContain("replace_phase");
    expect(names).not.toContain("delete_phase");
    expect(names).not.toContain("add_check");
    expect(names).not.toContain("replace_check");
    expect(names).not.toContain("delete_check");
    expect(names).not.toContain("set_questions");
    expect(names).not.toContain("propose_plan_ready");
    expect(names).not.toContain("checkpoint_restore");
    expect(names).toContain("propose_testing_ready");
  });
});

describe("request_human_setup", () => {
  const registry = createDefaultRegistry();
  const tool = registry.get("request_human_setup");

  function ctx(overrides: Partial<ToolExecutionContext> = {}) {
    return {
      workspaceRoot: "/tmp/ws",
      mode: "agent" as AgentMode,
      grants: [],
      audit: () => undefined,
      redact: (value: unknown) => value,
      approvedCategories: new Set(),
      ...overrides,
    } as unknown as ToolExecutionContext;
  }

  const args = {
    reason: "e2e cannot reach the database: getaddrinfo ENOTFOUND",
    items: [
      {
        title: "Create the Neon e2e branch and paste its connection string",
        envFile: ".env.e2e",
        envKeys: ["DATABASE_URL"],
      },
    ],
  };

  it("is offered after planning only", () => {
    expect(registry.listForPhase("planning").map((t) => t.name)).not.toContain(
      "request_human_setup",
    );
    for (const phase of ["checking", "building", "testing"] as const) {
      expect(registry.listForPhase(phase).map((t) => t.name)).toContain(
        "request_human_setup",
      );
    }
    expect(getToolRisk("request_human_setup")).toBe("safe");
  });

  it("declares the checklist through the host", async () => {
    const calls: unknown[] = [];
    const result = await tool?.execute(
      args,
      ctx({
        humanSetup: {
          declare: async (input) => {
            calls.push(input);
            return {
              items: [
                {
                  id: "i1",
                  title: input.items[0]!.title,
                  envFile: ".env.e2e",
                  presentKeys: [],
                  missingKeys: ["DATABASE_URL"],
                  satisfied: false,
                },
              ],
              allSatisfied: false,
            };
          },
        },
      }),
    );
    expect(calls).toHaveLength(1);
    const output = result?.output as {
      declared: boolean;
      allSatisfied: boolean;
      hint: string;
    };
    expect(output.declared).toBe(true);
    // declared && !allSatisfied is what makes the agent loop end the turn.
    expect(output.allSatisfied).toBe(false);
    expect(output.hint).toContain("ended your turn");
  });

  it("tells the agent to keep going when the keys are already there", async () => {
    const result = await tool?.execute(
      args,
      ctx({
        humanSetup: {
          declare: async () => ({
            items: [
              {
                id: "i1",
                title: "t",
                envFile: ".env.e2e",
                presentKeys: ["DATABASE_URL"],
                missingKeys: [],
                satisfied: true,
              },
            ],
            allSatisfied: true,
          }),
        },
      }),
    );
    const output = result?.output as { allSatisfied: boolean; hint: string };
    expect(output.allSatisfied).toBe(true);
    expect(output.hint).toContain("retry");
  });

  it("refuses to invent secrets when there is no human", async () => {
    const result = await tool?.execute(args, ctx());
    const output = result?.output as { declared: boolean; error: string };
    expect(output.declared).toBe(false);
    expect(output.error).toContain("do not invent secrets");
  });
});

describe("post_notice", () => {
  const registry = createDefaultRegistry();
  const tool = registry.get("post_notice");

  function ctx(overrides: Partial<ToolExecutionContext> = {}) {
    return {
      workspaceRoot: "/tmp/ws",
      mode: "agent" as AgentMode,
      grants: [],
      audit: () => undefined,
      redact: (value: unknown) => value,
      approvedCategories: new Set(),
      ...overrides,
    } as unknown as ToolExecutionContext;
  }

  it("is offered in every product phase", () => {
    for (const phase of ["planning", "checking", "building", "testing"] as const) {
      expect(registry.listForPhase(phase).map((t) => t.name)).toContain(
        "post_notice",
      );
    }
    expect(getToolRisk("post_notice")).toBe("safe");
  });

  it("posts a blocking banner through the host", async () => {
    const calls: unknown[] = [];
    const result = await tool?.execute(
      {
        kind: "error",
        title: "Images were not sent",
        detail: "The model refused image_url.",
        blocking: true,
      },
      ctx({
        notice: {
          post: async (input) => {
            calls.push(input);
            return { id: "n1", expiresAt: null };
          },
        },
      }),
    );
    expect(calls).toEqual([
      {
        kind: "error",
        title: "Images were not sent",
        detail: "The model refused image_url.",
        blocking: true,
      },
    ]);
    const output = result?.output as {
      posted: boolean;
      blocking: boolean;
      hint: string;
    };
    expect(output.posted).toBe(true);
    expect(output.blocking).toBe(true);
    expect(output.hint).toContain("ended this turn");
  });

  it("falls back when there is no chrome host", async () => {
    const result = await tool?.execute(
      { kind: "warning", title: "Look at this" },
      ctx(),
    );
    const output = result?.output as { posted: boolean; error: string };
    expect(output.posted).toBe(false);
    expect(output.error).toContain("No notice host");
  });
});
