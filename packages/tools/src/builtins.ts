import { z } from "zod";
import { ToolRegistry, type ToolPhase } from "./registry.js";
import { registerCbmTools } from "./cbm-builtins.js";

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const PLANNING_AND_BUILDING: ToolPhase[] = ["planning", "building"];
const PLANNING_ONLY: ToolPhase[] = ["planning"];
const BUILDING_ONLY: ToolPhase[] = ["building"];
const READ_TOOLS: ToolPhase[] = ["planning", "building"];

export function registerStarterTools(registry: ToolRegistry): void {
  registry.register({
    name: "list_dir",
    description:
      "List files and folders in a workspace directory (hides node_modules/.git/dist/…). Paths are relative to the workspace root. Use path \".\" for the root. Prefer this over shell ls.",
    riskLevel: "safe",
    phases: READ_TOOLS,
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
      const HIDDEN = new Set([
        "node_modules",
        ".git",
        "dist",
        "out",
        "build",
        "coverage",
        ".next",
        ".turbo",
        ".cache",
        "__pycache__",
        ".venv",
        "venv",
      ]);
      const entries = ctx.fs
        .listDetailed(path)
        .filter((e) => !HIDDEN.has(e.name) && !e.name.startsWith(".env"));
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
    phases: READ_TOOLS,
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
      "Update the delivery plan. Planning: CRUD phases + checklist texts + clarifying questions for the Plan Q&A dialog (never ask those questions only in chat prose). Building: structure is LOCKED — only set checklist done and phase status (same phase/item ids and texts; no add/remove/rename). After EACH completed item, call with that item done=true. Always pass the full phases array.",
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
            "Ordered delivery phases. Planning: title + checklist text. Building: same structure as agreed — only change status and checklist done (ids/titles/texts must match).",
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
    name: "propose_plan_ready",
    description:
      "Signal that the draft plan is ready for Start Build. Use when the plan is good enough OR the user wants to run shell/npm/git now (e.g. npm init). Pass a short feat/kebab-case suggestedBranch. Does NOT start development — the IDE opens Start Build. All open questions must already be cleared (questions=[]).",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      suggestedBranch: z.string().min(1).max(80),
      summary: z.string().max(500).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        suggestedBranch: {
          type: "string",
          description:
            "Short git branch suggestion, e.g. feat/user-auth or user-auth (feat/ is added). kebab-case, not too long.",
        },
        summary: {
          type: "string",
          description: "Optional one-line note shown near the confirm CTA.",
        },
      },
      required: ["suggestedBranch"],
      additionalProperties: false,
    },
    execute: async () => ({
      summary: "Plan readiness is handled by the agent runtime.",
    }),
  });

  registry.register({
    name: "read_architecture",
    description:
      "Read effective architecture: detected stack from the repo ⊕ sparse overrides/intent in .aifi/ARCHITECTURE.md.",
    riskLevel: "safe",
    phases: READ_TOOLS,
    argsSchema: z.object({}) as z.ZodType<Record<string, unknown>>,
    parameters: emptyObjectSchema,
    execute: async (_args, ctx) => {
      const { ArchitectureStore } = await import("@ai-ide/workspace");
      const { ARCHITECTURE_FILE_PATH } = await import("@ai-ide/shared");
      const store = new ArchitectureStore(ctx.workspaceRoot);
      const view = store.loadEffective();
      if (view.error) {
        throw new Error(view.error);
      }
      return {
        summary: view.fromFile
          ? `Loaded ${ARCHITECTURE_FILE_PATH} (effective = detected ⊕ overrides)`
          : "Detected stack from repo (no ARCHITECTURE.md overrides yet)",
        output: {
          path: ARCHITECTURE_FILE_PATH,
          fromFile: view.fromFile,
          intent: view.intent,
          derived: view.derived,
          overrides: view.overrides,
          effective: view.effective,
          drift: view.drift,
          profile: view.effective,
        },
      };
    },
  });

  registry.register({
    name: "upsert_architecture",
    description:
      "Merge sparse overrides into .aifi/ARCHITECTURE.md frontmatter (optional intent markdown body). Does not replace repo detection. Canonical keys only; wrong keys fail with a field guide.",
    riskLevel: "safe",
    phases: READ_TOOLS,
    argsSchema: z.object({
      patch: z.record(z.unknown()).optional(),
      intent: z.string().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            "Replace the markdown body of ARCHITECTURE.md (product intent). Omit to leave unchanged.",
        },
        patch: {
          type: "object",
          description:
            "Sparse overrides only. Example: {\"runtimes\":[{\"id\":\"python\"}],\"backend\":{\"language\":\"python\",\"frameworks\":[\"FastAPI\"],\"roots\":[\"src\"]},\"testing\":{\"unit\":{\"lib\":\"pytest\"}},\"quality\":{\"lint\":\"flake8\",\"format\":\"black\"},\"data\":{\"database\":\"sqlite\"}}",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            repo: {
              type: "object",
              additionalProperties: false,
              properties: {
                shape: { type: "string", enum: ["app", "monorepo"] },
                packageManager: {
                  type: "string",
                  enum: [
                    "npm",
                    "pnpm",
                    "yarn",
                    "bun",
                    "cargo",
                    "pip",
                    "poetry",
                    "go",
                    "custom",
                  ],
                },
              },
            },
            runtimes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id"],
                properties: {
                  id: {
                    type: "string",
                    enum: [
                      "node",
                      "python",
                      "go",
                      "rust",
                      "jvm",
                      "dotnet",
                      "bun",
                      "deno",
                      "custom",
                    ],
                  },
                  version: { type: "string" },
                },
              },
            },
            backend: {
              type: "object",
              additionalProperties: false,
              properties: {
                language: {
                  type: "string",
                  enum: [
                    "typescript",
                    "javascript",
                    "python",
                    "go",
                    "rust",
                    "java",
                    "kotlin",
                    "csharp",
                    "ruby",
                    "php",
                    "custom",
                  ],
                },
                frameworks: { type: "array", items: { type: "string" } },
                roots: { type: "array", items: { type: "string" } },
                styling: { type: "array", items: { type: "string" } },
                bundler: { type: "string" },
              },
            },
            frontend: {
              type: "object",
              additionalProperties: false,
              properties: {
                language: {
                  type: "string",
                  enum: [
                    "typescript",
                    "javascript",
                    "python",
                    "go",
                    "rust",
                    "java",
                    "kotlin",
                    "csharp",
                    "ruby",
                    "php",
                    "custom",
                  ],
                },
                frameworks: { type: "array", items: { type: "string" } },
                roots: { type: "array", items: { type: "string" } },
                styling: { type: "array", items: { type: "string" } },
                bundler: { type: "string" },
              },
            },
            testing: {
              type: "object",
              additionalProperties: false,
              properties: {
                unit: {
                  type: "object",
                  additionalProperties: false,
                  required: ["lib"],
                  properties: {
                    lib: { type: "string" },
                    command: { type: "string" },
                    roots: { type: "array", items: { type: "string" } },
                  },
                },
                e2e: {
                  type: "object",
                  additionalProperties: false,
                  required: ["lib"],
                  properties: {
                    lib: { type: "string" },
                    command: { type: "string" },
                    roots: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
            quality: {
              type: "object",
              additionalProperties: false,
              properties: {
                lint: { type: "string" },
                typecheck: { type: "string" },
                format: { type: "string" },
              },
            },
            data: {
              type: "object",
              additionalProperties: false,
              properties: {
                database: {
                  type: "string",
                  enum: [
                    "postgres",
                    "mysql",
                    "sqlite",
                    "mongodb",
                    "redis",
                    "none",
                    "custom",
                  ],
                },
                orm: {
                  type: "string",
                  enum: [
                    "prisma",
                    "drizzle",
                    "typeorm",
                    "sequelize",
                    "sqlalchemy",
                    "django_orm",
                    "gorm",
                    "none",
                    "custom",
                  ],
                },
              },
            },
            api: {
              type: "object",
              additionalProperties: false,
              properties: {
                style: {
                  type: "string",
                  enum: ["rest", "graphql", "trpc", "grpc", "none", "custom"],
                },
              },
            },
          },
        },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { ArchitectureStore } = await import("@ai-ide/workspace");
      const {
        parseArchitectureProfilePatch,
        ARCHITECTURE_FILE_PATH,
      } = await import("@ai-ide/shared");
      const store = new ArchitectureStore(ctx.workspaceRoot);
      const intent =
        typeof args.intent === "string" ? args.intent : undefined;
      const hasPatch =
        args.patch &&
        typeof args.patch === "object" &&
        !Array.isArray(args.patch) &&
        Object.keys(args.patch as object).length > 0;

      if (!hasPatch && intent === undefined) {
        throw new Error(
          "Provide patch and/or intent. upsert_architecture writes sparse overrides to ARCHITECTURE.md.",
        );
      }

      let effective;
      if (hasPatch) {
        const patch = parseArchitectureProfilePatch(args.patch);
        effective = store.savePatch(patch, "agent_proposed", intent);
      } else {
        effective = store.saveIntent(String(intent), "agent_proposed");
      }
      const view = store.loadEffective();
      return {
        summary: `Updated ${ARCHITECTURE_FILE_PATH}`,
        output: {
          path: ARCHITECTURE_FILE_PATH,
          intent: view.intent,
          overrides: view.overrides,
          effective,
          drift: view.drift,
          profile: effective,
        },
      };
    },
  });
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  registerStarterTools(registry);

  registry.register({
    name: "search_text",
    description: "Search for text in workspace files.",
    riskLevel: "safe",
    phases: READ_TOOLS,
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
    description:
      "Run a one-shot shell command (buffered, timeout + tree kill). Prefer terminal_* for interactive/long-running processes. Do NOT list node_modules/.git/dist (output is stripped); use list_dir or targeted paths instead of ls -R.",
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
        : result.truncated
          ? `Exit ${result.exitCode}: ${args.command} (output sanitized/truncated)`
          : `Exit ${result.exitCode}: ${args.command}`;
      return { summary, output: result };
    },
  });

  registry.register({
    name: "terminal_open",
    description:
      "Open a new interactive terminal (PTY) in the workspace. Multiple terminals are allowed. Returns terminalId for write/read/ask.",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      title: z.string().optional(),
      cwd: z.string().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        cwd: { type: "string", description: "Relative workspace path (default .)" },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.terminals) {
        throw new Error("Interactive terminals are not available in this environment.");
      }
      const info = await ctx.terminals.open({
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
      });
      return {
        summary: `Opened ${info.title} (${info.id.slice(0, 8)})`,
        output: info,
      };
    },
  });

  registry.register({
    name: "terminal_list",
    description: "List interactive terminals (id, title, status, pid).",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({}) as z.ZodType<Record<string, unknown>>,
    parameters: emptyObjectSchema,
    execute: async (_args, ctx) => {
      if (!ctx.terminals) {
        throw new Error("Interactive terminals are not available in this environment.");
      }
      const terminals = ctx.terminals.list();
      return {
        summary: `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`,
        output: { terminals },
      };
    },
  });

  registry.register({
    name: "terminal_read",
    description:
      "Read recent streamed output from a terminal. Use after writes or while a process is running.",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      terminalId: z.string().min(1),
      maxChars: z.number().int().positive().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        maxChars: { type: "number" },
      },
      required: ["terminalId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.terminals) {
        throw new Error("Interactive terminals are not available in this environment.");
      }
      const { sanitizeCommandOutput } = await import("./command-output.js");
      const result = ctx.terminals.read(String(args.terminalId), {
        ...(typeof args.maxChars === "number" ? { maxChars: args.maxChars } : {}),
      });
      const cleaned = sanitizeCommandOutput(result.output ?? "");
      return {
        summary: `Read terminal ${result.status}${
          result.exitCode !== null ? ` exit=${result.exitCode}` : ""
        }${cleaned.truncated ? " (sanitized)" : ""}`,
        output: {
          ...result,
          output: cleaned.text,
          truncated: cleaned.truncated,
        },
      };
    },
  });

  registry.register({
    name: "terminal_write",
    description:
      "Send exact text to a terminal. The user gets 3s to confirm/cancel/edit (auto-approve on timeout). Prefer this for interactive commands; use terminal_ask when the user must choose.",
    riskLevel: "reversible",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      terminalId: z.string().min(1),
      text: z.string(),
      appendNewline: z.boolean().optional(),
      settleMs: z.number().int().nonnegative().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        text: {
          type: "string",
          description: "Exact stdin text. Newline is appended by default.",
        },
        appendNewline: { type: "boolean" },
        settleMs: {
          type: "number",
          description: "Ms to wait before returning recent output (default 500).",
        },
      },
      required: ["terminalId", "text"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.terminals) {
        throw new Error("Interactive terminals are not available in this environment.");
      }
      const result = await ctx.terminals.write(
        String(args.terminalId),
        String(args.text),
        {
          appendNewline: args.appendNewline !== false,
          settleMs: typeof args.settleMs === "number" ? args.settleMs : 500,
        },
      );
      if (result.cancelled) {
        return {
          summary: "Terminal write cancelled by user",
          output: result,
        };
      }
      return {
        summary: result.written
          ? `Wrote to terminal (${result.text.length} chars)`
          : "Terminal write skipped",
        output: result,
      };
    },
  });

  registry.register({
    name: "terminal_ask",
    description:
      "Ask the user an exclusive A/B/C… choice (+ optional free text). You may suggest stdin text; the user can confirm or edit. Optionally writes the final text to the terminal (no extra 3s confirm).",
    riskLevel: "reversible",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      terminalId: z.string().min(1),
      prompt: z.string().min(1),
      options: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
          }),
        )
        .min(2)
        .max(8),
      suggestedText: z.string().optional(),
      writeToTerminal: z.boolean().optional(),
      appendNewline: z.boolean().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        prompt: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
        suggestedText: {
          type: "string",
          description: "Suggested exact text to send to the terminal.",
        },
        writeToTerminal: { type: "boolean" },
        appendNewline: { type: "boolean" },
      },
      required: ["terminalId", "prompt", "options"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.terminals) {
        throw new Error("Interactive terminals are not available in this environment.");
      }
      const options = (args.options as Array<{ id: string; label: string }>).map(
        (o) => ({ id: String(o.id), label: String(o.label) }),
      );
      const result = await ctx.terminals.ask({
        terminalId: String(args.terminalId),
        prompt: String(args.prompt),
        options,
        ...(typeof args.suggestedText === "string"
          ? { suggestedText: args.suggestedText }
          : {}),
        writeToTerminal: args.writeToTerminal !== false,
        appendNewline: args.appendNewline !== false,
      });
      if (result.cancelled) {
        return { summary: "Terminal ask cancelled by user", output: result };
      }
      const choice = result.selectedOptionId
        ? options.find((o) => o.id === result.selectedOptionId)?.label ??
          result.selectedOptionId
        : "free text";
      return {
        summary: result.written
          ? `User chose ${choice}; wrote ${result.text.length} chars`
          : `User chose ${choice}`,
        output: result,
      };
    },
  });

  registry.register({
    name: "terminal_close",
    description: "Close an interactive terminal and kill its process tree.",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      terminalId: z.string().min(1),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        terminalId: { type: "string" },
      },
      required: ["terminalId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.terminals) {
        throw new Error("Interactive terminals are not available in this environment.");
      }
      const result = await ctx.terminals.close(String(args.terminalId));
      return {
        summary: result.closed ? "Terminal closed" : "Terminal already closed",
        output: result,
      };
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
  registerCbmTools(registry);
  return registry;
}
