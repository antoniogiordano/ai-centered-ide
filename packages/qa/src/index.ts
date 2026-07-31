import { z } from "zod";

export const BrowserObservationSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  timestamp: z.string().datetime(),
  elements: z.array(
    z.object({
      testId: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      text: z.string().optional(),
    }),
  ),
});
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;

export const RecorderEventSchema = z.object({
  type: z.enum(["click", "type", "navigate", "assert"]),
  timestamp: z.number(),
  selector: z.string().optional(),
  testId: z.string().optional(),
  value: z.string().optional(),
  url: z.string().optional(),
});
export type RecorderEvent = z.infer<typeof RecorderEventSchema>;

export const RecorderTraceSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime(),
  events: z.array(RecorderEventSchema),
});
export type RecorderTrace = z.infer<typeof RecorderTraceSchema>;

export const SemanticStepSchema = z.object({
  action: z.enum(["visit", "click", "type", "shouldContain", "shouldBeVisible"]),
  target: z.string().optional(),
  testId: z.string().optional(),
  value: z.string().optional(),
  description: z.string(),
});
export type SemanticStep = z.infer<typeof SemanticStepSchema>;

export const SemanticScenarioSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  steps: z.array(SemanticStepSchema).min(1),
});
export type SemanticScenario = z.infer<typeof SemanticScenarioSchema>;

export function isUrlAllowed(url: string, allowedHosts: string[]): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return allowedHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function normalizeAllowedHosts(baseUrl: string, extra: string[] = []): string[] {
  const hosts = new Set(extra);
  hosts.add(new URL(baseUrl).hostname);
  hosts.add("localhost");
  hosts.add("127.0.0.1");
  return [...hosts];
}

function selectorForStep(step: SemanticStep): string {
  if (step.testId) return `[data-testid="${step.testId}"]`;
  if (step.target) return step.target;
  throw new Error(`Step ${step.description} needs testId or target`);
}

export function generateCypressTest(scenario: SemanticScenario): string {
  const lines: string[] = [
    `describe(${JSON.stringify(scenario.name)}, () => {`,
    `  it("runs recorded scenario", () => {`,
    `    cy.visit(${JSON.stringify(scenario.baseUrl)});`,
  ];

  for (const step of scenario.steps) {
    switch (step.action) {
      case "visit":
        lines.push(`    cy.visit(${JSON.stringify(step.value ?? scenario.baseUrl)});`);
        break;
      case "click":
        lines.push(`    cy.get(${JSON.stringify(selectorForStep(step))}).click();`);
        break;
      case "type":
        lines.push(
          `    cy.get(${JSON.stringify(selectorForStep(step))}).type(${JSON.stringify(step.value ?? "")});`,
        );
        break;
      case "shouldContain":
        lines.push(
          `    cy.get(${JSON.stringify(selectorForStep(step))}).should("contain", ${JSON.stringify(step.value ?? "")});`,
        );
        break;
      case "shouldBeVisible":
        lines.push(
          `    cy.get(${JSON.stringify(selectorForStep(step))}).should("be.visible");`,
        );
        break;
    }
  }

  lines.push("  });", "});", "");
  return lines.join("\n");
}

export function traceToSemanticScenario(
  trace: RecorderTrace,
  baseUrl: string,
  name: string,
): SemanticScenario {
  const steps: SemanticStep[] = trace.events.map((event) => {
    if (event.type === "navigate") {
      return {
        action: "visit",
        value: event.url ?? baseUrl,
        description: `Navigate to ${event.url ?? baseUrl}`,
      };
    }
    if (event.type === "click") {
      return {
        action: "click",
        testId: event.testId,
        target: event.selector,
        description: `Click ${event.testId ?? event.selector ?? "element"}`,
      };
    }
    return {
      action: "type",
      testId: event.testId,
      target: event.selector,
      value: event.value,
      description: `Type into ${event.testId ?? event.selector ?? "field"}`,
    };
  });

  return SemanticScenarioSchema.parse({ name, baseUrl, steps });
}
