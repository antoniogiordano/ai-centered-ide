import { z } from "zod";

/** Canonical architecture doc (intent markdown + YAML override frontmatter). */
export const ARCHITECTURE_FILE_PATH = ".aici/ARCHITECTURE.md";

/** Pre-rename markdown path — read for migration only. */
export const ARCHITECTURE_LEGACY_MD_PATH = ".aifi/ARCHITECTURE.md";

/** Legacy full-profile JSON — read for migration only. */
export const ARCHITECTURE_LEGACY_JSON_PATH = ".aifi/architecture.json";

export const ArchitectureSourceSchema = z.enum([
  "detected",
  "user_confirmed",
  "agent_proposed",
]);
export type ArchitectureSource = z.infer<typeof ArchitectureSourceSchema>;

export const PackageManagerSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "pip",
  "poetry",
  "go",
  "custom",
]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const RepoShapeSchema = z.enum(["app", "monorepo"]);
export type RepoShape = z.infer<typeof RepoShapeSchema>;

export const LanguageSchema = z.enum([
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
]);
export type Language = z.infer<typeof LanguageSchema>;

export const RuntimeIdSchema = z.enum([
  "node",
  "python",
  "go",
  "rust",
  "jvm",
  "dotnet",
  "bun",
  "deno",
  "custom",
]);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

export const UnitTestLibSchema = z.enum([
  "vitest",
  "jest",
  "mocha",
  "pytest",
  "go_test",
  "cargo_test",
  "junit",
  "custom",
  "none",
]);
export type UnitTestLib = z.infer<typeof UnitTestLibSchema>;

export const E2eTestLibSchema = z.enum([
  "cypress",
  "playwright",
  "selenium",
  "custom",
  "none",
]);
export type E2eTestLib = z.infer<typeof E2eTestLibSchema>;

export const ApiStyleSchema = z.enum([
  "rest",
  "graphql",
  "trpc",
  "grpc",
  "none",
  "custom",
]);
export type ApiStyle = z.infer<typeof ApiStyleSchema>;

export const DatabaseSchema = z.enum([
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "none",
  "custom",
]);
export type Database = z.infer<typeof DatabaseSchema>;

export const OrmSchema = z.enum([
  "prisma",
  "drizzle",
  "typeorm",
  "sequelize",
  "sqlalchemy",
  "django_orm",
  "gorm",
  "none",
  "custom",
]);
export type Orm = z.infer<typeof OrmSchema>;

const stringList = z.array(z.string().min(1)).default([]);

export const ArchitectureRuntimeSchema = z.object({
  id: RuntimeIdSchema,
  version: z.string().min(1).optional(),
});
export type ArchitectureRuntime = z.infer<typeof ArchitectureRuntimeSchema>;

export const ArchitectureLayerSchema = z.object({
  language: LanguageSchema.optional(),
  frameworks: stringList,
  roots: stringList,
  styling: stringList.optional(),
  bundler: z.string().min(1).optional(),
});
export type ArchitectureLayer = z.infer<typeof ArchitectureLayerSchema>;

/** Patch form: no array defaults (so omitted ≠ wipe with []). Strict = reject invented keys. */
export const ArchitectureLayerPatchSchema = z
  .object({
    language: LanguageSchema.optional(),
    frameworks: z.array(z.string().min(1)).optional(),
    roots: z.array(z.string().min(1)).optional(),
    styling: z.array(z.string().min(1)).optional(),
    bundler: z.string().min(1).optional(),
  })
  .strict();

export const ArchitectureTestTargetSchema = z.object({
  lib: z.string().min(1),
  command: z.string().min(1).optional(),
  roots: stringList.optional(),
});
export type ArchitectureTestTarget = z.infer<
  typeof ArchitectureTestTargetSchema
>;

export const ArchitectureTestTargetPatchSchema = z
  .object({
    lib: z.string().min(1),
    command: z.string().min(1).optional(),
    roots: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ArchitectureTestingSchema = z.object({
  unit: ArchitectureTestTargetSchema.optional(),
  e2e: ArchitectureTestTargetSchema.optional(),
});
export type ArchitectureTesting = z.infer<typeof ArchitectureTestingSchema>;

export const ArchitectureTestingPatchSchema = z
  .object({
    unit: ArchitectureTestTargetPatchSchema.optional(),
    e2e: ArchitectureTestTargetPatchSchema.optional(),
  })
  .strict();

export const ArchitectureQualitySchema = z.object({
  lint: z.string().min(1).optional(),
  typecheck: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
});
export type ArchitectureQuality = z.infer<typeof ArchitectureQualitySchema>;

export const ArchitectureQualityPatchSchema = ArchitectureQualitySchema.strict();

export const ArchitectureDataSchema = z.object({
  database: DatabaseSchema.optional(),
  orm: OrmSchema.optional(),
});
export type ArchitectureData = z.infer<typeof ArchitectureDataSchema>;

export const ArchitectureDataPatchSchema = ArchitectureDataSchema.strict();

export const ArchitectureApiSchema = z.object({
  style: ApiStyleSchema.optional(),
});
export type ArchitectureApi = z.infer<typeof ArchitectureApiSchema>;

export const ArchitectureApiPatchSchema = ArchitectureApiSchema.strict();

export const ArchitectureDevProcessSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});
export type ArchitectureDevProcess = z.infer<
  typeof ArchitectureDevProcessSchema
>;

/**
 * How to run this project locally, for the live preview.
 *
 * Never derived from the repo: the scripts of a real project are ambiguous
 * (`dev` next to `dev:e2e` pointed at a seeded database, wrappers, one server
 * per app in a monorepo) and a wrong guess silently shows the human the wrong
 * world. The agent reads the repo and proposes, the human confirms, and the
 * answer lives here so it is asked once per project.
 */
export const ArchitectureDevSchema = z.object({
  /** The app to preview. Exactly one, run as-is in a terminal. */
  command: z.string().min(1).optional(),
  /** Processes the app needs but that are not the thing being looked at. */
  support: z.array(ArchitectureDevProcessSchema).optional(),
  /** Only when the server does not print its URL on startup. */
  url: z.string().min(1).optional(),
});
export type ArchitectureDev = z.infer<typeof ArchitectureDevSchema>;

export const ArchitectureDevPatchSchema = z
  .object({
    command: z.string().min(1).optional(),
    support: z.array(ArchitectureDevProcessSchema.strict()).optional(),
    url: z.string().min(1).optional(),
  })
  .strict();

export const ArchitectureRuntimePatchSchema = ArchitectureRuntimeSchema.strict();

export const ArchitectureMetaSchema = z.object({
  updatedAt: z.string().datetime(),
  sources: z.record(ArchitectureSourceSchema).default({}),
});
export type ArchitectureMeta = z.infer<typeof ArchitectureMetaSchema>;

export const ArchitectureProfileSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).optional(),
  repo: z
    .object({
      shape: RepoShapeSchema.optional(),
      packageManager: PackageManagerSchema.optional(),
    })
    .optional(),
  runtimes: z.array(ArchitectureRuntimeSchema).default([]),
  backend: ArchitectureLayerSchema.optional(),
  frontend: ArchitectureLayerSchema.optional(),
  testing: ArchitectureTestingSchema.optional(),
  quality: ArchitectureQualitySchema.optional(),
  data: ArchitectureDataSchema.optional(),
  api: ArchitectureApiSchema.optional(),
  dev: ArchitectureDevSchema.optional(),
  meta: ArchitectureMetaSchema,
});
export type ArchitectureProfile = z.infer<typeof ArchitectureProfileSchema>;

/** Partial patch accepted by upsert (meta.sources merged by caller). */
export const ArchitectureProfilePatchSchema = z
  .object({
    version: z.literal(1).optional(),
    name: z.string().min(1).optional(),
    repo: z
      .object({
        shape: RepoShapeSchema.optional(),
        packageManager: PackageManagerSchema.optional(),
      })
      .strict()
      .optional(),
    runtimes: z.array(ArchitectureRuntimePatchSchema).optional(),
    backend: ArchitectureLayerPatchSchema.optional(),
    frontend: ArchitectureLayerPatchSchema.optional(),
    testing: ArchitectureTestingPatchSchema.optional(),
    quality: ArchitectureQualityPatchSchema.optional(),
    data: ArchitectureDataPatchSchema.optional(),
    api: ArchitectureApiPatchSchema.optional(),
    dev: ArchitectureDevPatchSchema.optional(),
    meta: ArchitectureMetaSchema.partial().optional(),
  })
  .strict();
export type ArchitectureProfilePatch = z.infer<
  typeof ArchitectureProfilePatchSchema
>;

/** Canonical example shown to the model on tool errors / prompts. */
export const ARCHITECTURE_PATCH_EXAMPLE = {
  runtimes: [{ id: "python" }],
  backend: {
    language: "python",
    frameworks: ["FastAPI"],
    roots: ["src"],
  },
  data: { database: "sqlite" },
  testing: { unit: { lib: "pytest" } },
  quality: { lint: "flake8", format: "black" },
} as const;

export const ARCHITECTURE_PATCH_FIELD_GUIDE = [
  "runtimes: [{ id: \"node\"|\"python\"|\"go\"|\"rust\"|\"jvm\"|\"dotnet\"|\"bun\"|\"deno\"|\"custom\", version? }]",
  "backend/frontend: { language?, frameworks?: string[], roots?: string[], bundler?, styling? }",
  "testing: { unit?: { lib, command?, roots? }, e2e?: { lib, command?, roots? } }",
  "quality: { lint?, typecheck?, format? }",
  "data: { database?: \"postgres\"|\"mysql\"|\"sqlite\"|\"mongodb\"|\"redis\"|\"none\"|\"custom\", orm? }",
  "api: { style?: \"rest\"|\"graphql\"|\"trpc\"|\"grpc\"|\"none\"|\"custom\" }",
  "repo: { shape?: \"app\"|\"monorepo\", packageManager? }",
  "dev: { command?: string, support?: [{ name, command }], url? } — how to run the app locally for the live preview",
].join("\n");

const RUNTIME_ALIASES: Record<string, RuntimeId> = {
  node: "node",
  nodejs: "node",
  "node.js": "node",
  python: "python",
  go: "go",
  golang: "go",
  rust: "rust",
  java: "jvm",
  jvm: "jvm",
  bun: "bun",
  deno: "deno",
  dotnet: "dotnet",
  ".net": "dotnet",
  custom: "custom",
};

const DATABASE_ALIASES: Record<string, Database> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  sqlite: "sqlite",
  mongodb: "mongodb",
  mongo: "mongodb",
  redis: "redis",
  none: "none",
  custom: "custom",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRuntimeEntry(
  entry: unknown,
  notes: string[],
  path: string,
): unknown {
  if (typeof entry === "string") {
    const id = RUNTIME_ALIASES[entry.trim().toLowerCase()];
    if (id) {
      notes.push(`Mapped ${path} string "${entry}" → { id: "${id}" }.`);
      return { id };
    }
    return entry;
  }
  if (!isPlainObject(entry)) return entry;
  const next = { ...entry };
  if (typeof next.name === "string") {
    if (next.id === undefined) {
      const id = RUNTIME_ALIASES[next.name.trim().toLowerCase()];
      if (id) {
        next.id = id;
        notes.push(`Mapped ${path}.name "${next.name}" → id "${id}".`);
      }
    } else {
      notes.push(`Removed unsupported ${path}.name (use id only).`);
    }
    delete next.name;
  }
  return next;
}

function normalizeLayerPatch(
  layer: unknown,
  notes: string[],
  path: string,
): unknown {
  if (!isPlainObject(layer)) return layer;
  const next = { ...layer };
  if (typeof next.framework === "string") {
    if (next.frameworks === undefined) {
      next.frameworks = [next.framework];
      notes.push(`Mapped ${path}.framework → ${path}.frameworks: ["${next.framework}"].`);
    } else {
      notes.push(
        `Ignored ${path}.framework because ${path}.frameworks is already set (use frameworks: string[]).`,
      );
    }
    delete next.framework;
  }
  if (next.modules !== undefined) {
    notes.push(
      `Rejected ${path}.modules — not a schema field. Put stack libraries in ${path}.frameworks (string[]) or describe modules in chat.`,
    );
    delete next.modules;
  }
  return next;
}

function normalizeTestingPatch(
  testing: unknown,
  notes: string[],
): unknown {
  if (!isPlainObject(testing)) return testing;
  const next = { ...testing };
  if (typeof next.framework === "string") {
    const unit = isPlainObject(next.unit) ? { ...next.unit } : {};
    if (typeof unit.lib !== "string") {
      unit.lib = next.framework;
      next.unit = unit;
      notes.push(`Mapped testing.framework → testing.unit.lib "${next.framework}".`);
    } else {
      notes.push(
        "Ignored testing.framework because testing.unit.lib is already set.",
      );
    }
    delete next.framework;
  }
  if (next.coverage !== undefined) {
    notes.push(
      "Removed testing.coverage — not in schema. Put the runner in testing.unit.lib / testing.unit.command.",
    );
    delete next.coverage;
  }
  return next;
}

function normalizeQualityPatch(
  quality: unknown,
  notes: string[],
): unknown {
  if (!isPlainObject(quality)) return quality;
  const next = { ...quality };
  if (typeof next.linting === "string") {
    if (next.lint === undefined) {
      next.lint = next.linting;
      notes.push(`Mapped quality.linting → quality.lint.`);
    }
    delete next.linting;
  }
  if (typeof next.formatting === "string") {
    if (next.format === undefined) {
      next.format = next.formatting;
      notes.push(`Mapped quality.formatting → quality.format.`);
    }
    delete next.formatting;
  }
  return next;
}

function normalizeDataPatch(data: unknown, notes: string[]): unknown {
  if (!isPlainObject(data)) return data;
  const next = { ...data };
  if (typeof next.storage === "string" && next.database === undefined) {
    const db = DATABASE_ALIASES[next.storage.trim().toLowerCase()];
    if (db) {
      next.database = db;
      notes.push(`Mapped data.storage "${next.storage}" → data.database "${db}".`);
    } else {
      notes.push(
        `Removed data.storage "${next.storage}" — use data.database (${Object.keys(DATABASE_ALIASES).join("|")}).`,
      );
    }
    delete next.storage;
  } else if (next.storage !== undefined) {
    delete next.storage;
    notes.push("Removed data.storage — use data.database.");
  }
  if (next.type !== undefined) {
    notes.push(
      "Removed data.type — not in schema. Use data.database / data.orm.",
    );
    delete next.type;
  }
  return next;
}

/**
 * Coerce common LLM mistakes into the canonical patch shape.
 * Returns notes describing what was rewritten (for error messages / audits).
 */
export function coerceArchitecturePatchInput(input: unknown): {
  value: unknown;
  notes: string[];
} {
  const notes: string[] = [];
  if (!isPlainObject(input)) return { value: input, notes };
  const next = { ...input };

  if (Array.isArray(next.runtimes)) {
    next.runtimes = next.runtimes.map((entry, i) =>
      normalizeRuntimeEntry(entry, notes, `runtimes[${i}]`),
    );
  }
  if (next.backend !== undefined) {
    next.backend = normalizeLayerPatch(next.backend, notes, "backend");
  }
  if (next.frontend !== undefined) {
    next.frontend = normalizeLayerPatch(next.frontend, notes, "frontend");
  }
  if (next.testing !== undefined) {
    next.testing = normalizeTestingPatch(next.testing, notes);
  }
  if (next.quality !== undefined) {
    next.quality = normalizeQualityPatch(next.quality, notes);
  }
  if (next.data !== undefined) {
    next.data = normalizeDataPatch(next.data, notes);
  }

  return { value: next, notes };
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    if (issue.code === "unrecognized_keys") {
      const keys = Array.isArray(issue.keys) ? issue.keys : [];
      return `${path}: unknown key(s) ${keys.map((k) => `"${String(k)}"`).join(", ")} — not in ArchitectureProfile.`;
    }
    return `${path}: ${issue.message}`;
  });
}

export function formatArchitecturePatchError(
  error: unknown,
  notes: string[] = [],
): string {
  const lines = [
    "Invalid upsert_architecture patch.",
    "",
  ];
  if (error instanceof z.ZodError) {
    lines.push("Validation issues:");
    for (const issue of formatZodIssues(error)) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  } else if (error instanceof Error) {
    lines.push(error.message, "");
  }
  if (notes.length) {
    lines.push("Auto-fixes applied before validation:");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  lines.push("Expected field guide:");
  lines.push(ARCHITECTURE_PATCH_FIELD_GUIDE);
  lines.push("");
  lines.push("Example patch:");
  lines.push(JSON.stringify(ARCHITECTURE_PATCH_EXAMPLE, null, 2));
  lines.push("");
  lines.push(
    "Common mistakes: framework→frameworks[]; linting→lint; formatting→format; testing.framework→testing.unit.lib; data.storage→data.database; runtimes need {id}, not a bare string.",
  );
  return lines.join("\n");
}

/** Parse + coerce agent/UI patches; throws Error with guidance on failure. */
export function parseArchitectureProfilePatch(
  input: unknown,
): ArchitectureProfilePatch {
  const { value, notes } = coerceArchitecturePatchInput(input);
  // If coerce removed modules but left notes about rejection, fail clearly.
  const rejected = notes.filter((n) => n.startsWith("Rejected "));
  try {
    const parsed = ArchitectureProfilePatchSchema.parse(value);
    if (rejected.length) {
      throw new Error(rejected.join(" "));
    }
    return parsed;
  } catch (error) {
    throw new Error(formatArchitecturePatchError(error, notes));
  }
}

export function createEmptyArchitectureProfile(
  name?: string,
): ArchitectureProfile {
  return ArchitectureProfileSchema.parse({
    version: 1,
    ...(name ? { name } : {}),
    runtimes: [],
    meta: {
      updatedAt: new Date().toISOString(),
      sources: {},
    },
  });
}

export function parseArchitectureProfile(input: unknown): ArchitectureProfile {
  return ArchitectureProfileSchema.parse(input);
}

export function mergeArchitectureProfile(
  base: ArchitectureProfile,
  patch: ArchitectureProfilePatch,
  source: ArchitectureSource = "agent_proposed",
): ArchitectureProfile {
  const nextSources = { ...base.meta.sources, ...(patch.meta?.sources ?? {}) };

  const mark = (path: string, present: boolean) => {
    if (present && !nextSources[path]) nextSources[path] = source;
  };

  mark("name", patch.name !== undefined);
  mark("repo.shape", patch.repo?.shape !== undefined);
  mark("repo.packageManager", patch.repo?.packageManager !== undefined);
  mark("runtimes", patch.runtimes !== undefined);
  mark("backend", patch.backend !== undefined);
  mark("frontend", patch.frontend !== undefined);
  mark("testing", patch.testing !== undefined);
  mark("quality", patch.quality !== undefined);
  mark("data", patch.data !== undefined);
  mark("api", patch.api !== undefined);
  mark("dev", patch.dev !== undefined);

  const mergeLayer = (
    current: ArchitectureProfile["backend"],
    next: NonNullable<ArchitectureProfilePatch["backend"]>,
  ) => ({
    language: next.language ?? current?.language,
    // Only replace arrays when explicitly present in the patch (omit ≠ []).
    frameworks:
      next.frameworks !== undefined
        ? next.frameworks
        : (current?.frameworks ?? []),
    roots: next.roots !== undefined ? next.roots : (current?.roots ?? []),
    bundler: next.bundler ?? current?.bundler,
    styling: next.styling ?? current?.styling,
  });

  return ArchitectureProfileSchema.parse({
    version: 1,
    name: patch.name ?? base.name,
    repo: patch.repo
      ? { ...base.repo, ...patch.repo }
      : base.repo,
    runtimes: patch.runtimes ?? base.runtimes,
    backend: patch.backend
      ? mergeLayer(base.backend, patch.backend)
      : base.backend,
    frontend: patch.frontend
      ? mergeLayer(base.frontend, patch.frontend)
      : base.frontend,
    testing: patch.testing
      ? {
          ...base.testing,
          ...patch.testing,
          unit: patch.testing.unit
            ? { ...base.testing?.unit, ...patch.testing.unit }
            : base.testing?.unit,
          e2e: patch.testing.e2e
            ? { ...base.testing?.e2e, ...patch.testing.e2e }
            : base.testing?.e2e,
        }
      : base.testing,
    quality: patch.quality
      ? { ...base.quality, ...patch.quality }
      : base.quality,
    data: patch.data ? { ...base.data, ...patch.data } : base.data,
    api: patch.api ? { ...base.api, ...patch.api } : base.api,
    dev: patch.dev ? { ...base.dev, ...patch.dev } : base.dev,
    meta: {
      updatedAt: new Date().toISOString(),
      sources: nextSources,
    },
  });
}

export type ArchitectureDrift = {
  path: string;
  derived: unknown;
  override: unknown;
};

export type ArchitectureEffectiveView = {
  derived: ArchitectureProfile;
  overrides: ArchitectureProfilePatch;
  intent: string;
  effective: ArchitectureProfile;
  drift: ArchitectureDrift[];
  fromFile: boolean;
  path: string;
};

/** Strip profile to a sparse patch (no version/meta). */
export function profileToOverrides(
  profile: ArchitectureProfile | ArchitectureProfilePatch,
): ArchitectureProfilePatch {
  const {
    version: _v,
    meta: _m,
    ...rest
  } = profile as ArchitectureProfile & { version?: unknown; meta?: unknown };
  return parseArchitectureProfilePatch(rest);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Paths where an override disagrees with detection. */
export function computeArchitectureDrift(
  derived: ArchitectureProfile,
  overrides: ArchitectureProfilePatch,
): ArchitectureDrift[] {
  const drifts: ArchitectureDrift[] = [];
  const push = (path: string, d: unknown, o: unknown) => {
    if (o === undefined) return;
    if (!sameJson(d, o)) drifts.push({ path, derived: d ?? null, override: o });
  };

  if (overrides.name !== undefined) push("name", derived.name, overrides.name);
  if (overrides.repo !== undefined) {
    if (overrides.repo.shape !== undefined) {
      push("repo.shape", derived.repo?.shape, overrides.repo.shape);
    }
    if (overrides.repo.packageManager !== undefined) {
      push(
        "repo.packageManager",
        derived.repo?.packageManager,
        overrides.repo.packageManager,
      );
    }
  }
  if (overrides.runtimes !== undefined) {
    push("runtimes", derived.runtimes, overrides.runtimes);
  }
  if (overrides.backend !== undefined) {
    push("backend", derived.backend ?? null, overrides.backend);
  }
  if (overrides.frontend !== undefined) {
    push("frontend", derived.frontend ?? null, overrides.frontend);
  }
  if (overrides.testing !== undefined) {
    push("testing", derived.testing ?? null, overrides.testing);
  }
  if (overrides.quality !== undefined) {
    push("quality", derived.quality ?? null, overrides.quality);
  }
  if (overrides.data !== undefined) {
    push("data", derived.data ?? null, overrides.data);
  }
  if (overrides.api !== undefined) {
    push("api", derived.api ?? null, overrides.api);
  }
  // `dev` is intentionally absent: nothing derives it, so it would always read
  // as drift against null instead of as the answer to a question we asked.
  return drifts;
}

export function buildEffectiveArchitecture(
  derived: ArchitectureProfile,
  overrides: ArchitectureProfilePatch,
  source: ArchitectureSource = "agent_proposed",
): ArchitectureProfile {
  return mergeArchitectureProfile(derived, overrides, source);
}

/** Compact prompt block for the agent system prompt. */
export function formatArchitectureForPrompt(
  profile: ArchitectureProfile | null,
  opts?: {
    intent?: string;
    drift?: ArchitectureDrift[];
    fromFile?: boolean;
  },
): string {
  if (!profile) {
    return [
      "PROJECT ARCHITECTURE: (missing — call read_architecture).",
      `Canonical file: ${ARCHITECTURE_FILE_PATH} (markdown intent + YAML overrides; stack is detected from the repo).`,
    ].join("\n");
  }

  const lines: string[] = [
    "PROJECT ARCHITECTURE (effective = detected repo ⊕ overrides):",
    `File: ${ARCHITECTURE_FILE_PATH}${opts?.fromFile ? "" : " (no overrides file yet)"}`,
  ];
  const intent = opts?.intent?.trim();
  if (intent) {
    lines.push("INTENT:");
    lines.push(intent.length > 800 ? `${intent.slice(0, 797)}…` : intent);
    lines.push("");
  }
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.repo?.shape || profile.repo?.packageManager) {
    lines.push(
      `Repo: ${[profile.repo.shape, profile.repo.packageManager].filter(Boolean).join(" · ")}`,
    );
  }
  if (profile.runtimes.length) {
    lines.push(
      `Runtimes: ${profile.runtimes
        .map((r) => (r.version ? `${r.id} ${r.version}` : r.id))
        .join(", ")}`,
    );
  }
  if (profile.backend) {
    lines.push(
      `Backend: ${[
        profile.backend.language,
        ...(profile.backend.frameworks ?? []),
        profile.backend.roots?.length
          ? `roots=${profile.backend.roots.join(",")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}`,
    );
  }
  if (profile.frontend) {
    lines.push(
      `Frontend: ${[
        profile.frontend.language,
        ...(profile.frontend.frameworks ?? []),
        profile.frontend.bundler,
        ...(profile.frontend.styling ?? []),
        profile.frontend.roots?.length
          ? `roots=${profile.frontend.roots.join(",")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}`,
    );
  }
  if (profile.testing?.unit) {
    lines.push(
      `Unit tests: ${profile.testing.unit.lib}${profile.testing.unit.command ? ` (${profile.testing.unit.command})` : ""}`,
    );
  }
  if (profile.testing?.e2e) {
    lines.push(
      `E2E tests: ${profile.testing.e2e.lib}${profile.testing.e2e.command ? ` (${profile.testing.e2e.command})` : ""}`,
    );
  }
  if (profile.quality) {
    const q = [
      profile.quality.lint && `lint=${profile.quality.lint}`,
      profile.quality.typecheck && `typecheck=${profile.quality.typecheck}`,
      profile.quality.format && `format=${profile.quality.format}`,
    ].filter(Boolean);
    if (q.length) lines.push(`Quality: ${q.join(", ")}`);
  }
  if (profile.data?.database || profile.data?.orm) {
    lines.push(
      `Data: ${[profile.data.database, profile.data.orm].filter(Boolean).join(" · ")}`,
    );
  }
  if (profile.api?.style) lines.push(`API: ${profile.api.style}`);
  if (profile.dev?.command) {
    lines.push(
      `Run locally: ${profile.dev.command}${
        profile.dev.support?.length
          ? ` (+ ${profile.dev.support.map((s) => s.name).join(", ")})`
          : ""
      }`,
    );
  }
  if (opts?.drift?.length) {
    lines.push(
      `Drift (override ≠ detected): ${opts.drift.map((d) => d.path).join(", ")}`,
    );
  }
  lines.push(
    "Stack facts come from the repo (detected). Overrides in ARCHITECTURE.md only fix intent/ambiguity. Do not re-upsert fields that already match detection.",
  );
  if (!profile.dev?.command) {
    lines.push(
      "`dev` is never detected: if asked how to run the app for the live preview, work it out from the repo and upsert it. The human confirms before it runs.",
    );
  }
  return lines.join("\n");
}
