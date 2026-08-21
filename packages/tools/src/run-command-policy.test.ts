import { describe, expect, it, vi } from "vitest";
import type { ToolCall } from "@ai-ide/shared";
import { ToolGateway, type ToolExecutionContext } from "./gateway.js";
import { ToolRegistry } from "./registry.js";
import { z } from "zod";

/**
 * `run_command` used to be classified `sensitive`, which parked every shell
 * call on an approval the renderer then granted on the user's behalf after a
 * three-second timer. These tests pin the replacement contract: the denylist
 * and the mode matrix decide, and nothing in between asks the user a question
 * it is going to answer itself.
 */

function registryWithRunCommand(execute: () => Promise<{ summary: string }>) {
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    description: "run a shell command",
    riskLevel: "sensitive",
    phases: ["building", "checking", "testing"],
    argsSchema: z.object({ command: z.string().min(1) }) as z.ZodType<
      Record<string, unknown>
    >,
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: execute as never,
  });
  return registry;
}

function context(mode: ToolExecutionContext["mode"]): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp/ws",
    mode,
    grants: [],
    fs: {} as never,
    git: {} as never,
    checkpoint: {} as never,
    audit: () => {},
    redact: (v) => v,
    approvedCategories: new Set(),
  };
}

function call(command: string): ToolCall {
  return {
    id: "call-1",
    name: "run_command",
    arguments: { command },
    riskLevel: "sensitive",
  };
}

describe("run_command approval policy", () => {
  it("runs an ordinary command in agent mode without asking", async () => {
    const execute = vi.fn(async () => ({ summary: "installed" }));
    const gateway = new ToolGateway(registryWithRunCommand(execute));

    const result = await gateway.executeTool(
      call("pnpm install"),
      context("agent"),
    );

    expect(result.status).toBe("ok");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("still blocks denylisted commands before they reach the tool", async () => {
    const execute = vi.fn(async () => ({ summary: "boom" }));
    const gateway = new ToolGateway(registryWithRunCommand(execute));

    const result = await gateway.executeTool(
      call("rm -rf /"),
      context("agent"),
    );

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("still refuses shell access entirely in ask mode", async () => {
    const execute = vi.fn(async () => ({ summary: "nope" }));
    const gateway = new ToolGateway(registryWithRunCommand(execute));

    const result = await gateway.executeTool(
      call("pnpm install"),
      context("ask"),
    );

    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
