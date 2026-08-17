import { describe, expect, it, vi, afterEach } from "vitest";
import { webFetchPage, webSearchQuery } from "./web.js";
import { createDefaultRegistry } from "./builtins.js";
import { getToolRisk } from "./policy.js";

describe("web tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers web_fetch and web_search as safe in all phases", () => {
    expect(getToolRisk("web_fetch")).toBe("safe");
    expect(getToolRisk("web_search")).toBe("safe");
    const registry = createDefaultRegistry();
    for (const phase of ["planning", "building", "checking", "testing"] as const) {
      const names = registry.listForPhase(phase).map((t) => t.name);
      expect(names).toContain("web_fetch");
      expect(names).toContain("web_search");
    }
  });

  it("rejects non-https and private hosts", async () => {
    await expect(webFetchPage("http://example.com/readme")).rejects.toThrow(
      /HTTPS/,
    );
    await expect(webFetchPage("https://127.0.0.1/secret")).rejects.toThrow(
      /not allowed/,
    );
    await expect(webFetchPage("https://192.168.1.1/x")).rejects.toThrow(
      /not allowed/,
    );
  });

  it("fetches HTTPS text and strips HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        url: "https://example.com/readme",
        headers: { get: () => "text/html" },
        text: async () =>
          "<html><script>evil()</script><body><h1>Joyride</h1><p>Steps API</p></body></html>",
      })),
    );
    const page = await webFetchPage("https://example.com/readme");
    expect(page.text).toContain("Joyride");
    expect(page.text).toContain("Steps API");
    expect(page.text).not.toContain("evil");
  });

  it("parses DuckDuckGo search hits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        url: "https://html.duckduckgo.com/html/",
        headers: { get: () => "text/html" },
        text: async () => `
          <a rel="nofollow" class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://github.com/gilbarbara/react-joyride")}">react-joyride</a>
          <a class="result__snippet">Product tour library</a>
        `,
      })),
    );
    const result = await webSearchQuery("react-joyride readme", 5);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.url).toContain("react-joyride");
  });
});
