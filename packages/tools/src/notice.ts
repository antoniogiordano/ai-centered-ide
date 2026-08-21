/**
 * `post_notice`: put a warning or error in the IDE chrome, not just the log.
 *
 * A transcript line is easy to miss once the agent keeps talking. This is the
 * same surface the harness uses when it intercepts a blocked case (images
 * dropped because the model has no vision). The agent can raise its own:
 * something the human must see, optionally blocking auto-continue, optionally
 * with a TTL so it disappears on its own.
 */
import { z } from "zod";
import type { ToolPhase, ToolRegistry } from "./registry.js";

const ALL_PHASES: ToolPhase[] = [
  "planning",
  "checking",
  "building",
  "testing",
];

export type NoticeDeclaration = {
  kind: "warning" | "error";
  title: string;
  detail?: string;
  blocking?: boolean;
  ttlSeconds?: number;
};

export type NoticeHost = {
  post(input: NoticeDeclaration): Promise<{ id: string; expiresAt: string | null }>;
};

export function registerNoticeTools(registry: ToolRegistry): void {
  registry.register({
    name: "post_notice",
    description:
      "Show a warning or error banner in the IDE chrome that the human cannot miss. Use it when something important happened and a chat line is not enough: a screenshot was not seen, a command is blocked, a setup step is waiting. Set blocking=true to pause auto-continue until they dismiss it. Set ttlSeconds if it should vanish on its own (omit to keep it until Dismiss). Do not use this for secrets or env files — that is request_human_setup. Do not spam; one notice per distinct problem.",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({
      kind: z.enum(["warning", "error"]),
      title: z.string().min(1).max(200),
      detail: z.string().max(4_000).optional(),
      blocking: z.boolean().optional(),
      ttlSeconds: z.number().int().min(5).max(86_400).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["warning", "error"],
          description: "warning = amber banner; error = red banner.",
        },
        title: {
          type: "string",
          description: "Short headline, one line.",
        },
        detail: {
          type: "string",
          description: "What happened and what the human can do.",
        },
        blocking: {
          type: "boolean",
          description:
            "If true, the IDE stops auto-continuing until they dismiss the banner. Default false.",
        },
        ttlSeconds: {
          type: "integer",
          description:
            "Auto-dismiss after this many seconds. Omit to keep the banner until Dismiss.",
        },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.notice) {
        return {
          summary: "Cannot show a banner in this environment",
          output: {
            posted: false,
            error: "No notice host. Say it plainly in your reply instead.",
          },
        };
      }
      const blocking = Boolean(args.blocking);
      const posted = await ctx.notice.post({
        kind: args.kind === "error" ? "error" : "warning",
        title: String(args.title),
        ...(args.detail ? { detail: String(args.detail) } : {}),
        blocking,
        ...(typeof args.ttlSeconds === "number"
          ? { ttlSeconds: args.ttlSeconds }
          : {}),
      });
      return {
        summary: blocking
          ? `Posted a blocking ${String(args.kind)} banner`
          : `Posted a ${String(args.kind)} banner`,
        output: {
          posted: true,
          blocking,
          id: posted.id,
          expiresAt: posted.expiresAt,
          hint: blocking
            ? "The IDE is showing the banner and has ended this turn. Wait for the human."
            : "The banner is visible. Do not repeat the same notice.",
        },
      };
    },
  });
}
