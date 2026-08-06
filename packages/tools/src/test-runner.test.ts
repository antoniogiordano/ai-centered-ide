import { describe, expect, it } from "vitest";
import { runTestSuites } from "./test-runner.js";

describe("runTestSuites", () => {
  it("marks all passed when commands succeed", async () => {
    const outcome = await runTestSuites({
      workspaceRoot: process.cwd(),
      specs: [
        { id: "a", kind: "other", command: "true" },
        { id: "b", kind: "other", command: "true" },
      ],
      failFast: true,
    });
    expect(outcome.failed).toBe(false);
    expect(outcome.suites.every((s) => s.status === "passed")).toBe(true);
  });

  it("fail-fast cancels siblings after first failure", async () => {
    const outcome = await runTestSuites({
      workspaceRoot: process.cwd(),
      specs: [
        { id: "fail", kind: "unit", command: "false" },
        {
          id: "slow",
          kind: "lint",
          command: "sleep 5",
          timeoutMs: 10_000,
        },
      ],
      failFast: true,
    });
    expect(outcome.failed).toBe(true);
    const fail = outcome.suites.find((s) => s.id === "fail");
    const slow = outcome.suites.find((s) => s.id === "slow");
    expect(fail?.status).toBe("failed");
    expect(slow?.status === "cancelled" || slow?.status === "failed").toBe(
      true,
    );
  });
});
