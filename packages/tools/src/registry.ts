import type { ZodType } from "zod";
import type { RiskLevel } from "@ai-ide/shared";
import type { ToolExecutionContext } from "./gateway.js";

export type ToolPhase = "planning" | "building" | "testing";

export type ToolDefinition = {
  name: string;
  description: string;
  argsSchema: ZodType<Record<string, unknown>>;
  /** OpenAI-compatible JSON Schema for function parameters. */
  parameters: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** Which product phases may expose this tool to the model. */
  phases: ToolPhase[];
  execute: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<{ summary: string; output?: unknown; artifactRef?: string }>;
};

export type ToolFunctionDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  listForModel(): ToolFunctionDef[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /** Tools allowed for the current agent mode (legacy). Prefer listForPhase. */
  listForMode(mode: "ask" | "plan" | "agent" | "autonomous"): ToolDefinition[] {
    const phase: ToolPhase =
      mode === "ask" || mode === "plan" ? "planning" : "building";
    return this.listForPhase(phase);
  }

  /** Tools for planning / building / testing product phases. */
  listForPhase(phase: ToolPhase): ToolDefinition[] {
    return this.list().filter((tool) => tool.phases.includes(phase));
  }
}
