import { AppError } from "@ai-ide/shared";
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ModelInfo,
} from "./types.js";
import type { AiProvider } from "./types.js";

export type MockScenarioStep =
  | { type: "content"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "delay"; ms: number }
  | { type: "error"; message: string };

export type MockScenario = {
  name: string;
  models?: ModelInfo[];
  steps: MockScenarioStep[];
};

export class MockProvider implements AiProvider {
  private cancelled = false;

  constructor(private readonly scenario: MockScenario) {}

  async listModels(): Promise<ModelInfo[]> {
    return this.scenario.models ?? [{ id: "mock-model" }];
  }

  async *chat(
    _messages: ChatMessage[],
    _options?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    this.cancelled = false;
    for (const step of this.scenario.steps) {
      if (this.cancelled) return;
      if (step.type === "delay") {
        await new Promise((r) => setTimeout(r, step.ms));
        continue;
      }
      if (step.type === "error") {
        yield {
          type: "error",
          error: new AppError({
            code: "PROVIDER_ERROR",
            userMessage: step.message,
            technicalDetail: step.message,
          }),
        };
        return;
      }
      if (step.type === "tool_call") {
        yield {
          type: "tool_call",
          id: step.id,
          name: step.name,
          argumentsDelta: JSON.stringify(step.arguments),
          index: 0,
        };
        continue;
      }
      // Stream content in small chunks so UI can show token streaming.
      const text = step.text;
      const chunkSize = 8;
      for (let i = 0; i < text.length; i += chunkSize) {
        if (this.cancelled) return;
        yield { type: "content", delta: text.slice(i, i + chunkSize) };
        await new Promise((r) => setTimeout(r, 12));
      }
    }
    yield { type: "done", finishReason: "stop" };
  }

  cancel(): void {
    this.cancelled = true;
  }
}

export const defaultMockScenario: MockScenario = {
  name: "echo",
  steps: [{ type: "content", text: "Hello from mock provider." }],
};
