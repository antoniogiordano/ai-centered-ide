import { describe, expect, it } from "vitest";
import { chatContentText, toOpenAiMessage } from "./index.js";

describe("multimodal chat messages", () => {
  it("flattens text parts", () => {
    expect(
      chatContentText([
        { type: "text", text: "hello" },
        { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });

  it("toOpenAiMessage passes image_url content parts through", () => {
    const content = [
      { type: "text" as const, text: "look" },
      {
        type: "image_url" as const,
        image_url: { url: "data:image/png;base64,abc" },
      },
    ];
    expect(toOpenAiMessage({ role: "user", content })).toEqual({
      role: "user",
      content,
    });
  });
});
