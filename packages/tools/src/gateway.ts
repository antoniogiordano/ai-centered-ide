import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  ApprovalGrant,
  ToolCall,
  ToolResult,
} from "@ai-ide/shared";
import { AppError } from "@ai-ide/shared";
import type {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import {
  analyzeCommand,
  evaluatePolicy,
  getToolRisk,
  type ApprovalCategory,
} from "./policy.js";
import type { ToolRegistry } from "./registry.js";
import type { TerminalHost } from "./terminal-host.js";
import type { CbmHost } from "./cbm-host.js";

export type ToolExecutionContext = {
  workspaceRoot: string;
  mode: AgentMode;
  grants: ApprovalGrant[];
  fs: FilesystemService;
  git: GitService;
  checkpoint: CheckpointService;
  audit: (entry: {
    toolName: string;
    action: string;
    payload?: unknown;
  }) => void;
  redact: (value: unknown) => unknown;
  approvedCategories: Set<ApprovalCategory>;
  /** Skip approval for these tool call ids (one-shot after user approve). */
  oneShotApprovedIds?: Set<string>;
  /** Interactive multi-PTY host (desktop). Optional in tests. */
  terminals?: TerminalHost;
  /** Codebase-memory-mcp host (desktop). Optional until indexed. */
  cbm?: CbmHost;
};

export type GatewayResult =
  | { status: "ok"; result: ToolResult }
  | {
      status: "approval_required";
      approvalId: string;
      description: string;
      call: ToolCall;
    };

export class ToolGateway {
  constructor(private readonly registry: ToolRegistry) {}

  async executeTool(call: ToolCall, ctx: ToolExecutionContext): Promise<GatewayResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      throw new AppError({
        code: "NOT_FOUND",
        userMessage: "Unknown tool requested.",
        technicalDetail: call.name,
      });
    }

    const parsed = tool.argsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage: "Tool arguments are invalid.",
        technicalDetail: parsed.error.message,
      });
    }

    const riskLevel = tool.riskLevel ?? getToolRisk(call.name);
    let category: ApprovalCategory = "command";
    if (call.name === "git_commit") category = "git_commit";
    if (call.name === "write_file" && String(parsed.data.path ?? "").includes(".env")) {
      category = "env_write";
    }

    const oneShot =
      ctx.oneShotApprovedIds?.has(call.id) === true ||
      ctx.approvedCategories.has(category);

    const describeApproval = (fallback: string): string => {
      if (call.name === "run_command") {
        const cmd = String(parsed.data.command ?? "");
        return `Run command:\n${cmd}`;
      }
      if (call.name === "git_commit") {
        return `Create commit:\n${String(parsed.data.message ?? "")}`;
      }
      if (call.name === "write_file") {
        return `Write file: ${String(parsed.data.path ?? "")}`;
      }
      try {
        const args = JSON.stringify(parsed.data, null, 2);
        return `${fallback}\n\nArguments:\n${args.slice(0, 2000)}`;
      } catch {
        return fallback;
      }
    };

    if (call.name === "run_command") {
      const cmd = String(parsed.data.command ?? "");
      const analysis = analyzeCommand(cmd);
      if (analysis.blocked) {
        throw new AppError({
          code: "TOOL_DENIED",
          userMessage: "This command is blocked by policy.",
          technicalDetail: analysis.matchedDeny ?? cmd,
        });
      }
      if (analysis.needsApproval && !oneShot) {
        const decision = evaluatePolicy({
          mode: ctx.mode,
          toolName: call.name,
          riskLevel: "sensitive",
          grants: ctx.grants,
          category: "command",
        });
        if ("requiresApproval" in decision && decision.requiresApproval) {
          return {
            status: "approval_required",
            approvalId: randomUUID(),
            description: describeApproval(decision.description),
            call: { ...call, riskLevel },
          };
        }
      }
    }

    const decision = evaluatePolicy({
      mode: ctx.mode,
      toolName: call.name,
      riskLevel,
      grants: ctx.grants,
      category,
    });

    if ("requiresApproval" in decision && decision.requiresApproval) {
      if (!oneShot) {
        return {
          status: "approval_required",
          approvalId: randomUUID(),
          description: describeApproval(decision.description),
          call: { ...call, riskLevel },
        };
      }
    } else if ("allowed" in decision && decision.allowed === false && "reason" in decision) {
      throw new AppError({
        code: "TOOL_DENIED",
        userMessage: decision.reason,
        technicalDetail: call.name,
      });
    }

    const started = Date.now();
    try {
      const raw = await tool.execute(parsed.data, ctx);
      const output = ctx.redact(raw.output ?? raw.summary);
      ctx.audit({
        toolName: call.name,
        action: "execute",
        payload: { arguments: parsed.data, durationMs: Date.now() - started },
      });
      return {
        status: "ok",
        result: {
          callId: call.id,
          success: true,
          summary: raw.summary,
          output,
          artifactRef: raw.artifactRef,
        },
      };
    } catch (error) {
      ctx.audit({
        toolName: call.name,
        action: "error",
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
      return {
        status: "ok",
        result: {
          callId: call.id,
          success: false,
          summary:
            error instanceof Error
              ? error.message.split("\n").find((l) => l.trim()) ||
                "Tool execution failed."
              : "Tool execution failed.",
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

export function defaultRedact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
      "[REDACTED]",
    );
  }
  return value;
}
