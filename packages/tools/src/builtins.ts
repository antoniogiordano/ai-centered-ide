import { z } from "zod";
import { ToolRegistry, type ToolPhase } from "./registry.js";
import { registerCbmTools } from "./cbm-builtins.js";

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const PLANNING_ONLY: ToolPhase[] = ["planning"];
const BUILDING_ONLY: ToolPhase[] = ["building"];
const TESTING_ONLY: ToolPhase[] = ["testing"];
/** Plan progress (Build) + draft (Plan) — never Testing. */
const PLANNING_AND_BUILDING: ToolPhase[] = ["planning", "building"];
/** Implementation + bugfix (no plan mutation). */
const BUILDING_AND_TESTING: ToolPhase[] = ["building", "testing"];
/** Explore / read across all product phases. */
const ALL_PHASES: ToolPhase[] = ["planning", "building", "testing"];

export function registerStarterTools(registry: ToolRegistry): void {
  registry.register({
    name: "list_dir",
    description:
      "List files and folders in a workspace directory (hides node_modules/.git/dist/…). Paths relative to workspace root; \".\" = root. Prefer over shell ls. When the codebase graph is indexed, prefer search_graph / get_architecture / search_code first — use list_dir only for a known path, not to walk the tree.",
    riskLevel: "safe",
    phases: ALL_PHASES,
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
      "Read a UTF-8 text file window from the workspace (path relative to root). Defaults to ~250 lines from startLine (1-based). Large files never fail with 'too large' — page with startLine using nextStartLine from the previous result. Prefer search_text / search_graph to locate before paging whole files.",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      maxLines: z.number().int().positive().max(800).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root.",
        },
        startLine: {
          type: "integer",
          description:
            "1-based line to start reading (default 1). Use nextStartLine from a prior truncated read.",
        },
        maxLines: {
          type: "integer",
          description: "Max lines to return (default 250, max 800).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const path = String(args.path);
      const startLine =
        typeof args.startLine === "number" ? args.startLine : undefined;
      const maxLines =
        typeof args.maxLines === "number" ? args.maxLines : undefined;
      const window = await ctx.fs.readWindow(path, {
        ...(startLine != null ? { startLine } : {}),
        ...(maxLines != null ? { maxLines } : {}),
      });
      const lineSpan =
        window.endLine >= window.startLine
          ? `L${window.startLine}-${window.endLine}`
          : `L${window.startLine}`;
      const totalHint =
        window.totalLines != null
          ? `${window.totalLines} lines`
          : `${window.totalBytes} bytes`;
      const summary = window.truncated
        ? `Read ${path} ${lineSpan} (${totalHint}; truncated — nextStartLine=${window.nextStartLine})`
        : `Read ${path} ${lineSpan} (${totalHint})`;
      return {
        summary,
        output: {
          path: window.path,
          startLine: window.startLine,
          endLine: window.endLine,
          maxLines: window.maxLines,
          totalLines: window.totalLines,
          totalBytes: window.totalBytes,
          truncated: window.truncated,
          nextStartLine: window.nextStartLine,
          contentTruncated: window.contentTruncated,
          content: window.content,
        },
      };
    },
  });

  registry.register({
    name: "upsert_plan",
    description:
      "Full-replace the delivery plan (or update build progress). Planning: prefer micro tools (add_phase, add_check, set_questions, …) for small edits; use upsert_plan for a full rewrite. Building: structure LOCKED; done checks sticky; prefer Focus → one item, but you may mark multiple newly finished items done=true in one call if you completed them together. Keep prior done items true. Always pass the full phases array when using this tool. Not available in Testing — plan is frozen; use read_plan only.",
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
            "Ordered delivery phases. Planning: title + checklist text. Building: same structure as agreed — only change status and checklist done=true (ids/titles/texts must match; never uncheck done items).",
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
            "Clarifying questions for the keyboard Q&A dialog (USER answers). Prefer set_questions for question-only updates. EVERY new question MUST include selection (single|multiple), 2–8 options, and status \"open\". Do NOT invent answer/selectedOptionIds. Omit or pass [] when none remain.",
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

  const planStub = async () => ({
    summary: "Plan mutation is handled by the agent runtime.",
  });

  registry.register({
    name: "read_plan",
    description:
      "Read the current delivery plan (phases, checklist, clarifying questions, ready proposal). Prefer this before micro edits. In Testing the plan is read-only.",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({}) as z.ZodType<Record<string, unknown>>,
    parameters: emptyObjectSchema,
    execute: planStub,
  });

  registry.register({
    name: "add_phase",
    description:
      "Planning only. Add one phase (optional checklist string[]). Prefer phaseId refs elsewhere; use afterPhaseId/afterPhaseIndex to insert.",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      title: z.string().min(1),
      checklist: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
      afterPhaseId: z.string().optional(),
      afterPhaseIndex: z.number().int().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        checklist: {
          type: "array",
          description: "Checklist item texts (strings) or {text} objects.",
          items: {},
        },
        afterPhaseId: { type: "string" },
        afterPhaseIndex: { type: "integer" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "replace_phase",
    description:
      "Planning only. Replace a phase by phaseId (preferred) or phaseIndex. Optionally replace title and/or checklist.",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      phaseId: z.string().optional(),
      phaseIndex: z.number().int().optional(),
      title: z.string().optional(),
      checklist: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        phaseId: { type: "string" },
        phaseIndex: { type: "integer" },
        title: { type: "string" },
        checklist: { type: "array", items: {} },
      },
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "delete_phase",
    description:
      "Planning only. Delete a phase by phaseId (preferred) or phaseIndex.",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      phaseId: z.string().optional(),
      phaseIndex: z.number().int().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        phaseId: { type: "string" },
        phaseIndex: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "add_check",
    description:
      "Planning only. Add one checklist item to a phase (phaseId preferred). Optional afterCheckId/afterCheckIndex.",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      phaseId: z.string().optional(),
      phaseIndex: z.number().int().optional(),
      text: z.string().min(1),
      afterCheckId: z.string().optional(),
      afterCheckIndex: z.number().int().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        phaseId: { type: "string" },
        phaseIndex: { type: "integer" },
        text: { type: "string" },
        afterCheckId: { type: "string" },
        afterCheckIndex: { type: "integer" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "replace_check",
    description:
      "Planning only. Replace one checklist item text (phaseId + checkId preferred; indexes allowed).",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      phaseId: z.string().optional(),
      phaseIndex: z.number().int().optional(),
      checkId: z.string().optional(),
      checkIndex: z.number().int().optional(),
      text: z.string().min(1),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        phaseId: { type: "string" },
        phaseIndex: { type: "integer" },
        checkId: { type: "string" },
        checkIndex: { type: "integer" },
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "delete_check",
    description:
      "Planning only. Delete one checklist item (phaseId + checkId preferred; indexes allowed).",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      phaseId: z.string().optional(),
      phaseIndex: z.number().int().optional(),
      checkId: z.string().optional(),
      checkIndex: z.number().int().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        phaseId: { type: "string" },
        phaseIndex: { type: "integer" },
        checkId: { type: "string" },
        checkIndex: { type: "integer" },
      },
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "set_questions",
    description:
      "Planning only. Replace clarifying questions for the Plan Q&A dialog. Pass questions=[] to clear. Do NOT invent answers.",
    riskLevel: "safe",
    phases: PLANNING_ONLY,
    argsSchema: z.object({
      questions: z.array(z.record(z.unknown())),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description:
            "Full questions array. Each open question needs selection, 2–8 options, status open.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              selection: {
                type: "string",
                enum: ["single", "multiple"],
              },
              options: {
                type: "array",
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
              },
            },
            required: ["text", "selection", "options"],
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    execute: planStub,
  });

  registry.register({
    name: "propose_plan_ready",
    description:
      "Signal that the draft plan is ready for Start Build. Use when the plan is good enough OR the user wants to run shell/npm/git now (e.g. npm init). Pass a short feat/kebab-case suggestedBranch. Does NOT start development — the IDE opens Start Build for USER confirmation. All open questions must already be cleared (set_questions questions=[]).",
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
    name: "propose_testing_ready",
    description:
      "After the build checklist is fully done: confirm the work is complete so the IDE can run the Test gate (lint/typecheck/unit). Call this instead of narrating readiness. Does NOT run tests yourself — the IDE starts the gate after this tool succeeds. Rejected while checklist items remain open.",
    riskLevel: "safe",
    phases: BUILDING_ONLY,
    argsSchema: z.object({
      summary: z.string().max(500).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Optional one-line note that the build is ready for verification.",
        },
      },
      additionalProperties: false,
    },
    execute: async () => ({
      summary: "Testing readiness is handled by the agent runtime.",
    }),
  });

  registry.register({
    name: "read_architecture",
    description:
      "Read effective architecture: detected stack from the repo ⊕ sparse overrides/intent in .aifi/ARCHITECTURE.md.",
    riskLevel: "safe",
    phases: ALL_PHASES,
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
    phases: ALL_PHASES,
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
    description:
      "Search for text in workspace files. When the codebase graph is indexed, prefer search_code / search_graph instead.",
    riskLevel: "safe",
    phases: ALL_PHASES,
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
    description:
      "Create a new text file OR fully overwrite an existing one (pass the entire file content). For edits to an existing file, ALWAYS prefer replace_in_file (exact search→replace) — it uses fewer tokens and avoids accidental drift. Use write_file only for brand-new paths or intentional full rewrites.",
    riskLevel: "reversible",
    phases: BUILDING_AND_TESTING,
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
    name: "replace_in_file",
    description:
      "PREFERRED edit for existing files: exact substring replace (search → replace). search must match exactly once unless replaceAll=true. Include enough surrounding context to keep search unique. Prefer this over write_file for any partial change — cheaper and safer than rewriting the whole file.",
    riskLevel: "reversible",
    phases: BUILDING_AND_TESTING,
    argsSchema: z.object({
      path: z.string().min(1),
      search: z.string().min(1),
      replace: z.string(),
      replaceAll: z.boolean().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Existing file path relative to the workspace root.",
        },
        search: {
          type: "string",
          description:
            "Exact text to find (must be unique in the file unless replaceAll).",
        },
        replace: {
          type: "string",
          description: "Replacement text (may be empty to delete the match).",
        },
        replaceAll: {
          type: "boolean",
          description:
            "If true, replace every non-overlapping match. Default false (require unique search).",
        },
      },
      required: ["path", "search", "replace"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const path = String(args.path);
      const search = String(args.search);
      const replace = String(args.replace);
      const replaceAll = args.replaceAll === true;
      const { matches } = ctx.fs.patch(path, search, replace, {
        ...(replaceAll ? { replaceAll: true } : {}),
      });
      return {
        summary: replaceAll
          ? `Replaced ${matches} match(es) in ${path}`
          : `Replaced text in ${path}`,
        output: { path, matches, replaceAll },
      };
    },
  });

  registry.register({
    name: "import_attachment",
    description:
      "Copy a user-attached file or image (from the current chat attachments) into the workspace at destPath. Use attachmentId from the user message / attachment list. After importing text files, page them with read_file (startLine/maxLines).",
    riskLevel: "safe",
    phases: ALL_PHASES,
    argsSchema: z.object({
      attachmentId: z.string().min(1),
      destPath: z.string().min(1),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        attachmentId: {
          type: "string",
          description: "Id of the attachment from the user message.",
        },
        destPath: {
          type: "string",
          description: "Destination path relative to the workspace root.",
        },
      },
      required: ["attachmentId", "destPath"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const attachmentId = String(args.attachmentId);
      const destPath = String(args.destPath);
      const att = ctx.attachments?.get(attachmentId);
      if (!att) {
        const available = ctx.attachments?.list() ?? [];
        return {
          summary: `Attachment not found: ${attachmentId}`,
          output: {
            error: "not_found",
            available: available.map((a) => ({
              id: a.id,
              kind: a.kind,
              name: a.name,
              path: a.path,
            })),
          },
        };
      }
      ctx.fs.writeBinary(destPath, att.bytes);
      return {
        summary: `Imported ${att.name} → ${destPath}`,
        output: {
          attachmentId: att.id,
          name: att.name,
          kind: att.kind,
          mime: att.mime,
          destPath,
          bytes: att.bytes.byteLength,
        },
      };
    },
  });

  registry.register({
    name: "git_status",
    description: "Get git status for the workspace.",
    riskLevel: "safe",
    phases: BUILDING_AND_TESTING,
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
    phases: BUILDING_AND_TESTING,
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
    description:
      "DISABLED — git commit/push are harness-only. After the test gate passes, the IDE shows a Commit Build banner; do not attempt commits via tools or the terminal.",
    riskLevel: "sensitive",
    phases: BUILDING_AND_TESTING,
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
    execute: async () => {
      return {
        summary: "Git commit is harness-only.",
        error:
          "git_commit is blocked. Use the Commit Build banner after tests pass — agents cannot commit or push.",
        output: { blocked: true, reason: "harness_only_git" },
      };
    },
  });

  registry.register({
    name: "run_command",
    description:
      "Short one-shot host shell (`bash -lc` in workspace). Auto-loads nvm/fnm and honors .nvmrc/.node-version for THAT process only — env does not persist to the next call. For multi-step Node/npm/pnpm/git work prefer terminal_open once and reuse terminal_write/terminal_read. Do NOT use cat/ls/head/find/tree to inspect the repo — those are blocked; use list_dir, read_file, search_text, or search_graph / get_code_snippet instead.",
    riskLevel: "sensitive",
    phases: BUILDING_AND_TESTING,
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
          ? `Exit ${result.exitCode}: ${args.command} (output capped at collect limit)`
          : `Exit ${result.exitCode}: ${args.command}`;
      return { summary, output: result };
    },
  });

  registry.register({
    name: "get_test_report",
    description:
      "Testing only. Structured summary of the last IDE test-gate run: suite status, platform (jest/vitest/eslint/tsc/cypress…), pass/fail/skip counts when parsed, and failed-test titles. Prefer this before read_test_log.",
    riskLevel: "safe",
    phases: TESTING_ONLY,
    argsSchema: z.object({}) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (_args, ctx) => {
      const { formatAgentTestReport } = await import("@ai-ide/shared");
      const report = ctx.testGate?.getReport() ?? null;
      const meta = ctx.testGate?.getMeta() ?? {
        escalationLevel: 0,
        circuitOpen: false,
        sameFailureStreak: 0,
      };
      const output = formatAgentTestReport(report, meta);
      const status =
        report?.status ??
        (output.available === false ? "none" : "unknown");
      return {
        summary: `Test report: ${status}`,
        output,
      };
    },
  });

  registry.register({
    name: "list_failed_tests",
    description:
      "Testing only. List individual failed test titles from the last IDE test gate, optionally filtered by suiteId (unit, lint, typecheck…). Pair with get_test_report for counts/platform.",
    riskLevel: "safe",
    phases: TESTING_ONLY,
    argsSchema: z.object({
      suiteId: z.string().min(1).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        suiteId: {
          type: "string",
          description: "Optional suite id filter (e.g. unit).",
        },
      },
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const report = ctx.testGate?.getReport() ?? null;
      if (!report) {
        return {
          summary: "No test-gate report",
          output: {
            available: false,
            failed: [],
            hint: "Wait for the IDE test gate to finish, then retry.",
          },
        };
      }
      const suiteId =
        typeof args.suiteId === "string" ? args.suiteId.trim() : "";
      const suites = report.suites.filter((s) =>
        suiteId ? s.id === suiteId : true,
      );
      const failed = suites.flatMap((s) =>
        (s.failedTests ?? []).map((name) => ({
          suiteId: s.id,
          kind: s.kind,
          platform: s.platform ?? null,
          name,
        })),
      );
      const suitesWithoutNames = suites.filter(
        (s) =>
          (s.status === "failed" || s.status === "timed_out") &&
          !(s.failedTests ?? []).length,
      );
      return {
        summary: failed.length
          ? `${failed.length} failed test(s)`
          : suitesWithoutNames.length
            ? "Suite failed but titles not parsed — use read_test_log"
            : "No failed test titles",
        output: {
          available: true,
          suiteFilter: suiteId || null,
          failed,
          suitesWithoutParsedNames: suitesWithoutNames.map((s) => ({
            suiteId: s.id,
            kind: s.kind,
            platform: s.platform ?? null,
            status: s.status,
            counts: s.counts ?? null,
          })),
        },
      };
    },
  });

  registry.register({
    name: "read_test_log",
    description:
      "Testing only. Read a chunk of an IDE test-gate suite log after a verification run. Prefer get_test_report / list_failed_tests first. Pass suiteId from the digest or report. Prefer chunkIndex (0-based); or offsetChars.",
    riskLevel: "safe",
    phases: TESTING_ONLY,
    argsSchema: z.object({
      suiteId: z.string().min(1),
      chunkIndex: z.number().int().nonnegative().optional(),
      offsetChars: z.number().int().nonnegative().optional(),
      maxChars: z.number().int().positive().max(32_000).optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        suiteId: {
          type: "string",
          description: "Suite id from the test gate digest (e.g. unit, lint).",
        },
        chunkIndex: {
          type: "number",
          description: "0-based chunk index (preferred).",
        },
        offsetChars: {
          type: "number",
          description: "Absolute char offset if not using chunkIndex.",
        },
        maxChars: {
          type: "number",
          description: "Chunk size override (default 8000, max 32000).",
        },
      },
      required: ["suiteId"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      const { TEST_LOG_CHUNK_CHARS, testLogChunkCount } = await import(
        "@ai-ide/shared"
      );
      const suiteId = String(args.suiteId);
      const log = ctx.testLogs?.get(suiteId);
      if (log === undefined) {
        return {
          summary: `No log for suite "${suiteId}"`,
          output: {
            suiteId,
            available: false,
            hint: "Logs exist only after an IDE test-gate run in this session.",
          },
        };
      }
      const maxChars =
        typeof args.maxChars === "number" ? args.maxChars : TEST_LOG_CHUNK_CHARS;
      const totalChunks = testLogChunkCount(log.length, maxChars);
      let offset = 0;
      if (typeof args.chunkIndex === "number") {
        offset = args.chunkIndex * maxChars;
      } else if (typeof args.offsetChars === "number") {
        offset = args.offsetChars;
      }
      const chunk = log.slice(offset, offset + maxChars);
      const chunkIndex = Math.floor(offset / maxChars);
      return {
        summary: `Test log ${suiteId}: chunk ${chunkIndex + 1}/${Math.max(totalChunks, 1)} (${chunk.length} chars)`,
        output: {
          suiteId,
          available: true,
          offsetChars: offset,
          maxChars,
          chunkIndex,
          totalChunks,
          totalChars: log.length,
          exhausted: offset + chunk.length >= log.length,
          text: chunk,
        },
      };
    },
  });

  registry.register({
    name: "terminal_open",
    description:
      "Open a persistent interactive terminal (PTY) in the workspace. Prefer ONE session for a toolchain stream: the IDE bootstraps nvm/fnm + .nvmrc on open so node/npm stay available. Reuse the returned terminalId with terminal_write / terminal_read — do not open a new terminal per command.",
    riskLevel: "safe",
    phases: BUILDING_AND_TESTING,
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
    phases: BUILDING_AND_TESTING,
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
    phases: BUILDING_AND_TESTING,
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
      "Send exact text to a terminal. The user gets 3s to confirm/cancel/edit (auto-approve on timeout). Prefer this for interactive commands; use terminal_ask when the user must choose. Do NOT send git commit or git push — those are harness-only via the Commit Build / Integrate banners.",
    riskLevel: "reversible",
    phases: BUILDING_AND_TESTING,
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
    phases: BUILDING_AND_TESTING,
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
    phases: BUILDING_AND_TESTING,
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
