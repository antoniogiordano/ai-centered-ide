/** Paths / dirs that must not flood the model via shell stdout. */
const NOISE_DIR_RE =
  /(?:^|\/|\\)(node_modules|\.git|dist|out|build|coverage|\.next|\.turbo|\.cache|__pycache__|\.venv|venv)(?:\/|\\|$)/i;

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_MAX_LINES = 200;

export type SanitizeCommandOutputOptions = {
  maxChars?: number;
  maxLines?: number;
};

export type SanitizeCommandOutputResult = {
  text: string;
  truncated: boolean;
  omittedNoiseLines: number;
};

/**
 * Strip noisy dependency trees and hard-cap size before tool results hit the LLM.
 */
export function sanitizeCommandOutput(
  raw: string,
  options?: SanitizeCommandOutputOptions,
): SanitizeCommandOutputResult {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  if (!raw) {
    return { text: "", truncated: false, omittedNoiseLines: 0 };
  }

  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let omittedNoiseLines = 0;

  for (const line of lines) {
    if (NOISE_DIR_RE.test(line)) {
      omittedNoiseLines += 1;
      continue;
    }
    kept.push(line);
  }

  let truncated = omittedNoiseLines > 0;
  let text = kept.join("\n");

  if (kept.length > maxLines) {
    text = kept.slice(0, maxLines).join("\n");
    truncated = true;
  }

  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  if (truncated) {
    const notes: string[] = [];
    if (omittedNoiseLines > 0) {
      notes.push(
        `omitted ${omittedNoiseLines} line(s) under node_modules/.git/dist/build/…`,
      );
    }
    notes.push("output truncated for model context");
    text = `${text}\n\n… [${notes.join("; ")}]`;
  }

  return { text, truncated, omittedNoiseLines };
}

export function sanitizeCommandStreams(
  stdout: string,
  stderr: string,
  options?: SanitizeCommandOutputOptions,
): {
  stdout: string;
  stderr: string;
  truncated: boolean;
  omittedNoiseLines: number;
} {
  const out = sanitizeCommandOutput(stdout, options);
  const err = sanitizeCommandOutput(stderr, options);
  return {
    stdout: out.text,
    stderr: err.text,
    truncated: out.truncated || err.truncated,
    omittedNoiseLines: out.omittedNoiseLines + err.omittedNoiseLines,
  };
}
