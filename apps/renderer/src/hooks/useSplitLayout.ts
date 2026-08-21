import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_PREFIX = "aici:split:";

function clampWeights(weights: number[], mins: number[], totalPx: number): number[] {
  if (weights.length === 0) return [];
  const safeMins = mins.map((min, i) =>
    totalPx > 0 ? Math.min(min / totalPx, 0.45) : weights[i] ?? 0,
  );
  const next = weights.map((w, i) => Math.max(w, safeMins[i] ?? 0));
  const sum = next.reduce((a, b) => a + b, 0) || 1;
  return next.map((w) => w / sum);
}

function readStored(key: string, count: number): number[] | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== count) return null;
    if (!parsed.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persistent split weights. Auto weights apply until the human drags a
 * divider; Reset layout · ⌘\ clears the stored override.
 */
export function useSplitLayout(input: {
  storageKey: string;
  count: number;
  autoWeights: number[];
  mins: number[];
  totalPx: number;
}) {
  const { storageKey, count, autoWeights, mins, totalPx } = input;
  const [manual, setManual] = useState<number[] | null>(null);

  useEffect(() => {
    function load() {
      setManual(readStored(storageKey, count));
    }
    load();
    window.addEventListener("aici:reset-split-layout", load);
    return () => window.removeEventListener("aici:reset-split-layout", load);
  }, [storageKey, count]);

  const weights = useMemo(() => {
    const base =
      manual && manual.length === count
        ? manual
        : autoWeights.length === count
          ? autoWeights
          : Array.from({ length: count }, () => 1 / Math.max(1, count));
    return clampWeights(base, mins, totalPx);
  }, [manual, autoWeights, count, mins, totalPx]);

  const commit = useCallback(
    (next: number[]) => {
      const clamped = clampWeights(next, mins, totalPx);
      setManual(clamped);
      try {
        localStorage.setItem(
          `${STORAGE_PREFIX}${storageKey}`,
          JSON.stringify(clamped),
        );
      } catch {
        /* ignore quota */
      }
    },
    [mins, storageKey, totalPx],
  );

  const reset = useCallback(() => {
    setManual(null);
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}${storageKey}`);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  return { weights, commit, reset, customized: manual != null };
}

export function resetAllSplitLayouts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("aici:reset-split-layout"));
}

export function autoCockpitWeights(input: {
  width: number;
  side: boolean;
  preview: boolean;
}): number[] {
  const { width, side, preview } = input;
  if (side && preview) {
    if (width < 1200) return [0.22, 0.2, 0.58];
    if (width < 1600) return [0.24, 0.22, 0.54];
    return [0.26, 0.22, 0.52];
  }
  if (preview) return width < 1100 ? [0.3, 0.7] : [0.32, 0.68];
  if (side) return width < 1100 ? [0.48, 0.52] : [0.52, 0.48];
  return [1];
}

export function autoBuildCockpitWeights(width: number): number[] {
  if (width < 420) return [1];
  return width < 720 ? [0.48, 0.52] : [0.52, 0.48];
}
