import { z } from "zod";
import type { ToolRegistry, ToolPhase } from "./registry.js";

/**
 * Planning already has `set_questions` + the Plan Q&A dialog for batching
 * clarifications before a plan exists. ask_user covers the other phases, where
 * a decision surfaces mid-implementation and the answer is needed immediately.
 */
const CHECKING_BUILDING_AND_TESTING: ToolPhase[] = [
  "checking",
  "building",
  "testing",
];

export function registerAskTools(registry: ToolRegistry): void {
  registry.register({
    name: "ask_user",
    description:
      "Ask the user to settle a structural decision you cannot resolve on your own, and wait for the answer. Use it when you have diagnosed a problem but several fixes are legitimate and the choice is the user's (which approach to take, whether to change production code or only tests, whether to widen scope). Do NOT use it for things you can determine yourself by reading code, running a command or looking at a screenshot — investigate first, ask only about the trade-off. State what you found in `context`, then offer 2-8 concrete options; put your recommendation first and mark it '(Recommended)'.",
    riskLevel: "safe",
    phases: CHECKING_BUILDING_AND_TESTING,
    argsSchema: z.object({
      context: z.string().max(4_000).optional(),
      prompt: z.string().min(1).max(2_000),
      selection: z.enum(["single", "multiple"]).optional(),
      options: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1).max(500),
          }),
        )
        .min(2)
        .max(8),
      allowFreeText: z.boolean().optional(),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "What you found that forced the question — the diagnosis, in one or two sentences.",
        },
        prompt: {
          type: "string",
          description: "The question itself, without listing the options.",
        },
        selection: {
          type: "string",
          enum: ["single", "multiple"],
          description:
            "single (default) = the user picks one option; multiple = the user may pick several.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
        allowFreeText: {
          type: "boolean",
          description:
            "Allow the user to type an answer instead of picking an option. Default true.",
        },
      },
      required: ["prompt", "options"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.ask) {
        return {
          summary: "Cannot ask the user in this environment",
          output: {
            asked: false,
            error:
              "No interactive user available. Decide yourself using the most reversible option and say what you assumed.",
          },
        };
      }
      const options = (args.options as Array<{ id: string; label: string }>).map(
        (o) => ({ id: String(o.id), label: String(o.label) }),
      );
      const answer = await ctx.ask.ask({
        ...(typeof args.context === "string" ? { context: args.context } : {}),
        prompt: String(args.prompt),
        selection: args.selection === "multiple" ? "multiple" : "single",
        options,
        allowFreeText: args.allowFreeText !== false,
      });
      if (answer.cancelled) {
        return {
          summary: "User dismissed the question",
          output: {
            asked: true,
            cancelled: true,
            hint: "The user did not answer. Do not ask again for the same decision — pick the most reversible option and state your assumption.",
          },
        };
      }
      const chosen = answer.selectedLabels.join(", ");
      const summary = chosen
        ? `User chose: ${chosen}`
        : `User answered in free text (${answer.text.length} chars)`;
      return {
        summary,
        output: {
          asked: true,
          cancelled: false,
          selectedOptionIds: answer.selectedOptionIds,
          selectedLabels: answer.selectedLabels,
          text: answer.text,
        },
      };
    },
  });
}
