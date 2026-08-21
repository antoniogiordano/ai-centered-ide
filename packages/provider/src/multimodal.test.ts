import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./index.js";
import {
  chatContentText,
  flattenVisionToText,
  messagesHaveVision,
  toPrompt,
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

  it("converts user image parts into file parts", () => {
    const prompt = toPrompt(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" },
            },
          ],
        },
      ],
      { nativeToolImages: true },
    );
    expect(prompt.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "abc" },
          },
        ],
      },
    ]);
  });
});

describe("tool result images", () => {
  const withToolImage: ChatMessage[] = [
    { role: "user", content: "why did the e2e run fail?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", name: "read_image", arguments: "{}" }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: '{"summary":"Viewing shot.png"}',
      images: [{ mime: "image/png", dataBase64: "abc", label: "shot.png" }],
    },
  ];

  it("keeps the pixels inside the tool result when the endpoint allows it", () => {
    const { messages } = toPrompt(withToolImage, { nativeToolImages: true });
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: '{"summary":"Viewing shot.png"}' },
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "data", data: "abc" },
              },
            ],
          },
        },
      ],
    });
  });

  it("hoists tool images into a synthetic user message after the tool result", () => {
    const { messages } = toPrompt(withToolImage, { nativeToolImages: false });
    // 3 internal messages become 4 on the wire: the tool result keeps its own
    // slot, the pixels get a user message of their own.
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "read_image",
          output: { type: "text", value: '{"summary":"Viewing shot.png"}' },
        },
      ],
    });
    const hoisted = messages[3] as { role: string; content: unknown[] };
    expect(hoisted.role).toBe("user");
    expect(hoisted.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("shot.png") as unknown as string,
      },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: "abc" },
      },
    ]);
  });

  it("keeps a tool batch contiguous when only the first result has images", () => {
    // The SDK throws MissingToolResultsError if a user message shows up before
    // every tool call of the batch has been answered, so the hoisted pixels
    // have to wait for the last tool result.
    const batch: ChatMessage[] = [
      { role: "user", content: "why did the e2e run fail?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", name: "read_image", arguments: "{}" },
          { id: "call_2", name: "read_file", arguments: "{}" },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"summary":"Viewing shot.png"}',
        images: [{ mime: "image/png", dataBase64: "abc", label: "shot.png" }],
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: '{"summary":"read spec.ts"}',
      },
    ];
    const { messages } = toPrompt(batch, { nativeToolImages: false });
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(JSON.stringify(messages[4])).toContain("shot.png");
  });

  it("never puts a file part on a tool message without native support", () => {
    const { messages } = toPrompt(withToolImage, { nativeToolImages: false });
    for (const message of messages) {
      if (message.role !== "tool") continue;
      expect(JSON.stringify(message)).not.toContain('"file"');
    }
  });

  it("detects vision carried by tool results", () => {
    expect(messagesHaveVision(withToolImage)).toBe(true);
    expect(
      messagesHaveVision([{ role: "tool", tool_call_id: "c", content: "{}" }]),
    ).toBe(false);
  });

  it("flattens tool images to a note for endpoints without vision", () => {
    const flat = flattenVisionToText(withToolImage);
    const toolMessage = flat[2];
    expect(toolMessage?.role).toBe("tool");
    expect("images" in (toolMessage ?? {})).toBe(false);
    expect(toolMessage?.content).toContain("cannot view images");
    expect(
      toPrompt(flat, { nativeToolImages: false }).messages,
    ).toHaveLength(3);
  });
});
