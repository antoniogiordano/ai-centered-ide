import { describe, expect, it } from "vitest";
import { formatToolResultForModel } from "./model-output.js";

describe("formatToolResultForModel", () => {
  it("keeps small payloads intact", () => {
    const content = formatToolResultForModel({
      toolName: "read_file",
      summary: "Read a.ts",
      output: " consoles.log(1)",
    });
    const parsed = JSON.parse(content) as {
      summary: string;
      output: string;
      tool: string;
    };
    expect(parsed.tool).toBe("read_file");
    expect(parsed.summary).toBe("Read a.ts");
    expect(parsed.output).toContain("console");
  });

  it("truncates huge string outputs for the model", () => {
    const huge = "x".repeat(20_000);
    const content = formatToolResultForModel({
      summary: "Read big",
      output: huge,
      maxChars: 1000,
    });
    expect(content.length).toBeLessThan(huge.length);
    expect(content).toContain("truncated for model context");
    expect(content).toContain("full output is in the IDE tool log");
  });

  it("sanitizes command stdout/stderr for the model", () => {
    const content = formatToolResultForModel({
      toolName: "run_command",
      summary: "Exit 0",
      output: {
        stdout: "ok\nnode_modules/foo/bar.js\n",
        stderr: "",
        exitCode: 0,
      },
    });
    expect(content).toContain("truncatedForModel");
    expect(content).toContain("uiHasFullOutput");
    expect(content).not.toContain("node_modules/foo/bar.js");
  });
});
