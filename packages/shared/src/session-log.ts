import { z } from "zod";
import { ProductPhaseSchema, type ProductPhase } from "./domain.js";
import {
  addUsage,
  emptyProviderUsage,
  estimateCostUsd,
  resolvePricingBand,
  type PricingRateBand,
  type ProviderPricing,
  type ProviderUsage,
} from "./providers.js";

/**
 * High-level per-session analytics stored in the local SQLite file.
 *
 * The human never wires a remote DB: costs are estimated from the provider
 * rates that were configured at the moment tokens were recorded, so later
 * price edits do not rewrite history. Phase slices (P/C/B/T) split wall time
 * and tokens by the model + provider that was active then.
 */

export const SessionOutcomeSchema = z.enum([
  "open",
  "commit",
  "pr",
  "merged",
  "archived",
  "discarded",
  "error",
]);
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;

export const SessionPricingSnapshotSchema = z.object({
  model: z.string().min(1),
  providerId: z.string().nullable(),
  providerName: z.string(),
  paid: z.boolean(),
  inputPer1M: z.number().optional(),
  outputPer1M: z.number().optional(),
  inputCacheHitPer1M: z.number().optional(),
  inputCacheMissPer1M: z.number().optional(),
  capturedAt: z.string().datetime(),
});
export type SessionPricingSnapshot = z.infer<
  typeof SessionPricingSnapshotSchema
>;

export const SessionPhaseSliceSchema = z.object({
  phase: ProductPhaseSchema,
  model: z.string().min(1),
  providerId: z.string().nullable(),
  providerName: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  costUsd: z.number().nullable(),
});
export type SessionPhaseSlice = z.infer<typeof SessionPhaseSliceSchema>;

export const SessionModelLogSchema = z.object({
  model: z.string().min(1),
  providerId: z.string().nullable(),
  providerName: z.string(),
  paid: z.boolean(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  costUsd: z.number().nullable(),
  pricing: SessionPricingSnapshotSchema.nullable(),
});
export type SessionModelLog = z.infer<typeof SessionModelLogSchema>;

export const SessionErrorLogSchema = z.object({
  at: z.string().datetime(),
  message: z.string().min(1),
  phase: ProductPhaseSchema.optional(),
  model: z.string().optional(),
});
export type SessionErrorLog = z.infer<typeof SessionErrorLogSchema>;

export const SessionLogSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  workspaceName: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  outcome: SessionOutcomeSchema,
  outcomeDetail: z.string().nullable(),
  featBranch: z.string().nullable(),
  buildBaseBranch: z.string().nullable(),
  models: z.array(SessionModelLogSchema),
  phases: z.array(SessionPhaseSliceSchema),
  errors: z.array(SessionErrorLogSchema),
});
export type SessionLog = z.infer<typeof SessionLogSchema>;

export function emptySessionLog(input: {
  sessionId: string;
  projectId?: string;
  title?: string;
  workspaceName?: string | null;
  startedAt?: string;
  featBranch?: string | null;
  buildBaseBranch?: string | null;
}): SessionLog {
  const now = input.startedAt ?? new Date().toISOString();
  return {
    sessionId: input.sessionId,
    projectId: input.projectId ?? "global",
    title: input.title?.trim() || "New chat",
    workspaceName: input.workspaceName ?? null,
    startedAt: now,
    endedAt: null,
    updatedAt: now,
    outcome: "open",
    outcomeDetail: null,
    featBranch: input.featBranch ?? null,
    buildBaseBranch: input.buildBaseBranch ?? null,
    models: [],
    phases: [],
    errors: [],
  };
}

export function snapshotPricing(input: {
  model: string;
  providerId: string | null;
  providerName: string;
  paid: boolean;
  pricing?: ProviderPricing | null;
  at?: Date;
}): SessionPricingSnapshot | null {
  const at = input.at ?? new Date();
  const band = resolvePricingBand(input.pricing, {
    model: input.model,
    at,
  });
  if (!band && !input.paid) {
    return {
      model: input.model,
      providerId: input.providerId,
      providerName: input.providerName,
      paid: false,
      capturedAt: at.toISOString(),
    };
  }
  if (!band) return null;
  return {
    model: input.model,
    providerId: input.providerId,
    providerName: input.providerName,
    paid: input.paid,
    capturedAt: at.toISOString(),
    ...bandRates(band),
  };
}

function bandRates(band: PricingRateBand): Partial<SessionPricingSnapshot> {
  return {
    ...(band.inputPer1M != null ? { inputPer1M: band.inputPer1M } : {}),
    ...(band.outputPer1M != null ? { outputPer1M: band.outputPer1M } : {}),
    ...(band.inputCacheHitPer1M != null
      ? { inputCacheHitPer1M: band.inputCacheHitPer1M }
      : {}),
    ...(band.inputCacheMissPer1M != null
      ? { inputCacheMissPer1M: band.inputCacheMissPer1M }
      : {}),
  };
}

function modelKey(providerId: string | null, model: string): string {
  return `${providerId ?? "none"}::${model}`;
}

function sliceKey(slice: {
  phase: ProductPhase;
  providerId: string | null;
  model: string;
}): string {
  return `${slice.phase}::${modelKey(slice.providerId, slice.model)}`;
}

export function closeOpenPhaseSlices(
  log: SessionLog,
  endedAt: string,
): SessionLog {
  const endMs = Date.parse(endedAt);
  return {
    ...log,
    updatedAt: endedAt,
    phases: log.phases.map((slice) => {
      if (slice.endedAt) return slice;
      const startMs = Date.parse(slice.startedAt);
      const durationMs = Number.isFinite(endMs) && Number.isFinite(startMs)
        ? Math.max(0, endMs - startMs)
        : slice.durationMs;
      return { ...slice, endedAt, durationMs };
    }),
  };
}

export function ensurePhaseSlice(
  log: SessionLog,
  input: {
    phase: ProductPhase;
    model: string;
    providerId: string | null;
    providerName: string;
    at: string;
  },
): SessionLog {
  const model = input.model.trim() || "unknown";
  const nextKey = sliceKey({
    phase: input.phase,
    providerId: input.providerId,
    model,
  });
  const open = [...log.phases].reverse().find((slice) => !slice.endedAt);
  if (open && sliceKey(open) === nextKey) return log;

  let next = open ? closeOpenPhaseSlices(log, input.at) : log;
  next = {
    ...next,
    updatedAt: input.at,
    phases: [
      ...next.phases,
      {
        phase: input.phase,
        model,
        providerId: input.providerId,
        providerName: input.providerName,
        startedAt: input.at,
        endedAt: null,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: null,
      },
    ],
  };
  return next;
}

export function applyUsageToSessionLog(
  log: SessionLog,
  delta: ProviderUsage,
  meta: {
    model: string;
    providerId: string | null;
    providerName: string;
    paid: boolean;
    pricing?: ProviderPricing | null;
    phase: ProductPhase;
    at?: string;
  },
): SessionLog {
  const at = meta.at ?? new Date().toISOString();
  const model = meta.model.trim() || "unknown";
  let next = ensurePhaseSlice(log, {
    phase: meta.phase,
    model,
    providerId: meta.providerId,
    providerName: meta.providerName,
    at,
  });

  const usage = addUsage(emptyProviderUsage(), delta);
  const snapshot =
    snapshotPricing({
      model,
      providerId: meta.providerId,
      providerName: meta.providerName,
      paid: meta.paid,
      ...(meta.pricing !== undefined ? { pricing: meta.pricing } : {}),
      at: new Date(at),
    }) ?? null;
  const costDelta = meta.paid
    ? estimateCostUsd(usage, meta.pricing, { model, at: new Date(at) })
    : null;

  next = {
    ...next,
    updatedAt: at,
    models: upsertModelLog(next.models, {
      model,
      providerId: meta.providerId,
      providerName: meta.providerName,
      paid: meta.paid,
      delta: usage,
      costDelta,
      snapshot,
    }),
    phases: next.phases.map((slice, index) => {
      const lastOpen =
        index === next.phases.length - 1 && slice.endedAt == null;
      if (!lastOpen) return slice;
      const inputTokens = slice.inputTokens + usage.inputTokens;
      const outputTokens = slice.outputTokens + usage.outputTokens;
      const cachedInputTokens =
        slice.cachedInputTokens + (usage.cachedInputTokens ?? 0);
      const costUsd =
        slice.costUsd == null && costDelta == null
          ? null
          : (slice.costUsd ?? 0) + (costDelta ?? 0);
      return {
        ...slice,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd,
      };
    }),
  };
  return next;
}

function upsertModelLog(
  existing: SessionModelLog[],
  input: {
    model: string;
    providerId: string | null;
    providerName: string;
    paid: boolean;
    delta: ProviderUsage;
    costDelta: number | null;
    snapshot: SessionPricingSnapshot | null;
  },
): SessionModelLog[] {
  const key = modelKey(input.providerId, input.model);
  const next = existing.map((row) => ({ ...row }));
  const idx = next.findIndex(
    (row) => modelKey(row.providerId, row.model) === key,
  );
  if (idx >= 0) {
    const row = next[idx]!;
    const costUsd =
      row.costUsd == null && input.costDelta == null
        ? null
        : (row.costUsd ?? 0) + (input.costDelta ?? 0);
    next[idx] = {
      ...row,
      inputTokens: row.inputTokens + input.delta.inputTokens,
      outputTokens: row.outputTokens + input.delta.outputTokens,
      cachedInputTokens:
        row.cachedInputTokens + (input.delta.cachedInputTokens ?? 0),
      costUsd,
      pricing: row.pricing ?? input.snapshot,
    };
    return next;
  }
  next.push({
    model: input.model,
    providerId: input.providerId,
    providerName: input.providerName,
    paid: input.paid,
    inputTokens: input.delta.inputTokens,
    outputTokens: input.delta.outputTokens,
    cachedInputTokens: input.delta.cachedInputTokens ?? 0,
    costUsd: input.costDelta,
    pricing: input.snapshot,
  });
  return next;
}

export function appendSessionError(
  log: SessionLog,
  input: { message: string; phase?: ProductPhase; model?: string; at?: string },
): SessionLog {
  const at = input.at ?? new Date().toISOString();
  const message = input.message.trim();
  if (!message) return log;
  const last = log.errors[log.errors.length - 1];
  if (last && last.message === message && last.phase === input.phase) {
    return { ...log, updatedAt: at };
  }
  return {
    ...log,
    updatedAt: at,
    errors: [
      ...log.errors,
      {
        at,
        message,
        ...(input.phase ? { phase: input.phase } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
    ],
  };
}

export function setSessionOutcome(
  log: SessionLog,
  input: {
    outcome: SessionOutcome;
    detail?: string | null;
    at?: string;
    end?: boolean;
  },
): SessionLog {
  const at = input.at ?? new Date().toISOString();
  const next = input.end ? closeOpenPhaseSlices(log, at) : log;
  return {
    ...next,
    updatedAt: at,
    outcome: input.outcome,
    outcomeDetail: input.detail ?? next.outcomeDetail,
    endedAt: input.end ? at : next.endedAt,
  };
}

export function phaseDurationTotals(
  log: SessionLog,
  now = Date.now(),
): Record<ProductPhase, number> {
  const totals: Record<ProductPhase, number> = {
    planning: 0,
    checking: 0,
    building: 0,
    testing: 0,
  };
  for (const slice of log.phases) {
    const start = Date.parse(slice.startedAt);
    const end = slice.endedAt ? Date.parse(slice.endedAt) : now;
    const ms =
      Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, end - start)
        : slice.durationMs;
    totals[slice.phase] += ms;
  }
  return totals;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem ? `${hours}h ${minRem}m` : `${hours}h`;
}

export function sessionLogTotals(log: SessionLog): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cost: number | null = null;
  for (const row of log.models) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cachedInputTokens += row.cachedInputTokens;
    if (row.costUsd != null) cost = (cost ?? 0) + row.costUsd;
  }
  return { inputTokens, outputTokens, cachedInputTokens, costUsd: cost };
}
