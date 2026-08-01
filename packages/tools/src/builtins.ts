import { z } from "zod";
import { ToolRegistry, type ToolPhase } from "./registry.js";

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const PLANNING_AND_BUILDING: ToolPhase[] = ["planning", "building"];
const PLANNING_ONLY: ToolPhase[] = ["planning"];
const BUILDING_ONLY: ToolPhase[] = ["building"];

export function registerStarterTools(registry: ToolRegistry): void {
  registry.register({
    name: "list_dir",
    description:
      "List files and folders in a workspace directory. Paths are relative to the workspace root. Use path \".\" for the root.",
    riskLevel: "safe",
    phases: PLANNING_AND_BUILDING,
    argsSchema: z.object({
      path: z.string().optional().default("."),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Directory relative to workspace root. Use "." for the workspace root.',
        },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const path = String(args.path ?? ".");
      const entries = ctx.fs.listDetailed(path);
      return {
        summary: `Listed ${path} (${entries.length} entries)`,
        output: entries,
      };
    },
  });

  registry.register({
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace. Path is relative to the workspace root (e.g. README.md, docs/DEVELOPMENT_PLAN.md).",
    riskLevel: "safe",
    phases: PLANNING_AND_BUILDING,
    argsSchema: z.object({
      path: z.string().min(1),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const path = String(args.path);
      const content = ctx.fs.read(path);
      return { summary: `Read ${path}`, output: content };
    },
  });

  registry.register({
    name: "upsert_plan",
    description:
      "Create or replace the delivery plan. Planning: CRUD phases + checklist texts + clarifying questions (no done/progress). Building: mark checklist done and phase status. Always pass the full phases array.",
    riskLevel: "safe",
    phases: PLANNING_AND_BUILDING,
    argsSchema: z.object({
      phases: z.array(z.record(z.unknown())).min(1),
      questions: z.array(z.record(z.unknown())).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        phases: {
          type: "array",
          description:
            "Ordered delivery phases. In planning only title+checklist text matter (done/status ignored). In building, set done and status for progress.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: {
                type: "string",
                enum: [
                  "pending",
                  "in_progress",
                  "completed",
                  "skipped",
                  "failed",
                ],
                description:
                  "Building only. Ignored while planning (forced pending).",
              },
              checklist: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    text: { type: "string" },
                    done: {
                      type: "boolean",
                      description:
                        "Building only. Ignored while planning (forced false).",
                    },
                  },
                  required: ["text"],
                },
              },
            },
            required: ["title", "checklist"],
          },
        },
        questions: {
          type: "array",
          description:
            "Clarifying questions for the keyboard Q&A dialog (USER answers). EVERY new question MUST include selection (single|multiple), 2–8 options, and status \"open\". Do NOT invent answer/selectedOptionIds. Omit or pass [] when none remain.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              selection: {
                type: "string",
                enum: ["single", "multiple"],
                description:
                  "single = pick one (A–Z). multiple = pick many (1–9) then Enter.",
              },
              options: {
                type: "array",
                description: "Concrete choices (2–8).",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                  },
                  required: ["label"],
                },
              },
              status: {
                type: "string",
                enum: ["open", "answered"],
                description:
                  "Use \"open\" for new questions. Only keep \"answered\" when re-emitting a question the user already answered.",
              },
            },
            required: ["text", "selection", "options"],
          },
        },
      },
      required: ["phases"],
      additionalProperties: false,
    },
    execute: async () => ({
      summary: "Plan mutation is handled by the agent runtime.",
    }),
  });

  registry.register({
    name: "finalize_plan",
    description:
      "Lock the plan and switch to development. ONLY after the user explicitly confirmed they want to start building (not after an analysis request). All open questions must be answered first.",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      confirmed: z.boolean(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true after explicit user confirmation to start building.",
        },
      },
      required: ["confirmed"],
      additionalProperties: false,
    },
    execute: async () => ({
      summary: "Plan finalization is handled by the agent runtime.",
    }),
  });
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  registerStarterTools(registry);

  registry.register({
    name: "search_text",
    description: "Search for text in workspace files.",
    riskLevel: "safe",
    phases: PLANNING_AND_BUILDING,
    argsSchema: z.object({ query: z.string().min(1) }) as z.ZodType<
      Record<string, unknown>
    >,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { searchText } = await import("@ai-ide/workspace");
      const matches = searchText(ctx.workspaceRoot, String(args.query));
      return { summary: `Found ${matches.length} matches`, output: matches };
    },
  });

  registry.register({
    name: "write_file",
    description: "Write a text file in the workspace.",
    riskLevel: "reversible",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      ctx.fs.write(String(args.path), String(args.content));
      return { summary: `Wrote ${args.path}` };
    },
  });

  registry.register({
    name: "git_status",
    description: "Get git status for the workspace.",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({}) as z.ZodType<Record<string, unknown>>,
    parameters: emptyObjectSchema,
    execute: async (_args, ctx) => {
      const status = await ctx.git.status();
      return { summary: "Git status", output: status };
    },
  });

  registry.register({
    name: "git_diff",
    description: "Get git diff for the workspace.",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({ staged: z.boolean().optional() }) as z.ZodType<
      Record<string, unknown>
    >,
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const diff = await ctx.git.diff(Boolean(args.staged));
      return { summary: "Git diff", output: diff };
    },
  });

  registry.register({
    name: "git_commit",
    description: "Create a git commit with staged changes.",
    riskLevel: "sensitive",
    phases: BUILDING_ONLY,
    argsSchema: z.object({ message: z.string().min(1) }) as z.ZodType<
      Record<string, unknown>
    >,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const hash = await ctx.git.commit(String(args.message));
      return { summary: `Committed ${hash}`, output: { hash } };
    },
  });

  registry.register({
    name: "run_command",
    description: "Run a shell command in the workspace with timeout and tree kill.",
    riskLevel: "sensitive",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { runCommand } = await import("./pty.js");
      const { join } = await import("node:path");
      const cwdRel = String(args.cwd ?? ".");
      const cwd = join(ctx.workspaceRoot, cwdRel === "." ? "" : cwdRel);
      const result = await runCommand({
        command: String(args.command),
        cwd: cwd || ctx.workspaceRoot,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 120_000,
      });
      const summary = result.timedOut
        ? `Timed out: ${args.command}`
        : `Exit ${result.exitCode}: ${args.command}`;
      return { summary, output: result };
    },
  });

  registry.register({
    name: "checkpoint_restore",
    description: "Restore files from a checkpoint.",
    riskLevel: "reversible",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      id: z.string().min(1),
      paths: z.array(z.string()),
      label: z.string().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        label: { type: "string" },
      },
      required: ["id", "paths"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const record = {
        id: String(args.id),
        paths: args.paths as string[],
        createdAt: new Date().toISOString(),
        ...(args.label ? { label: String(args.label) } : {}),
      };
      ctx.checkpoint.restore(record);
      return { summary: `Restored checkpoint ${record.id}`, output: record };
    },
  });
}

/** MVP toolset: list + read only (paths relative to workspace root). */
export function createStarterRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerStarterTools(registry);
  return registry;
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  return registry;
}
