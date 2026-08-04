import { describe, expect, it } from "vitest";
import { sanitizeCommandOutput } from "./command-output.js";

describe("sanitizeCommandOutput", () => {
  it("strips node_modules lines", () => {
    const raw = [
      "package.json",
      "src/",
      "node_modules/lodash/index.js",
      "node_modules/react/package.json",
      "README.md",
    ].join("\n");
    const result = sanitizeCommandOutput(raw);
    expect(result.omittedNoiseLines).toBe(2);
    expect(result.text).toContain("package.json");
    expect(result.text).toContain("README.md");
    expect(result.text).not.toContain("lodash");
    expect(result.truncated).toBe(true);
  });

  it("caps line count", () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n");
    const result = sanitizeCommandOutput(raw, { maxLines: 10, maxChars: 100_000 });
    expect(result.truncated).toBe(true);
    expect(result.text.split("\n").filter((l) => l.startsWith("line-")).length).toBe(10);
  });
});
