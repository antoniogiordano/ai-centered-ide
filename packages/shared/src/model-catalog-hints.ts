/**
 * Name-based catalog hints and the subset of ids we send to a lookup LLM.
 *
 * OpenAI-style /v1/models lists every fine-tune, snapshot, embedding, and
 * audio endpoint the key can see. Asking an LLM to fill vision / tools /
 * context / price for all of them in one tool call overflows the prompt and
 * the arguments JSON — that is why a 100+ model fetch "explodes".
 *
 * These helpers do the cheap part locally: skip auxiliary ids, inherit
 * fine-tunes from their base, and pre-fill well-known families. The fetch
 * path only asks the model for a short priority list. Hints never overwrite
 * a flag the human (or a previous fetch) already set.
 */

import type { ProviderModelCatalogEntry } from "./providers.js";

/** Max model ids in a single (non-sequential) lookup prompt. */
export const LOOKUP_MODEL_LIMIT = 20;

/** Safety cap for one-at-a-time lookup. Fine-tunes / auxiliary stay out. */
export const SEQUENTIAL_LOOKUP_LIMIT = 60;

export type CatalogHint = {
  vision?: boolean;
  tools?: boolean;
  contextWindowTokens?: number;
};

/** `ft:gpt-4o-mini:org::id` → `gpt-4o-mini`; `davinci:ft-personal-…` → `davinci`. */
export function catalogBaseModelId(modelId: string): string {
  const raw = modelId.trim();
  if (!raw) return raw;
  if (raw.startsWith("ft:")) {
    const base = raw.slice(3).split(":")[0]?.trim();
    return base || raw;
  }
  const legacy = /^([^:]+):ft-/.exec(raw);
  if (legacy?.[1]) return legacy[1];
  return raw;
}

/** Dated snapshots (`gpt-4o-2024-08-06`) collapse to the family alias. */
export function catalogFamilyId(modelId: string): string {
  return catalogBaseModelId(modelId)
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

export function isFineTuneModelId(modelId: string): boolean {
  const raw = modelId.trim();
  return raw.startsWith("ft:") || raw.includes(":ft-");
}

/**
 * Embeddings, audio, image-gen, moderation, and legacy completion engines.
 * Chat fine-tunes are not auxiliary — their base family decides.
 */
export function isAuxiliaryModelId(modelId: string): boolean {
  const n = catalogFamilyId(modelId).toLowerCase();
  return (
    /embedding|moderation|whisper|transcribe|tts|dall-e|gpt-image/.test(n) ||
    /^(ada|babbage|curie|davinci|text-ada|text-babbage|text-curie|text-davinci)/.test(
      n,
    )
  );
}

function isDatedSnapshotId(modelId: string): boolean {
  return /-\d{4}-\d{2}-\d{2}$/.test(modelId) || /-\d{8}$/.test(modelId);
}

function inferFamilyHints(family: string): CatalogHint {
  const n = family.toLowerCase();
  if (isAuxiliaryModelId(n)) {
    return { vision: false, tools: false };
  }
  if (n.includes("claude")) {
    return { vision: true, tools: true, contextWindowTokens: 200_000 };
  }
  if (n.includes("deepseek")) {
    return {
      vision: /vl|vision|janus/.test(n),
      tools: true,
      contextWindowTokens: 128_000,
    };
  }
  if (/^o[1-9]/.test(n)) {
    return { vision: true, tools: true, contextWindowTokens: 200_000 };
  }
  if (n.startsWith("gpt-4.1")) {
    return { vision: true, tools: true, contextWindowTokens: 1_047_576 };
  }
  if (n.startsWith("gpt-4.5") || n.startsWith("gpt-5")) {
    return { vision: true, tools: true, contextWindowTokens: 128_000 };
  }
  if (n.startsWith("gpt-4o") || n.startsWith("chatgpt-4o")) {
    return { vision: true, tools: true, contextWindowTokens: 128_000 };
  }
  if (
    n.startsWith("gpt-4-turbo") ||
    n.includes("gpt-4-vision") ||
    n.startsWith("gpt-4-1106") ||
    n.startsWith("gpt-4-0125")
  ) {
    return { vision: true, tools: true, contextWindowTokens: 128_000 };
  }
  if (n.startsWith("gpt-4")) {
    return { vision: false, tools: true, contextWindowTokens: 8_192 };
  }
  if (n.startsWith("gpt-3.5")) {
    return { vision: false, tools: true, contextWindowTokens: 16_385 };
  }
  if (/llava|bakllava|pixtral|gemma-3|qwen.*vl|\bvlm\b|vision/.test(n)) {
    return { vision: true, tools: true };
  }
  if (/instruct|chat/.test(n)) {
    return { tools: true };
  }
  return {};
}

/** Conservative name-based flags. Empty fields stay unknown — never invent a yes. */
export function inferCatalogHints(modelId: string): CatalogHint {
  const id = modelId.trim();
  if (!id) return {};
  return inferFamilyHints(catalogFamilyId(id));
}

function applyHint(
  entry: ProviderModelCatalogEntry,
  hint: CatalogHint,
): ProviderModelCatalogEntry {
  const next: ProviderModelCatalogEntry = { ...entry };
  if (next.vision === undefined && hint.vision !== undefined) {
    next.vision = hint.vision;
  }
  if (next.tools === undefined && hint.tools !== undefined) {
    next.tools = hint.tools;
  }
  if (
    next.contextWindowTokens == null &&
    hint.contextWindowTokens != null
  ) {
    next.contextWindowTokens = hint.contextWindowTokens;
  }
  return next;
}

/**
 * Fill only unknown flags. Existing yes/no/context (human or fetched) stay.
 * Fine-tunes then inherit any remaining gaps from a base/family row in the
 * same list, or from the family name if that row is missing.
 */
export function fillCatalogGaps(
  models: ProviderModelCatalogEntry[],
): ProviderModelCatalogEntry[] {
  const byId = new Map<string, ProviderModelCatalogEntry>();
  for (const entry of models) {
    const id = entry.id.trim();
    if (!id) continue;
    byId.set(id, applyHint({ ...entry, id }, inferCatalogHints(id)));
  }
  for (const [id, entry] of byId) {
    const donors = [catalogBaseModelId(id), catalogFamilyId(id)].filter(
      (donor) => donor && donor !== id,
    );
    let next = entry;
    for (const donorId of donors) {
      const donor = byId.get(donorId);
      next = applyHint(next, {
        ...(donor?.vision !== undefined ? { vision: donor.vision } : {}),
        ...(donor?.tools !== undefined ? { tools: donor.tools } : {}),
        ...(donor?.contextWindowTokens != null
          ? { contextWindowTokens: donor.contextWindowTokens }
          : inferCatalogHints(donorId)),
      });
    }
    byId.set(id, next);
  }
  return [...byId.values()];
}

function uniqueIds(ids: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Short list of current chat aliases for the lookup LLM. Fine-tunes,
 * auxiliary endpoints, and dated snapshots (when the alias exists) are
 * skipped so the tool call stays small.
 */
export function pickLookupModelIds(input: {
  modelIds: string[];
  defaultModel?: string;
  limit?: number;
}): { send: string[]; skipped: number } {
  const limit = input.limit ?? LOOKUP_MODEL_LIMIT;
  const ids = uniqueIds(input.modelIds);
  const idSet = new Set(ids);
  const preferred: string[] = [];
  const dated: string[] = [];
  for (const id of ids) {
    if (id === input.defaultModel?.trim()) continue;
    if (isFineTuneModelId(id) || isAuxiliaryModelId(id)) continue;
    if (isDatedSnapshotId(id)) {
      if (idSet.has(catalogFamilyId(id))) continue;
      dated.push(id);
    } else preferred.push(id);
  }
  const send = uniqueIds([
    input.defaultModel,
    ...preferred,
    ...dated,
  ]).slice(0, Math.max(1, limit));
  return { send, skipped: Math.max(0, ids.length - send.length) };
}

export function catalogEntryHasHint(entry: ProviderModelCatalogEntry): boolean {
  return (
    entry.vision !== undefined ||
    entry.tools !== undefined ||
    entry.contextWindowTokens != null
  );
}
