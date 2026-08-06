import { sanitizeCommandStreams } from "./command-output.js";

const DEFAULT_MODEL_MAX_CHARS = 12_000;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n… [truncated for model context; ${omitted} chars omitted — full output is in the IDE tool log]`;
}

function compactUnknown(value: unknown, maxChars: number): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateText(value, maxChars);
  try {
    const json = JSON.stringify(value);
    if (json.length <= maxChars) return value;
    return truncateText(json, maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

/**
 * Build the tool-role message content for the LLM.
 * Full results stay on SessionState / UI — this is the compact recap only.
 */
export function formatToolResultForModel(input: {
  toolName?: string;
  summary: string;
  output?: unknown;
  error?: string | null;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? DEFAULT_MODEL_MAX_CHARS;
  let output: unknown = input.output ?? null;

  if (output && typeof output === "object" && !Array.isArray(output)) {
    const row = output as Record<string, unknown>;
    if ("stdout" in row || "stderr" in row) {
      const cleaned = sanitizeCommandStreams(
        typeof row.stdout === "string" ? row.stdout : "",
        typeof row.stderr === "string" ? row.stderr : "",
        {
          maxChars: Math.max(2_000, Math.floor(maxChars * 0.45)),
          maxLines: 200,
        },
      );
      output = {
        ...row,
        stdout: cleaned.stdout,
        stderr: cleaned.stderr,
        truncatedForModel: cleaned.truncated || Boolean(row.truncated),
        uiHasFullOutput: true,
      };
    } else {
      output = compactUnknown(output, maxChars);
    }
  } else {
    output = compactUnknown(output, maxChars);
  }

  return JSON.stringify(
    {
      summary: input.summary,
      output,
      error: input.error ?? null,
      ...(input.toolName ? { tool: input.toolName } : {}),
    },
    null,
    2,
  );
}
