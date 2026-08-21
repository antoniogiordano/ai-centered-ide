import { describe, expect, it } from "vitest";
import {
  buildPreviewSetupRequest,
  createEmptyPreviewSetup,
  cropRectToImagePixels,
  fitPreviewViewport,
  formatElementReference,
  isAllowedPreviewUrl,
  parseDevServerUrl,
  type PreviewElementSelection,
} from "./preview.js";

describe("isAllowedPreviewUrl", () => {
  it("allows loopback on any port", () => {
    expect(isAllowedPreviewUrl("http://localhost:5173/")).toBe(true);
    expect(isAllowedPreviewUrl("http://127.0.0.1:3000/items")).toBe(true);
    expect(isAllowedPreviewUrl("http://[::1]:8080/")).toBe(true);
    expect(isAllowedPreviewUrl("https://app.localhost:4443/")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(isAllowedPreviewUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedPreviewUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedPreviewUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isAllowedPreviewUrl("about:blank")).toBe(false);
    expect(isAllowedPreviewUrl("not a url")).toBe(false);
  });

  it("rejects remote hosts unless explicitly allowlisted", () => {
    expect(isAllowedPreviewUrl("https://example.com/")).toBe(false);
    expect(
      isAllowedPreviewUrl("https://staging.example.com/login", {
        allowedOrigins: ["https://staging.example.com"],
      }),
    ).toBe(true);
    expect(
      isAllowedPreviewUrl("https://evil.example.com/", {
        allowedOrigins: ["https://staging.example.com"],
      }),
    ).toBe(false);
  });

  it("does not treat a loopback-looking hostname as loopback", () => {
    expect(isAllowedPreviewUrl("http://localhost.evil.com/")).toBe(false);
  });
});

describe("parseDevServerUrl", () => {
  it("reads the Vite local line", () => {
    const output = [
      "  VITE v5.2.0  ready in 312 ms",
      "",
      "  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m",
      "  ➜  Network: use --host to expose",
      "  ➜  press h + enter to show help",
    ].join("\n");
    expect(parseDevServerUrl(output)).toBe("http://localhost:5173/");
  });

  it("reads the Next local line and ignores the docs link", () => {
    const output = [
      "   ▲ Next.js 15.0.0",
      "   - Local:        http://localhost:3000",
      "   - Learn more:   https://nextjs.org/docs",
    ].join("\n");
    expect(parseDevServerUrl(output)).toBe("http://localhost:3000/");
  });

  it("falls back to a bare port", () => {
    expect(parseDevServerUrl("API listening on port 3001")).toBe(
      "http://localhost:3001/",
    );
    expect(parseDevServerUrl("Server running at port 8080\n")).toBe(
      "http://localhost:8080/",
    );
  });

  it("prefers the last loopback URL when the server restarts", () => {
    const output = [
      "Local: http://localhost:5173/",
      "Port 5173 is in use, trying another one...",
      "Local: http://localhost:5174/",
    ].join("\n");
    expect(parseDevServerUrl(output)).toBe("http://localhost:5174/");
  });

  it("returns null when nothing looks like a server", () => {
    expect(parseDevServerUrl("$ pnpm dev\n")).toBeNull();
    expect(parseDevServerUrl("see https://vitejs.dev for docs")).toBeNull();
  });

  it("drops punctuation glued to the URL", () => {
    expect(parseDevServerUrl("open http://localhost:4000/.")).toBe(
      "http://localhost:4000/",
    );
  });
});

describe("fitPreviewViewport", () => {
  const pane = { x: 400, y: 120, width: 900, height: 700 };

  it("fills the pane on desktop", () => {
    expect(fitPreviewViewport(pane, "desktop")).toEqual(pane);
  });

  it("centres and letterboxes a fixed preset", () => {
    expect(fitPreviewViewport(pane, "mobile")).toEqual({
      x: 400 + (900 - 390) / 2,
      y: 120,
      width: 390,
      height: 700,
    });
  });

  it("never grows past the pane", () => {
    const narrow = { x: 0, y: 0, width: 320, height: 480 };
    expect(fitPreviewViewport(narrow, "tablet")).toEqual(narrow);
  });
});

describe("cropRectToImagePixels", () => {
  const base = {
    displayedWidth: 500,
    displayedHeight: 400,
    imageWidth: 1000,
    imageHeight: 800,
  };

  it("scales the drag to the captured bitmap", () => {
    expect(
      cropRectToImagePixels({
        ...base,
        start: { x: 100, y: 50 },
        end: { x: 300, y: 150 },
      }),
    ).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it("normalizes a drag made bottom-right to top-left", () => {
    expect(
      cropRectToImagePixels({
        ...base,
        start: { x: 300, y: 150 },
        end: { x: 100, y: 50 },
      }),
    ).toEqual({ x: 200, y: 100, width: 400, height: 200 });
  });

  it("clamps a drag that leaves the view", () => {
    const rect = cropRectToImagePixels({
      ...base,
      start: { x: -40, y: -10 },
      end: { x: 900, y: 900 },
    });
    expect(rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it("rejects a click without a drag", () => {
    expect(
      cropRectToImagePixels({
        ...base,
        start: { x: 100, y: 100 },
        end: { x: 100, y: 100 },
      }),
    ).toBeNull();
  });
});

describe("formatElementReference", () => {
  const selection: PreviewElementSelection = {
    at: "2026-08-19T10:00:00.000Z",
    url: "http://localhost:5173/settings",
    tagName: "button",
    selectors: ['[data-testid="save"]', "button.toolbar-save"],
    testId: "save",
    role: "button",
    accessibleName: "Save changes",
    text: "Save changes",
    classNames: ["toolbar-save"],
    componentChain: ["SaveButton", "Toolbar"],
    rect: { x: 10, y: 20, width: 80, height: 32 },
  };

  it("names the element, its selectors and its component chain", () => {
    expect(formatElementReference(selection)).toBe(
      [
        'Element: <button> “Save changes”',
        'Selectors: [data-testid="save"] | button.toolbar-save',
        "Components: SaveButton ‹ Toolbar",
        "Page: http://localhost:5173/settings",
      ].join("\n"),
    );
  });

  it("skips what the page could not tell us", () => {
    expect(
      formatElementReference({
        ...selection,
        accessibleName: null,
        text: null,
        selectors: [],
        componentChain: [],
        url: null,
      }),
    ).toBe("Element: <button>");
  });
});

describe("buildPreviewSetupRequest", () => {
  it("names the tool so the answer gets persisted, not just spoken", () => {
    const request = buildPreviewSetupRequest(createEmptyPreviewSetup());
    expect(request).toContain("upsert_architecture");
    expect(request).toContain("dev");
  });

  it("passes the candidates through and flags test variants", () => {
    const request = buildPreviewSetupRequest({
      ...createEmptyPreviewSetup(),
      candidates: [
        { name: "dev", command: "pnpm dev", testVariant: false },
        { name: "dev:e2e", command: "pnpm dev:e2e", testVariant: true },
      ],
    });
    expect(request).toContain("- dev: pnpm dev\n");
    expect(request).toContain("- dev:e2e: pnpm dev:e2e (looks like a test variant)");
  });
});
