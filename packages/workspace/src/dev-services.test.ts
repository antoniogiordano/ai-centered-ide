import { describe, expect, it } from "vitest";
import {
  devServicesFromArchitecture,
  listDevScriptCandidates,
} from "./dev-services.js";

describe("listDevScriptCandidates", () => {
  it("returns nothing when the project has no dev script", () => {
    expect(
      listDevScriptCandidates({
        scripts: { build: "tsc", test: "vitest run" },
        pmBin: "pnpm",
      }),
    ).toEqual([]);
  });

  it("offers every dev script with a runnable command", () => {
    expect(
      listDevScriptCandidates({
        scripts: { dev: "next dev --port 3012" },
        pmBin: "pnpm",
      }),
    ).toEqual([
      {
        name: "dev",
        command: "pnpm dev",
        script: "next dev --port 3012",
        testVariant: false,
      },
    ]);
  });

  it("uses npm run for npm projects", () => {
    const [candidate] = listDevScriptCandidates({
      scripts: { dev: "vite" },
      pmBin: "npm",
    });
    expect(candidate?.command).toBe("npm run dev");
  });

  it("flags test variants and sorts them last", () => {
    const candidates = listDevScriptCandidates({
      scripts: {
        "dev:e2e": "dotenv -e .env.e2e -- next dev --port 3013",
        dev: "next dev --port 3012",
      },
      pmBin: "pnpm",
    });
    expect(candidates.map((c) => [c.name, c.testVariant])).toEqual([
      ["dev", false],
      ["dev:e2e", true],
    ]);
  });

  it("keeps every scoped script, since only the agent knows which is the app", () => {
    const candidates = listDevScriptCandidates({
      scripts: {
        "dev:web": "vite",
        "dev:api": "tsx watch src/server.ts",
      },
      pmBin: "pnpm",
    });
    expect(candidates.map((c) => c.name)).toEqual(["dev:api", "dev:web"]);
  });

  it("ignores empty script bodies", () => {
    expect(
      listDevScriptCandidates({ scripts: { dev: "   " }, pmBin: "pnpm" }),
    ).toEqual([]);
  });
});

describe("devServicesFromArchitecture", () => {
  it("starts nothing until a command is confirmed", () => {
    expect(devServicesFromArchitecture(undefined)).toEqual([]);
    expect(devServicesFromArchitecture({ support: [] })).toEqual([]);
  });

  it("makes the confirmed command the single web target", () => {
    expect(devServicesFromArchitecture({ command: "pnpm dev" })).toEqual([
      { id: "dev", name: "app", command: "pnpm dev", role: "web" },
    ]);
  });

  it("runs support processes alongside without ever previewing them", () => {
    const services = devServicesFromArchitecture({
      command: "pnpm dev:web",
      support: [{ name: "api", command: "pnpm dev:api" }],
    });
    expect(services.map((s) => [s.name, s.role])).toEqual([
      ["app", "web"],
      ["api", "support"],
    ]);
  });
});
