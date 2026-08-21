/**
 * Key-name view over a dotenv file.
 *
 * The agent is never allowed to see a secret value (see EnvService in
 * @ai-ide/environment), but it does need to know whether the human has filled a
 * key in yet — that is the difference between "the gate can run" and "the gate
 * will fail for a reason no model can fix". These helpers answer exactly that
 * question and nothing more: they return key names and a boolean, never the text
 * on the right of the `=`.
 *
 * Pure string work on purpose, so both the tool (through the sandboxed
 * filesystem service) and the main process (through its own reader) can use the
 * same parser without either of them owning the format.
 */

export type EnvKeyPresence = {
  key: string;
  /** The key exists and carries something that is not a template placeholder. */
  hasValue: boolean;
};

/** Strip `export ` and surrounding whitespace the way dotenv loaders do. */
function normalizeKey(raw: string): string {
  return raw.replace(/^export\s+/i, "").trim();
}

const PLACEHOLDER_EXACT =
  /^(change[_-]?me|changeme|todo|tbd|placeholder|none|unset|fill[_-]?me)$/i;
/** `CHANGE_ME.apps.googleusercontent.com`, `USER:PASSWORD@ep-xxx…`, `<your-key>`. */
const PLACEHOLDER_PARTS = [
  /change[_-]?me/i,
  /user:password/i,
  /<[a-z0-9_ -]+>/i,
  /(^|[^a-z0-9])x{3,}([^a-z0-9]|$)/i,
];

/**
 * A key copied straight from `.env.example` is not filled in.
 *
 * Without this the checklist would tick itself the moment the agent scaffolds a
 * template, which is exactly the failure this whole flow exists to prevent.
 */
export function isPlaceholderEnvValue(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (PLACEHOLDER_EXACT.test(text)) return true;
  return PLACEHOLDER_PARTS.some((pattern) => pattern.test(text));
}

export function parseEnvKeyPresence(content: string): EnvKeyPresence[] {
  const out: EnvKeyPresence[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = normalizeKey(trimmed.slice(0, eq));
    if (!key) continue;
    // Empty quotes are how a template says "fill me in"; so is CHANGE_ME.
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();
    out.push({ key, hasValue: !isPlaceholderEnvValue(value) });
  }
  return out;
}

/** Subset of `keys` that the file defines with a non-empty value. */
export function presentEnvKeys(content: string, keys: string[]): string[] {
  const present = new Set(
    parseEnvKeyPresence(content)
      .filter((entry) => entry.hasValue)
      .map((entry) => entry.key),
  );
  return keys.filter((key) => present.has(key));
}
