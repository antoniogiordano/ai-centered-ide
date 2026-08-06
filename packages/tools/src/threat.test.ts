import { describe, expect, it } from "vitest";
import {
  analyzeCommand,
  evaluatePolicy,
  COMMAND_DENYLIST,
  isShellFileInspectionCommand,
} from "./policy.js";
import { defaultRedact } from "./gateway.js";

describe("threat model: tool gateway", () => {
  it("denylist is non-empty and blocks force push / rm -rf / sudo", () => {
    expect(COMMAND_DENYLIST.length).toBeGreaterThan(5);
    expect(analyzeCommand("git push --force origin main").blocked).toBe(true);
    expect(analyzeCommand("rm -rf /").blocked).toBe(true);
    expect(analyzeCommand("sudo apt install x").blocked).toBe(true);
  });

  it("Ask mode cannot write files", () => {
    const decision = evaluatePolicy({
      mode: "ask",
      toolName: "write_file",
      grants: [],
    });
    expect(decision.allowed).toBe(false);
  });

  it("Autonomous still requires approval for destructive risk", () => {
    const decision = evaluatePolicy({
      mode: "autonomous",
      toolName: "run_command",
      riskLevel: "destructive",
      grants: [],
      category: "destructive",
    });
    expect("requiresApproval" in decision && decision.requiresApproval).toBe(true);
  });

  it("blocks shell cat/ls/find used as a file browser", () => {
    expect(isShellFileInspectionCommand("ls -la")).toBe(true);
    expect(
      isShellFileInspectionCommand(
        "cat app/layout.tsx && echo '===' && cat app/globals.css",
      ),
    ).toBe(true);
    expect(isShellFileInspectionCommand("find . -name '*.ts'")).toBe(true);
    expect(isShellFileInspectionCommand("pnpm install")).toBe(false);
    expect(isShellFileInspectionCommand("npm ls")).toBe(false);
    expect(isShellFileInspectionCommand("git status")).toBe(false);
  });

  it("redacts secrets in tool output", () => {
    expect(defaultRedact("password=hunter2")).toContain("[REDACTED]");
    expect(defaultRedact("api_key: abc")).toContain("[REDACTED]");
  });
});
