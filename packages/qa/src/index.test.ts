import { describe, expect, it } from "vitest";
import {
  generateCypressTest,
  isUrlAllowed,
  normalizeAllowedHosts,
  SemanticScenarioSchema,
} from "./index.js";

describe("qa", () => {
  it("generates cypress test preferring data-testid", () => {
    const scenario = SemanticScenarioSchema.parse({
      name: "login",
      baseUrl: "http://localhost:3000",
      steps: [
        {
          action: "click",
          testId: "submit-btn",
          description: "Submit",
        },
      ],
    });
    const code = generateCypressTest(scenario);
    expect(code).toContain("data-testid");
    expect(code).toContain("submit-btn");
  });

  it("enforces url policy", () => {
    const allowed = normalizeAllowedHosts("http://localhost:3000");
    expect(isUrlAllowed("http://localhost:3000/page", allowed)).toBe(true);
    expect(isUrlAllowed("http://evil.com", allowed)).toBe(false);
  });
});
