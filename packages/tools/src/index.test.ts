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

  it("requires approval for unknown commands", () => {
    expect(analyzeCommand("curl https://evil.com").needsApproval).toBe(true);
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
      ]),
    );
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("git_status");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("terminal_open");
  });

  it("building exposes implementation tools", () => {
    const registry = createDefaultRegistry();
    const names = registry.listForPhase("building").map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "write_file",
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
      ]),
    );
    expect(names).not.toContain("propose_plan_ready");
    expect(names).not.toContain("add_phase");
    expect(names).not.toContain("set_questions");
  });
});
