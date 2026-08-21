import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchitectureDev, PreviewServiceRole } from "@ai-ide/shared";

/**
 * Which processes the live preview starts, and where that answer comes from.
 *
 * This file deliberately does not decide. Earlier it did, with regexes over
 * script names, and it picked `dev:e2e` over `dev` in a project whose e2e
 * variant runs on another port against a seeded database — a silent wrong
 * answer, which is the worst kind for a surface whose whole job is to show the
 * human the truth. So the repo only ever yields *candidates*: the agent reads
 * them, proposes a `dev` section for .aici/ARCHITECTURE.md, the human confirms,
 * and from then on the answer is a fact stored in the project.
 */
export type DevServiceSpec = {
  /** Stable enough to key UI state on. */
  id: string;
  name: string;
  command: string;
  role: PreviewServiceRole;
};

/** A `package.json` script that could plausibly be "run the app". */
export type DevScriptCandidate = {
  name: string;
  /** Ready to run in a terminal with this project's package manager. */
  command: string;
  /** Raw script body, so the agent can tell a wrapper from a real server. */
  script: string;
  /**
   * Names a variant meant for automated tests (`dev:e2e`, `dev:ci`, …). Still
   * offered, because a project may have nothing else, but flagged so nobody
   * previews a fixture world by accident.
   */
  testVariant: boolean;
};

const BARE_DEV_NAMES = ["dev", "develop", "start:dev"];

const TEST_VARIANT_SUFFIX =
  /^(e2e|test|tests|spec|ci|cypress|playwright|integration|debug|inspect)$/i;

function isDevScriptName(name: string): boolean {
  return BARE_DEV_NAMES.includes(name) || name.startsWith("dev:");
}

function runScript(pmBin: string, name: string): string {
  return pmBin === "npm" ? `npm run ${name}` : `${pmBin} ${name}`;
}

/**
 * Pure half, so the ordering is testable without a fixture tree. Bare `dev`
 * first and test variants last: that is the order a human would read them in,
 * and it is the order the agent sees them proposed.
 */
export function listDevScriptCandidates(input: {
  scripts: Record<string, string>;
  pmBin: string;
}): DevScriptCandidate[] {
  const { scripts, pmBin } = input;
  const candidates = Object.keys(scripts)
    .filter((name) => isDevScriptName(name) && scripts[name]?.trim())
    .map<DevScriptCandidate>((name) => ({
      name,
      command: runScript(pmBin, name),
      script: scripts[name] ?? "",
      testVariant:
        !BARE_DEV_NAMES.includes(name) &&
        TEST_VARIANT_SUFFIX.test(name.slice("dev:".length)),
    }));

  return candidates.sort((a, b) => {
    if (a.testVariant !== b.testVariant) return a.testVariant ? 1 : -1;
    const aBare = BARE_DEV_NAMES.includes(a.name);
    const bBare = BARE_DEV_NAMES.includes(b.name);
    if (aBare !== bBare) return aBare ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Lockfile order mirrors architecture detection so both agree on the runner. */
export function detectPackageManagerBin(workspaceRoot: string): string {
  if (
    existsSync(join(workspaceRoot, "pnpm-lock.yaml")) ||
    existsSync(join(workspaceRoot, "pnpm-workspace.yaml"))
  ) {
    return "pnpm";
  }
  if (existsSync(join(workspaceRoot, "yarn.lock"))) return "yarn";
  if (
    existsSync(join(workspaceRoot, "bun.lockb")) ||
    existsSync(join(workspaceRoot, "bun.lock"))
  ) {
    return "bun";
  }
  return "npm";
}

export function detectDevScriptCandidates(
  workspaceRoot: string,
): DevScriptCandidate[] {
  const pkgPath = join(workspaceRoot, "package.json");
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = parsed.scripts ?? {};
  } catch {
    return [];
  }
  return listDevScriptCandidates({
    scripts,
    pmBin: detectPackageManagerBin(workspaceRoot),
  });
}

/**
 * The confirmed answer turned into processes to start. The web target is the
 * single command the human agreed to look at; support processes run in their own
 * terminals so their output stays readable, but nothing points at them.
 */
export function devServicesFromArchitecture(
  dev: ArchitectureDev | undefined,
): DevServiceSpec[] {
  if (!dev?.command) return [];
  const web: DevServiceSpec = {
    id: "dev",
    name: "app",
    command: dev.command,
    role: "web",
  };
  const support = (dev.support ?? []).map<DevServiceSpec>((process, index) => ({
    id: `support-${index}-${process.name}`,
    name: process.name,
    command: process.command,
    role: "support",
  }));
  return [web, ...support];
}
