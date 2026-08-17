import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ARCHITECTURE_FILE_PATH,
  ArchitectureProfilePatchSchema,
  mergeArchitectureProfile,
  parseArchitectureProfile,
  parseArchitectureProfilePatch,
  createEmptyArchitectureProfile,
  type ArchitectureProfilePatch,
  type ArchitectureSource,
} from "@ai-ide/shared";

export type ArchitectureDoc = {
  overrides: ArchitectureProfilePatch;
  intent: string;
  metaSources: Record<string, ArchitectureSource>;
  updatedAt: string | null;
};

const EMPTY_DOC: ArchitectureDoc = {
  overrides: {},
  intent: "",
  metaSources: {},
  updatedAt: null,
};

/**
 * Parse `.aici/ARCHITECTURE.md` with optional YAML frontmatter.
 * Body (after frontmatter) is product intent markdown.
 */
export function parseArchitectureMarkdown(raw: string): ArchitectureDoc {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { ...EMPTY_DOC, intent: text.trim() };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { ...EMPTY_DOC, intent: text.trim() };
  }
  const yamlBlock = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  let data: unknown = {};
  if (yamlBlock) {
    data = parseYaml(yamlBlock) ?? {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("ARCHITECTURE.md frontmatter must be a YAML object.");
  }
  const record = data as Record<string, unknown>;
  const meta =
    record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? (record.meta as Record<string, unknown>)
      : {};
  const sources =
    meta.sources && typeof meta.sources === "object" && !Array.isArray(meta.sources)
      ? (meta.sources as Record<string, ArchitectureSource>)
      : {};
  const updatedAt =
    typeof meta.updatedAt === "string" ? meta.updatedAt : null;

  const { meta: _meta, intent: intentField, ...overrideFields } = record;
  const overrides = parseArchitectureProfilePatch(overrideFields);
  const intentFromField =
    typeof intentField === "string" ? intentField.trim() : "";
  const intent = (body.trim() || intentFromField).trim();

  return {
    overrides,
    intent,
    metaSources: sources,
    updatedAt,
  };
}

/** Serialize overrides + intent to ARCHITECTURE.md */
export function serializeArchitectureMarkdown(input: {
  overrides: ArchitectureProfilePatch;
  intent: string;
  sources?: Record<string, ArchitectureSource>;
}): string {
  const overrides = ArchitectureProfilePatchSchema.parse(input.overrides);
  const frontmatter: Record<string, unknown> = { ...overrides };
  frontmatter.meta = {
    updatedAt: new Date().toISOString(),
    sources: input.sources ?? {},
  };
  const yaml = stringifyYaml(frontmatter, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  }).trimEnd();
  const intent = input.intent.trim();
  if (!intent) {
    return `---\n${yaml}\n---\n`;
  }
  return `---\n${yaml}\n---\n\n${intent}\n`;
}

/** Migrate legacy full JSON profile into a doc (overrides + stub intent). */
export function legacyJsonToArchitectureDoc(raw: string): ArchitectureDoc {
  const profile = parseArchitectureProfile(JSON.parse(raw) as unknown);
  const { version: _v, meta, ...rest } = profile;
  const overrides = parseArchitectureProfilePatch(rest);
  const intent = profile.name ? `# ${profile.name}\n` : "";
  return {
    overrides,
    intent,
    metaSources: { ...(meta.sources as Record<string, ArchitectureSource>) },
    updatedAt: meta.updatedAt,
  };
}

export function architectureDocPath(): typeof ARCHITECTURE_FILE_PATH {
  return ARCHITECTURE_FILE_PATH;
}

/** Merge two sparse override patches (patch wins on present keys). */
export function mergeOverridePatches(
  base: ArchitectureProfilePatch,
  patch: ArchitectureProfilePatch,
  source: ArchitectureSource,
): {
  overrides: ArchitectureProfilePatch;
  sources: Record<string, ArchitectureSource>;
} {
  const empty = createEmptyArchitectureProfile();
  const step1 = mergeArchitectureProfile(empty, base, source);
  const step2 = mergeArchitectureProfile(step1, patch, source);
  const { version: _v, meta: _m, ...rest } = step2;
  const overrides = parseArchitectureProfilePatch(rest);
  const sources: Record<string, ArchitectureSource> = {};
  if (patch.name !== undefined) sources.name = source;
  if (patch.repo !== undefined) sources.repo = source;
  if (patch.runtimes !== undefined) sources.runtimes = source;
  if (patch.backend !== undefined) sources.backend = source;
  if (patch.frontend !== undefined) sources.frontend = source;
  if (patch.testing !== undefined) sources.testing = source;
  if (patch.quality !== undefined) sources.quality = source;
  if (patch.data !== undefined) sources.data = source;
  if (patch.api !== undefined) sources.api = source;
  return { overrides, sources };
}
