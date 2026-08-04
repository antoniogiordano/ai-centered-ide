import { describe, expect, it } from "vitest";
import {
  legacyJsonToArchitectureDoc,
  parseArchitectureMarkdown,
  serializeArchitectureMarkdown,
} from "./architecture-doc.js";

describe("architecture markdown doc", () => {
  it("round-trips frontmatter + intent", () => {
    const md = serializeArchitectureMarkdown({
      overrides: {
        runtimes: [{ id: "python" }],
        backend: { language: "python", frameworks: ["FastAPI"], roots: ["src"] },
      },
      intent: "# news-alert\n\nScans feeds for new items.\n",
      sources: { backend: "agent_proposed" },
    });
    expect(md.startsWith("---\n")).toBe(true);
    const doc = parseArchitectureMarkdown(md);
    expect(doc.overrides.runtimes).toEqual([{ id: "python" }]);
    expect(doc.overrides.backend?.frameworks).toContain("FastAPI");
    expect(doc.intent).toContain("news-alert");
    expect(doc.metaSources.backend).toBe("agent_proposed");
  });

  it("migrates legacy JSON profile", () => {
    const doc = legacyJsonToArchitectureDoc(
      JSON.stringify({
        version: 1,
        name: "demo",
        runtimes: [{ id: "node" }],
        backend: { language: "typescript", frameworks: ["express"], roots: ["src"] },
        meta: {
          updatedAt: "2026-08-01T10:00:00.000Z",
          sources: { backend: "user_confirmed" },
        },
      }),
    );
    expect(doc.overrides.name).toBe("demo");
    expect(doc.overrides.backend?.frameworks).toContain("express");
    expect(doc.intent).toContain("demo");
    expect(doc.metaSources.backend).toBe("user_confirmed");
  });
});
