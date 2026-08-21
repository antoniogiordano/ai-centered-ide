import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ARCHITECTURE_FILE_PATH,
  ARCHITECTURE_LEGACY_MD_PATH,
  ARCHITECTURE_LEGACY_JSON_PATH,
  AppError,
  buildEffectiveArchitecture,
  computeArchitectureDrift,
  createEmptyArchitectureProfile,
  mergeArchitectureProfile,
  parseArchitectureProfile,
  profileToOverrides,
  type ArchitectureDrift,
  type ArchitectureProfile,
  type ArchitectureProfilePatch,
  type ArchitectureSource,
} from "@ai-ide/shared";
import { FilesystemService } from "./filesystem.js";
import {
  legacyJsonToArchitectureDoc,
  mergeOverridePatches,
  parseArchitectureMarkdown,
  serializeArchitectureMarkdown,
  type ArchitectureDoc,
} from "./architecture-doc.js";

export type ArchitectureLoadResult = {
  path: typeof ARCHITECTURE_FILE_PATH;
  exists: boolean;
  /** Effective profile (derived ⊕ overrides). */
  profile: ArchitectureProfile | null;
  error?: string;
};

export type ArchitectureEffectiveResult = {
  path: typeof ARCHITECTURE_FILE_PATH;
  exists: boolean;
  fromFile: boolean;
  derived: ArchitectureProfile;
  overrides: ArchitectureProfilePatch;
  intent: string;
  effective: ArchitectureProfile;
  drift: ArchitectureDrift[];
  error?: string;
};

function safeReadJson(absPath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(absPath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function fileExists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

function readPackageJson(root: string, rel = "package.json"): {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  workspaces?: unknown;
} | null {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  const raw = safeReadJson(abs);
  if (!raw || typeof raw !== "object") return null;
  return raw as {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: { node?: string };
    workspaces?: unknown;
  };
}

function allDeps(pkg: NonNullable<ReturnType<typeof readPackageJson>>): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
}

function hasDep(deps: string[], name: string): boolean {
  return deps.includes(name) || deps.some((d) => d.startsWith(`${name}/`));
}

function detectPackageManager(root: string): ArchitectureProfilePatch["repo"] {
  if (fileExists(root, "pnpm-lock.yaml") || fileExists(root, "pnpm-workspace.yaml")) {
    return { packageManager: "pnpm" };
  }
  if (fileExists(root, "yarn.lock")) return { packageManager: "yarn" };
  if (fileExists(root, "bun.lockb") || fileExists(root, "bun.lock")) {
    return { packageManager: "bun" };
  }
  if (fileExists(root, "package-lock.json")) return { packageManager: "npm" };
  if (fileExists(root, "package.json")) return { packageManager: "npm" };
  return undefined;
}

function detectRepoShape(root: string, pkg: ReturnType<typeof readPackageJson>): "app" | "monorepo" {
  if (
    fileExists(root, "pnpm-workspace.yaml") ||
    (pkg?.workspaces !== undefined && pkg.workspaces !== null)
  ) {
    return "monorepo";
  }
  if (fileExists(root, "apps") || fileExists(root, "packages")) {
    try {
      const apps = readdirSync(join(root, "apps"));
      if (apps.length > 0) return "monorepo";
    } catch {
      /* ignore */
    }
  }
  return "app";
}

function detectFrameworks(deps: string[]): {
  frontend: string[];
  backend: string[];
  bundler?: string;
  styling: string[];
} {
  const frontend: string[] = [];
  const backend: string[] = [];
  const styling: string[] = [];
  let bundler: string | undefined;

  if (hasDep(deps, "next")) {
    frontend.push("next");
    bundler = "next";
  } else if (hasDep(deps, "react")) {
    frontend.push("react");
  }
  if (hasDep(deps, "vue")) frontend.push("vue");
  if (hasDep(deps, "svelte")) frontend.push("svelte");
  if (hasDep(deps, "vite")) {
    frontend.push("vite");
    bundler = bundler ?? "vite";
  }
  if (hasDep(deps, "express")) backend.push("express");
  if (hasDep(deps, "fastify")) backend.push("fastify");
  if (hasDep(deps, "hono")) backend.push("hono");
  if (hasDep(deps, "nestjs") || hasDep(deps, "@nestjs/core")) backend.push("nestjs");
  if (hasDep(deps, "electron")) backend.push("electron");

  if (hasDep(deps, "tailwindcss")) styling.push("tailwind");
  if (deps.some((d) => d.includes("css-modules")) || hasDep(deps, "postcss")) {
    if (!styling.includes("css-modules") && !styling.includes("tailwind")) {
      styling.push("css-modules");
    }
  }

  return {
    frontend: unique(frontend),
    backend: unique(backend),
    styling,
    ...(bundler ? { bundler } : {}),
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function guessRoots(
  root: string,
  shape: "app" | "monorepo",
  kind: "frontend" | "backend",
): string[] {
  if (shape === "app") {
    if (fileExists(root, "src")) return ["src"];
    return ["."];
  }
  const candidates =
    kind === "frontend"
      ? ["apps/web", "apps/frontend", "apps/renderer", "apps/client", "packages/ui"]
      : ["apps/api", "apps/server", "apps/backend", "apps/desktop", "packages/server"];
  return candidates.filter((c) => fileExists(root, c));
}

/**
 * Heuristic Node/TS detection. Returns a partial profile with sources=detected.
 * Does not write to disk.
 */
export function detectArchitectureProfile(
  workspaceRoot: string,
): ArchitectureProfile {
  const pkg = readPackageJson(workspaceRoot);
  let base = createEmptyArchitectureProfile(
    pkg?.name && pkg.name !== "." ? pkg.name : basename(workspaceRoot),
  );

  if (!pkg && !fileExists(workspaceRoot, "package.json")) {
    return mergeArchitectureProfile(base, {}, "detected");
  }

  const deps = pkg ? allDeps(pkg) : [];
  const shape = detectRepoShape(workspaceRoot, pkg);
  const pm = detectPackageManager(workspaceRoot);
  const frameworks = detectFrameworks(deps);
  // Re-check vite via filesystem
  const hasViteConfig =
    fileExists(workspaceRoot, "vite.config.ts") ||
    fileExists(workspaceRoot, "vite.config.js") ||
    fileExists(workspaceRoot, "vite.config.mjs");
  if (hasViteConfig && !frameworks.frontend.includes("vite")) {
    frameworks.frontend.push("vite");
    frameworks.bundler = frameworks.bundler ?? "vite";
  }
  const hasNext =
    fileExists(workspaceRoot, "next.config.js") ||
    fileExists(workspaceRoot, "next.config.mjs") ||
    fileExists(workspaceRoot, "next.config.ts");
  if (hasNext && !frameworks.frontend.includes("next")) {
    frameworks.frontend.push("next");
    frameworks.bundler = "next";
  }

  const isTs =
    fileExists(workspaceRoot, "tsconfig.json") ||
    hasDep(deps, "typescript") ||
    deps.some((d) => d.endsWith("/typescript"));

  const language = isTs ? ("typescript" as const) : ("javascript" as const);

  const unitLib = hasDep(deps, "vitest")
    ? "vitest"
    : hasDep(deps, "jest")
      ? "jest"
      : hasDep(deps, "mocha")
        ? "mocha"
        : undefined;
  const e2eLib = hasDep(deps, "cypress")
    ? "cypress"
    : hasDep(deps, "@playwright/test") || hasDep(deps, "playwright")
      ? "playwright"
      : undefined;

  const scripts = pkg?.scripts ?? {};
  const pmBin =
    pm?.packageManager === "pnpm"
      ? "pnpm"
      : pm?.packageManager === "yarn"
        ? "yarn"
        : pm?.packageManager === "bun"
          ? "bun"
          : "npm";
  const run = (script: string) =>
    pmBin === "npm" ? `npm run ${script}` : `${pmBin} ${script}`;

  const patch: ArchitectureProfilePatch = {
    name: base.name,
    repo: {
      shape,
      ...(pm?.packageManager ? { packageManager: pm.packageManager } : {}),
    },
    runtimes: [
      {
        id: "node",
        ...(pkg?.engines?.node ? { version: pkg.engines.node } : {}),
      },
    ],
  };

  const feRoots = guessRoots(workspaceRoot, shape, "frontend");
  const beRoots = guessRoots(workspaceRoot, shape, "backend");

  if (frameworks.frontend.length || hasViteConfig || hasNext) {
    patch.frontend = {
      language,
      frameworks: frameworks.frontend,
      roots: feRoots.length ? feRoots : shape === "app" ? ["."] : [],
      ...(frameworks.bundler ? { bundler: frameworks.bundler } : {}),
      ...(frameworks.styling.length ? { styling: frameworks.styling } : {}),
    };
  }

  if (frameworks.backend.length || fileExists(workspaceRoot, "apps/desktop")) {
    patch.backend = {
      language,
      frameworks: frameworks.backend.length
        ? frameworks.backend
        : fileExists(workspaceRoot, "apps/desktop")
          ? ["electron"]
          : [],
      roots: beRoots.length ? beRoots : shape === "app" ? ["."] : [],
    };
  } else if (!patch.frontend && pkg) {
    // Generic Node package — treat as backend-ish app
    patch.backend = {
      language,
      frameworks: [],
      roots: fileExists(workspaceRoot, "src") ? ["src"] : ["."],
    };
  }

  if (unitLib || e2eLib) {
    patch.testing = {
      ...(unitLib
        ? {
            unit: {
              lib: unitLib,
              ...(scripts.test ? { command: run("test") } : {}),
            },
          }
        : {}),
      ...(e2eLib
        ? {
            e2e: {
              lib: e2eLib,
              // Semantic e2e scripts first: they usually wrap
              // start-server-and-test and are self-contained for the gate.
              // Bare `cypress` last (often `cypress open`, interactive).
              ...(() => {
                const e2eScript = [
                  "test:e2e",
                  "e2e",
                  "e2e:run",
                  "e2e:headless",
                  "cypress:run",
                  "cy:run",
                  "cypress",
                ].find((name) => scripts[name]);
                return e2eScript ? { command: run(e2eScript) } : {};
              })(),
              ...(fileExists(workspaceRoot, "cypress")
                ? { roots: ["cypress"] }
                : fileExists(workspaceRoot, "e2e")
                  ? { roots: ["e2e"] }
                  : {}),
            },
          }
        : {}),
    };
  }

  const quality: NonNullable<ArchitectureProfilePatch["quality"]> = {};
  if (scripts.lint) quality.lint = run("lint");
  if (scripts.typecheck) quality.typecheck = run("typecheck");
  else if (scripts["type-check"]) quality.typecheck = run("type-check");
  if (scripts.format) quality.format = run("format");
  if (Object.keys(quality).length) patch.quality = quality;

  if (hasDep(deps, "prisma") || hasDep(deps, "@prisma/client")) {
    patch.data = { orm: "prisma" };
  } else if (hasDep(deps, "drizzle-orm")) {
    patch.data = { orm: "drizzle" };
  }

  if (hasDep(deps, "@trpc/server") || hasDep(deps, "@trpc/client")) {
    patch.api = { style: "trpc" };
  } else if (hasDep(deps, "graphql") || hasDep(deps, "@apollo/server")) {
    patch.api = { style: "graphql" };
  } else if (frameworks.backend.length) {
    patch.api = { style: "rest" };
  }

  base = mergeArchitectureProfile(base, patch, "detected");
  return base;
}

export class ArchitectureStore {
  private readonly fs: FilesystemService;

  constructor(private readonly workspaceRoot: string) {
    this.fs = new FilesystemService(workspaceRoot);
  }

  getPath(): typeof ARCHITECTURE_FILE_PATH {
    return ARCHITECTURE_FILE_PATH;
  }

  private readDoc(): {
    doc: ArchitectureDoc;
    exists: boolean;
    error?: string;
  } {
    const mdAbs = join(this.workspaceRoot, ARCHITECTURE_FILE_PATH);
    if (existsSync(mdAbs)) {
      try {
        const raw = this.fs.read(ARCHITECTURE_FILE_PATH);
        return { doc: parseArchitectureMarkdown(raw), exists: true };
      } catch (error) {
        return {
          doc: {
            overrides: {},
            intent: "",
            metaSources: {},
            updatedAt: null,
          },
          exists: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const legacyMdAbs = join(this.workspaceRoot, ARCHITECTURE_LEGACY_MD_PATH);
    if (existsSync(legacyMdAbs)) {
      try {
        const raw = readFileSync(legacyMdAbs, "utf8");
        return { doc: parseArchitectureMarkdown(raw), exists: true };
      } catch (error) {
        return {
          doc: {
            overrides: {},
            intent: "",
            metaSources: {},
            updatedAt: null,
          },
          exists: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const legacyAbs = join(this.workspaceRoot, ARCHITECTURE_LEGACY_JSON_PATH);
    if (existsSync(legacyAbs)) {
      try {
        const raw = readFileSync(legacyAbs, "utf8");
        return { doc: legacyJsonToArchitectureDoc(raw), exists: true };
      } catch (error) {
        return {
          doc: {
            overrides: {},
            intent: "",
            metaSources: {},
            updatedAt: null,
          },
          exists: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      doc: {
        overrides: {},
        intent: "",
        metaSources: {},
        updatedAt: null,
      },
      exists: false,
    };
  }

  private writeDoc(
    doc: ArchitectureDoc,
    sources: Record<string, ArchitectureSource>,
  ): void {
    const content = serializeArchitectureMarkdown({
      overrides: doc.overrides,
      intent: doc.intent,
      sources,
    });
    this.fs.write(ARCHITECTURE_FILE_PATH, content);
  }

  /** Detected stack only (never reads overrides). */
  detect(): ArchitectureProfile {
    return detectArchitectureProfile(this.workspaceRoot);
  }

  /** Full effective view: derived ⊕ overrides + intent + drift. */
  loadEffective(): ArchitectureEffectiveResult {
    const derived = this.detect();
    const { doc, exists, error } = this.readDoc();
    if (error) {
      return {
        path: ARCHITECTURE_FILE_PATH,
        exists,
        fromFile: false,
        derived,
        overrides: {},
        intent: "",
        effective: derived,
        drift: [],
        error,
      };
    }
    const effective = buildEffectiveArchitecture(
      derived,
      doc.overrides,
      "agent_proposed",
    );
    // Preserve override provenance markers on effective meta.
    const withSources = parseArchitectureProfile({
      ...effective,
      meta: {
        ...effective.meta,
        sources: {
          ...derived.meta.sources,
          ...doc.metaSources,
        },
      },
    });
    return {
      path: ARCHITECTURE_FILE_PATH,
      exists,
      fromFile: exists,
      derived,
      overrides: doc.overrides,
      intent: doc.intent,
      effective: withSources,
      drift: computeArchitectureDrift(derived, doc.overrides),
    };
  }

  /** Back-compat: effective profile as `profile`. */
  load(): ArchitectureLoadResult {
    const view = this.loadEffective();
    return {
      path: view.path,
      exists: view.exists,
      profile: view.error ? null : view.effective,
      ...(view.error ? { error: view.error } : {}),
    };
  }

  /**
   * Save a full profile from the UI as overrides (+ optional intent).
   * Does not erase detection — stores the form as override patch.
   */
  save(
    profile: ArchitectureProfile,
    source: ArchitectureSource = "user_confirmed",
    intent?: string,
  ): ArchitectureProfile {
    const { doc } = this.readDoc();
    const overrides = profileToOverrides(profile);
    const sources: Record<string, ArchitectureSource> = {
      ...doc.metaSources,
    };
    for (const key of [
      "name",
      "repo",
      "runtimes",
      "backend",
      "frontend",
      "testing",
      "quality",
      "data",
      "api",
      "dev",
    ] as const) {
      if ((overrides as Record<string, unknown>)[key] !== undefined) {
        sources[key] = source;
      }
    }
    if (source === "user_confirmed") {
      for (const key of Object.keys(sources)) {
        if (sources[key] === "detected" || sources[key] === "agent_proposed") {
          sources[key] = "user_confirmed";
        }
      }
    }
    this.writeDoc(
      {
        overrides,
        intent: intent !== undefined ? intent : doc.intent,
        metaSources: sources,
        updatedAt: new Date().toISOString(),
      },
      sources,
    );
    return this.loadEffective().effective;
  }

  /** Merge a sparse patch into overrides (agent upsert). */
  savePatch(
    patch: ArchitectureProfilePatch,
    source: ArchitectureSource = "agent_proposed",
    intent?: string,
  ): ArchitectureProfile {
    const { doc } = this.readDoc();
    const { overrides, sources: patchSources } = mergeOverridePatches(
      doc.overrides,
      patch,
      source,
    );
    const sources = { ...doc.metaSources, ...patchSources };
    this.writeDoc(
      {
        overrides,
        intent: intent !== undefined ? intent : doc.intent,
        metaSources: sources,
        updatedAt: new Date().toISOString(),
      },
      sources,
    );
    return this.loadEffective().effective;
  }

  /** Update intent body only. */
  saveIntent(intent: string, source: ArchitectureSource = "agent_proposed"): ArchitectureProfile {
    const { doc } = this.readDoc();
    const sources = { ...doc.metaSources, intent: source };
    this.writeDoc(
      {
        ...doc,
        intent,
        metaSources: sources,
        updatedAt: new Date().toISOString(),
      },
      sources,
    );
    return this.loadEffective().effective;
  }

  /** Load effective profile (always available via detect). */
  loadOrDetect(): {
    profile: ArchitectureProfile;
    fromFile: boolean;
    path: typeof ARCHITECTURE_FILE_PATH;
    intent: string;
    drift: ArchitectureDrift[];
    derived: ArchitectureProfile;
    overrides: ArchitectureProfilePatch;
  } {
    const view = this.loadEffective();
    if (view.error) {
      throw new AppError({
        code: "VALIDATION_ERROR",
        userMessage: "Architecture file is invalid.",
        technicalDetail: view.error,
      });
    }
    return {
      profile: view.effective,
      fromFile: view.fromFile,
      path: view.path,
      intent: view.intent,
      drift: view.drift,
      derived: view.derived,
      overrides: view.overrides,
    };
  }
}

/** @internal test helper */
export function workspaceHasPackageJson(root: string): boolean {
  try {
    return statSync(join(root, "package.json")).isFile();
  } catch {
    return false;
  }
}
