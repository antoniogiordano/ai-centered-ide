import { describe, expect, it } from "vitest";
import { AppError } from "@ai-ide/shared";
import { MockProvider, parseSseDataLines } from "./index.js";
import {
  assertHttpsForRemote,
  classifyProviderError,
  isRetryable,
} from "./types.js";

describe("provider", () => {
  it("parses SSE data lines", () => {
    const lines = parseSseDataLines(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n',
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toHaveProperty("choices");
  });

  it("streams mock content", async () => {
    const provider = new MockProvider({
      name: "test",
      steps: [{ type: "content", text: "ok" }],
    });
    const chunks = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hi" }])) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.type === "content" && c.delta === "ok")).toBe(true);
  });

  it("requires HTTPS for remote hosts", () => {
    expect(() => assertHttpsForRemote("http://api.example.com/v1")).toThrow(AppError);
    expect(() => assertHttpsForRemote("http://localhost:8080/v1")).not.toThrow();
  });

  it("classifies retryable errors", () => {
    expect(isRetryable(classifyProviderError(new Error("HTTP 429")))).toBe(true);
    expect(isRetryable(classifyProviderError(new Error("HTTP 401")))).toBe(false);
  });
});
