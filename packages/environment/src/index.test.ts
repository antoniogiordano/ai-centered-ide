import { describe, expect, it } from "vitest";
import {
  EnvironmentManifestSchema,
  validateManifest,
  ServiceSupervisor,
  redactSecrets,
} from "./index.js";

describe("environment manifest", () => {
  it("detects duplicate ports", () => {
    const manifest = EnvironmentManifestSchema.parse({
      version: 1,
      services: [
        { id: "a", command: "a", port: 3000, dependsOn: [] },
        { id: "b", command: "b", port: 3000, dependsOn: [] },
      ],
    });
    const issues = validateManifest(manifest);
    expect(issues.some((i) => i.code === "duplicate_port")).toBe(true);
  });

  it("supervisor start/stop orders dependencies", async () => {
    const manifest = EnvironmentManifestSchema.parse({
      version: 1,
      services: [
        { id: "web", command: "web", dependsOn: ["api"] },
        { id: "api", command: "api", dependsOn: [] },
      ],
    });
    const supervisor = new ServiceSupervisor();
    await supervisor.startOrdered(manifest);
    expect(supervisor.getState("api")).toBe("running");
    expect(supervisor.getState("web")).toBe("running");
  });

  it("redacts secrets", () => {
    expect(redactSecrets("api_key=abc123")).toContain("[REDACTED]");
  });
});
