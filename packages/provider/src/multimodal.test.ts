import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./index.js";
import {
  chatContentText,
  expandMessagesForOpenAi,
  flattenVisionToText,
  messagesHaveVision,
  toOpenAiMessage,
} from "./index.js";

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

describe("tool result images", () => {
  const withToolImage: ChatMessage[] = [
    { role: "user", content: "why did the e2e run fail?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", name: "read_image", arguments: "{}" },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"summary":"Viewing shot.png"}',
      images: [
        { mime: "image/png", dataBase64: "abc", label: "shot.png" },
      ],
    },
  ];

  it("hoists tool images into a synthetic user message after the tool result", () => {
    const wire = expandMessagesForOpenAi(withToolImage);
    // 3 internal messages become 4 on the wire: the tool result keeps its own
    // slot, the pixels get a user message of their own.
    expect(wire).toHaveLength(4);
    expect(wire[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"summary":"Viewing shot.png"}',
    });
    const hoisted = wire[3] as { role: string; content: unknown[] };
    expect(hoisted.role).toBe("user");
    expect(hoisted.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("shot.png") as unknown as string,
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc" },
      },
    ]);
  });

  it("never puts image_url on a tool message", () => {
    for (const message of expandMessagesForOpenAi(withToolImage)) {
      if (message.role !== "tool") continue;
      expect(JSON.stringify(message)).not.toContain("image_url");
    }
  });

  it("detects vision carried by tool results", () => {
    expect(messagesHaveVision(withToolImage)).toBe(true);
    expect(
      messagesHaveVision([
        { role: "tool", tool_call_id: "c", content: "{}" },
      ]),
    ).toBe(false);
  });

  it("flattens tool images to a note for endpoints without vision", () => {
    const flat = flattenVisionToText(withToolImage);
    const toolMessage = flat[2];
    expect(toolMessage?.role).toBe("tool");
    expect("images" in (toolMessage ?? {})).toBe(false);
    expect(toolMessage?.content).toContain("cannot view images");
    expect(expandMessagesForOpenAi(flat)).toHaveLength(3);
  });
});
