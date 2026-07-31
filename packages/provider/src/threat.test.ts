import { describe, expect, it } from "vitest";
import { assertHttpsForRemote } from "./types.js";
import { AppError } from "@ai-ide/shared";

describe("threat model: provider endpoint", () => {
  it("rejects remote HTTP endpoints", () => {
    expect(() => assertHttpsForRemote("http://evil.example/v1")).toThrow(AppError);
  });

  it("allows localhost HTTP and HTTPS remotes", () => {
    expect(() => assertHttpsForRemote("http://localhost:11434/v1")).not.toThrow();
    expect(() => assertHttpsForRemote("https://api.openai.com/v1")).not.toThrow();
  });
});
