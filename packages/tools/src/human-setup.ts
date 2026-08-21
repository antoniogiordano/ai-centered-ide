/**
 * `request_human_setup`: the escape hatch for work no model can do.
 *
 * A gate failure like "can't reach the database" or "invalid OAuth client" is
 * not a bug in the code — it is a missing connection string, an account nobody
 * created, a secret the agent must never invent. Without this tool the fix loop
 * burns rounds (and money) rewriting healthy tests until the stall detector
 * stops it, and the human is left guessing which value was missing where.
 *
 * The tool turns that dead end into a checklist: the agent declares the items,
 * the IDE opens the gate circuit so nothing auto-retries, and the human gets
 * exact keys and file paths. Env items verify themselves — the IDE re-reads the
 * key names of the target file and reports which are filled — so no secret ever
 * passes through the model's context. See docs/phases/08-ambienti-servizi-env.md.
 */
import { z } from "zod";
import type { ToolPhase, ToolRegistry } from "./registry.js";

const CHECKING_BUILDING_AND_TESTING: ToolPhase[] = [
  "checking",
  "building",
  "testing",
];

export type HumanSetupDeclarationItem = {
  title: string;
  detail?: string;
  /** Gitignored env file the keys belong to, relative to the workspace root. */
  envFile?: string;
  envKeys?: string[];
  docUrl?: string;
};

export type HumanSetupDeclaration = {
  reason: string;
  items: HumanSetupDeclarationItem[];
};

export type HumanSetupCheckedItem = {
  id: string;
  title: string;
  envFile: string | null;
  /** Key names only — a value never leaves the main process. */
  presentKeys: string[];
  missingKeys: string[];
  satisfied: boolean;
};

export type HumanSetupHost = {
  /**
   * Publish the checklist, pause the gate, and verify env keys right away so the
   * agent does not ask for something the human already filled in.
   */
  declare(input: HumanSetupDeclaration): Promise<{
    items: HumanSetupCheckedItem[];
    allSatisfied: boolean;
  }>;
};

export function registerHumanSetupTools(registry: ToolRegistry): void {
  registry.register({
    name: "request_human_setup",
    description:
      "Declare setup that only the human can do and that is blocking you right now: a secret or connection string you must not invent (DATABASE_URL, AUTH_SECRET, API keys), an account or OAuth client to create, a hosted service to provision. The IDE shows it as a checklist, stops retrying the gate, and brings you back when the human is done — telling you which env keys are filled now (names only, never values). Call it only after you have seen the real failure (ran the command, read the log) and confirmed no code change can fix it. Send ONE call with every item you need, never drip-feed. For anything that lives in an env file, always set envFile + envKeys so the IDE can verify it itself instead of trusting a checkbox. Never ask the human to paste a secret into the chat, and never write a placeholder secret to make a suite pass. The IDE ends your turn on this call, so write your closing sentence in the same message.",
    riskLevel: "safe",
    phases: CHECKING_BUILDING_AND_TESTING,
    argsSchema: z.object({
      reason: z.string().min(1).max(2_000),
      items: z
        .array(
          z.object({
            title: z.string().min(1).max(200),
            detail: z.string().max(2_000).optional(),
            envFile: z.string().min(1).max(200).optional(),
            envKeys: z.array(z.string().min(1).max(200)).max(20).optional(),
            docUrl: z.string().max(500).optional(),
          }),
        )
        .min(1)
        .max(12),
    }) as z.ZodType<Record<string, unknown>>,
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "What is failing and why no code change fixes it — quote the error you saw.",
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description:
            "One entry per action the human must take. Group keys that come from the same place (one Neon branch → one item with its DATABASE_URL).",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description:
                  'Imperative one-liner, e.g. "Create the Neon e2e branch and paste its connection string".',
              },
              detail: {
                type: "string",
                description:
                  "How to get it: which console, which setting, which redirect URI. Be specific enough that the human does not have to search.",
              },
              envFile: {
                type: "string",
                description:
                  'Env file the keys go into, relative to the workspace root (e.g. ".env.e2e"). Required when envKeys is set.',
              },
              envKeys: {
                type: "array",
                items: { type: "string" },
                description:
                  "Exact key names the human must fill. The IDE verifies these itself and ticks the item when they have values.",
              },
              docUrl: {
                type: "string",
                description: "Signup or docs page for this step, if useful.",
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["reason", "items"],
      additionalProperties: false,
    },
    execute: async (args, ctx) => {
      if (!ctx.humanSetup) {
        return {
          summary: "Cannot request human setup in this environment",
          output: {
            declared: false,
            error:
              "No human available. State the blocker plainly in your reply, list the exact keys or accounts needed, and stop — do not invent secrets and do not weaken tests to get green.",
          },
        };
      }
      const items = (args.items as HumanSetupDeclarationItem[]).map((item) => ({
        title: String(item.title),
        ...(item.detail ? { detail: String(item.detail) } : {}),
        ...(item.envFile ? { envFile: String(item.envFile) } : {}),
        ...(item.envKeys?.length
          ? { envKeys: item.envKeys.map((key) => String(key)) }
          : {}),
        ...(item.docUrl ? { docUrl: String(item.docUrl) } : {}),
      }));
      const checked = await ctx.humanSetup.declare({
        reason: String(args.reason),
        items,
      });
      const missing = checked.items.filter((item) => !item.satisfied);
      return {
        summary: checked.allSatisfied
          ? `Human setup already satisfied (${checked.items.length} item${checked.items.length === 1 ? "" : "s"})`
          : `Asked the human for ${missing.length} blocking setup item${missing.length === 1 ? "" : "s"}`,
        output: {
          declared: true,
          allSatisfied: checked.allSatisfied,
          items: checked.items,
          hint: checked.allSatisfied
            ? "Every value you asked for is already in place — retry the failing work instead of waiting."
            : "The IDE paused the gate, is showing the checklist and has ended your turn here — nothing you add now is read. You will be resumed with the updated key status.",
        },
      };
    },
  });
}
