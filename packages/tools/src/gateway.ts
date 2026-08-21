import { randomUUID } from "node:crypto";
import type {
  AgentMode,
  ApprovalGrant,
  ToolCall,
  ToolResult,
  ToolResultImage,
  TestRunReport,
} from "@ai-ide/shared";
import type {
  CheckpointService,
  FilesystemService,
  GitService,
} from "@ai-ide/workspace";
import {
  analyzeCommand,
  evaluatePolicy,
  getToolRisk,
  isShellFileInspectionCommand,
  type ApprovalCategory,
} from "./policy.js";
import type { ToolRegistry } from "./registry.js";
import type { AskHost } from "./ask-host.js";
import type { TerminalHost } from "./terminal-host.js";
import type { CbmHost } from "./cbm-host.js";
import type { HumanSetupHost } from "./human-setup.js";
import type { NoticeHost } from "./notice.js";

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
  /** Blocking user-question host for ask_user (desktop). Optional in tests. */
  ask?: AskHost;
  /** Codebase-memory-mcp host (desktop). Optional until indexed. */
  cbm?: CbmHost;
  /** Blocking manual-setup checklist host for request_human_setup (desktop). */
  humanSetup?: HumanSetupHost;
  /** Chrome warning/error banners (harness + post_notice). */
  notice?: NoticeHost;
  /** Full suite logs from the last IDE test gate (for read_test_log). */
  testLogs?: {
    get: (suiteId: string) => string | undefined;
  };
  /** Last IDE test-gate report + escalation (for get_test_report). */
  testGate?: {
    getReport: () => TestRunReport | null;
    getMeta: () => {
      escalationLevel: number;
      circuitOpen: boolean;
      sameFailureStreak: number;
    };
  };
  /** User message attachments for import_attachment (session-scoped). */
  attachments?: {
    get: (id: string) =>
      | {
          id: string;
          kind: "image" | "file";
          name: string;
          mime?: string;
          path?: string;
          bytes: Buffer;
        }
      | undefined;
    list: () => Array<{
      id: string;
      kind: "image" | "file";
      name: string;
      mime?: string;
      path?: string;
    }>;
  };
};

export type GatewayResult =
  | {
      status: "ok";
      result: ToolResult;
      /**
       * Out-of-band image payloads. Kept off {@link ToolResult} so base64 never
       * lands in SessionState, SQLite or the IPC transcript — the agent loop
       * forwards them straight to the provider message list.
       */
      images?: ToolResultImage[];
    }
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
      return {
        status: "ok",
        result: {
          callId: call.id,
          success: false,
          summary: `Unknown tool: ${call.name}`,
          error: `Unknown tool requested: ${call.name}`,
        },
      };
    }

    const parsed = tool.argsSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        status: "ok",
        result: {
          callId: call.id,
          success: false,
          summary: "Tool arguments are invalid — fix the args and retry.",
          error: parsed.error.message,
          output: {
            tool: call.name,
            issues: parsed.error.issues,
          },
        },
      };
    }

    let riskLevel = tool.riskLevel ?? getToolRisk(call.name);
    let category: ApprovalCategory = "command";
    if (call.name === "git_commit") category = "git_commit";
    if (
      (call.name === "write_file" || call.name === "replace_in_file") &&
      String(parsed.data.path ?? "").includes(".env")
    ) {
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
      if (call.name === "replace_in_file") {
        return `Replace in file: ${String(parsed.data.path ?? "")}`;
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
      if (isShellFileInspectionCommand(cmd)) {
        return {
          status: "ok",
          result: {
            callId: call.id,
            success: false,
            summary:
              "Blocked shell file-inspection. Use list_dir / read_file / search_text / search_graph instead of cat/ls/find/head.",
            error:
              "Do not use shell cat/ls/find/head to inspect files. Use list_dir, read_file, search_text, or search_graph / get_code_snippet.",
            output: { command: cmd, blocked: true, reason: "file_inspection" },
          },
        };
      }
      const analysis = analyzeCommand(cmd);
      if (analysis.blocked) {
        return {
          status: "ok",
          result: {
            callId: call.id,
            success: false,
            summary: "Command blocked by policy.",
            error: `Blocked by policy: ${analysis.matchedDeny ?? cmd}. Git commit and push are harness-only — use the Commit Build / Integrate banners.`,
            output: { command: cmd, blocked: true, reason: "denylist" },
          },
        };
      }
      // A command that survived the denylist is ordinary build work — npm i,
      // a test run, a codegen script — and the checkpoint system already makes
      // it undoable. Classifying it `sensitive` used to park the whole turn on
      // an approval the UI then granted for the user, which bought no safety
      // and cost a round trip per command. The denylist is the real gate; the
      // mode matrix still decides whether shell access is available at all.
      riskLevel = "reversible";
    }

    if (call.name === "git_commit") {
      return {
        status: "ok",
        result: {
          callId: call.id,
          success: false,
          summary: "Git commit is harness-only.",
          error:
            "git_commit is blocked. After tests pass, use the Commit Build banner in the IDE — agents cannot commit or push.",
          output: { blocked: true, reason: "harness_only_git" },
        },
      };
    }

    if (call.name === "terminal_write" || call.name === "terminal_ask") {
      const text =
        call.name === "terminal_write"
          ? String(parsed.data.text ?? "")
          : String(
              (parsed.data as { suggestedText?: string }).suggestedText ??
                (parsed.data as { prompt?: string }).prompt ??
                "",
            );
      if (text.trim()) {
        const analysis = analyzeCommand(text);
        if (analysis.blocked) {
          return {
            status: "ok",
            result: {
              callId: call.id,
              success: false,
              summary: "Terminal input blocked by policy.",
              error: `Blocked by policy: ${analysis.matchedDeny ?? "denied"}. Git commit and push are harness-only — use the Commit Build / Integrate banners.`,
              output: {
                text,
                blocked: true,
                reason: "denylist",
              },
            },
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
      return {
        status: "ok",
        result: {
          callId: call.id,
          success: false,
          summary: decision.reason,
          error: decision.reason,
          output: { tool: call.name, blocked: true, reason: "policy" },
        },
      };
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
        ...(raw.images?.length ? { images: raw.images } : {}),
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
