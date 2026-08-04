import { describe, expect, it } from "vitest";
import {
  ArchitectureProfileSchema,
  computeArchitectureDrift,
  createEmptyArchitectureProfile,
  formatArchitectureForPrompt,
  mergeArchitectureProfile,
  parseArchitectureProfile,
  parseArchitectureProfilePatch,
} from "./architecture.js";

describe("ArchitectureProfile", () => {
  it("parses a full v1 profile", () => {
    const profile = parseArchitectureProfile({
      version: 1,
      name: "demo",
      repo: { shape: "monorepo", packageManager: "pnpm" },
      runtimes: [{ id: "node", version: ">=22" }],
      backend: {
        language: "typescript",
        frameworks: ["express"],
        roots: ["apps/api"],
      },
      frontend: {
        language: "typescript",
        frameworks: ["react", "vite"],
        styling: ["css-modules"],
        roots: ["apps/web"],
      },
      testing: {
        unit: { lib: "vitest", command: "pnpm test" },
        e2e: { lib: "cypress", command: "pnpm cypress run", roots: ["e2e"] },
      },
      quality: {
        lint: "pnpm lint",
        typecheck: "pnpm typecheck",
      },
      data: { database: "postgres", orm: "prisma" },
      api: { style: "rest" },
      meta: {
        updatedAt: "2026-08-01T10:00:00.000Z",
        sources: { "backend.language": "user_confirmed" },
      },
    });
    expect(profile.version).toBe(1);
    expect(profile.frontend?.frameworks).toContain("react");
    expect(profile.meta.sources["backend.language"]).toBe("user_confirmed");
  });

  it("rejects wrong version", () => {
    expect(() =>
      ArchitectureProfileSchema.parse({
        version: 2,
        meta: { updatedAt: "2026-08-01T10:00:00.000Z", sources: {} },
      }),
    ).toThrow();
  });

  it("merges patches and marks sources", () => {
    const base = createEmptyArchitectureProfile("app");
    const merged = mergeArchitectureProfile(
      base,
      {
        backend: {
          language: "typescript",
          frameworks: ["express"],
          roots: ["src"],
        },
        testing: { unit: { lib: "vitest" } },
      },
      "detected",
    );
    expect(merged.backend?.language).toBe("typescript");
    expect(merged.testing?.unit?.lib).toBe("vitest");
    expect(merged.meta.sources.backend).toBe("detected");
    expect(merged.meta.sources.testing).toBe("detected");
  });

  it("does not wipe frameworks when patch only sets roots", () => {
    const base = mergeArchitectureProfile(
      createEmptyArchitectureProfile("app"),
      { backend: { frameworks: ["FastAPI"], roots: ["src"] } },
      "detected",
    );
    const merged = mergeArchitectureProfile(
      base,
      { backend: { roots: ["app"] } },
      "agent_proposed",
    );
    expect(merged.backend?.frameworks).toEqual(["FastAPI"]);
    expect(merged.backend?.roots).toEqual(["app"]);
  });

  it("coerces common LLM mistakes into a valid patch", () => {
    const patch = parseArchitectureProfilePatch({
      runtimes: [{ name: "Python" }],
      backend: { framework: "FastAPI", roots: ["src"] },
      testing: { framework: "pytest" },
      quality: { linting: "flake8", formatting: "black" },
      data: { storage: "SQLite" },
    });
    expect(patch.runtimes).toEqual([{ id: "python" }]);
    expect(patch.backend?.frameworks).toEqual(["FastAPI"]);
    expect(patch.testing?.unit?.lib).toBe("pytest");
    expect(patch.quality?.lint).toBe("flake8");
    expect(patch.quality?.format).toBe("black");
    expect(patch.data?.database).toBe("sqlite");
  });

  it("rejects modules with a guided error", () => {
    expect(() =>
      parseArchitectureProfilePatch({
        backend: { frameworks: ["FastAPI"], modules: ["rss"] },
      }),
    ).toThrow(/modules/);
    expect(() =>
      parseArchitectureProfilePatch({
        backend: { frameworks: ["FastAPI"], modules: ["rss"] },
      }),
    ).toThrow(/frameworks\[\]/);
  });

  it("reports drift when override disagrees with derived", () => {
    const derived = createEmptyArchitectureProfile("app");
    const withPm = mergeArchitectureProfile(
      derived,
      { repo: { packageManager: "pnpm" } },
      "detected",
    );
    const drift = computeArchitectureDrift(withPm, {
      repo: { packageManager: "npm" },
    });
    expect(drift.some((d) => d.path === "repo.packageManager")).toBe(true);
  });

  it("formats prompt when missing or present", () => {
    expect(formatArchitectureForPrompt(null)).toContain("missing");
    const profile = mergeArchitectureProfile(
      createEmptyArchitectureProfile("x"),
      { frontend: { language: "typescript", frameworks: ["react"], roots: [] } },
      "user_confirmed",
    );
    const text = formatArchitectureForPrompt(profile, {
      intent: "# hello",
      fromFile: true,
    });
    expect(text).toContain("Frontend:");
    expect(text).toContain("react");
    expect(text).toContain("INTENT:");
  });
});
