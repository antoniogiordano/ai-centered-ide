import { useEffect, useRef, useState } from "react";
import {
  formatPeakWindowsUtc,
  guessPricingDocsUrl,
  parsePeakWindowsUtc,
  parseUsdRate,
  REASONING_EFFORT_VALUES,
  type ProviderPricing,
  type ReasoningEffort,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";

/** Digit shortcut (1-based) and label for each effort button. */
const EFFORT_OPTIONS = REASONING_EFFORT_VALUES.map((value, i) => ({
  value,
  shortcut: String(i + 1),
  label:
    value === "xhigh"
      ? "XHigh"
      : value.charAt(0).toUpperCase() + value.slice(1),
}));

type View = "list" | "form";

type ListedProvider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  paid: boolean;
  contextWindowTokens?: number | undefined;
};

type PricingFormFields = {
  inputPer1M: string;
  outputPer1M: string;
  inputCacheHitPer1M: string;
  inputCacheMissPer1M: string;
  useSchedule: boolean;
  peakWindows: string;
  peakInput: string;
  peakOutput: string;
  peakCacheHit: string;
  peakCacheMiss: string;
  offPeakInput: string;
  offPeakOutput: string;
  offPeakCacheHit: string;
  offPeakCacheMiss: string;
  docsUrl: string;
  pricingNotes: string;
  /** Full byModel / metadata from last fetch — preserved on save. */
  pricingExtra: Pick<
    ProviderPricing,
    "byModel" | "sourceUrl" | "notes" | "fetchedAt"
  > | null;
};

function emptyPricingFields(): PricingFormFields {
  return {
    inputPer1M: "",
    outputPer1M: "",
    inputCacheHitPer1M: "",
    inputCacheMissPer1M: "",
    useSchedule: false,
    peakWindows: "",
    peakInput: "",
    peakOutput: "",
    peakCacheHit: "",
    peakCacheMiss: "",
    offPeakInput: "",
    offPeakOutput: "",
    offPeakCacheHit: "",
    offPeakCacheMiss: "",
    docsUrl: "",
    pricingNotes: "",
    pricingExtra: null,
  };
}

function rateStr(n: number | undefined | null): string {
  return n != null ? String(n) : "";
}

function pricingToFields(pricing: ProviderPricing | null | undefined): PricingFormFields {
  if (!pricing) return emptyPricingFields();
  const schedule = pricing.schedule;
  const useSchedule = Boolean(
    schedule?.peakWindowsUtc?.length ||
      schedule?.peak ||
      schedule?.offPeak,
  );
  return {
    inputPer1M: rateStr(pricing.inputPer1M),
    outputPer1M: rateStr(pricing.outputPer1M),
    inputCacheHitPer1M: rateStr(pricing.inputCacheHitPer1M),
    inputCacheMissPer1M: rateStr(pricing.inputCacheMissPer1M),
    useSchedule,
    peakWindows: formatPeakWindowsUtc(schedule?.peakWindowsUtc),
    peakInput: rateStr(schedule?.peak?.inputPer1M),
    peakOutput: rateStr(schedule?.peak?.outputPer1M),
    peakCacheHit: rateStr(schedule?.peak?.inputCacheHitPer1M),
    peakCacheMiss: rateStr(schedule?.peak?.inputCacheMissPer1M),
    offPeakInput: rateStr(schedule?.offPeak?.inputPer1M),
    offPeakOutput: rateStr(schedule?.offPeak?.outputPer1M),
    offPeakCacheHit: rateStr(schedule?.offPeak?.inputCacheHitPer1M),
    offPeakCacheMiss: rateStr(schedule?.offPeak?.inputCacheMissPer1M),
    docsUrl: pricing.sourceUrl ?? "",
    pricingNotes: pricing.notes ?? "",
    pricingExtra: {
      ...(pricing.byModel ? { byModel: pricing.byModel } : {}),
      ...(pricing.sourceUrl ? { sourceUrl: pricing.sourceUrl } : {}),
      ...(pricing.notes ? { notes: pricing.notes } : {}),
      ...(pricing.fetchedAt ? { fetchedAt: pricing.fetchedAt } : {}),
    },
  };
}

function parseOptionalRate(
  raw: string,
  label: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  const value = parseUsdRate(trimmed);
  if (value == null) {
    return {
      ok: false,
      error: `${label} is invalid. Use a number like 2.5 or 2,5.`,
    };
  }
  return { ok: true, value };
}

function buildBand(fields: {
  input: string;
  output: string;
  hit: string;
  miss: string;
}):
  | { ok: true; band?: import("@ai-ide/shared").PricingRateBand }
  | { ok: false; error: string } {
  const input = parseOptionalRate(fields.input, "Input $/1M");
  if (!input.ok) return input;
  const output = parseOptionalRate(fields.output, "Output $/1M");
  if (!output.ok) return output;
  const hit = parseOptionalRate(fields.hit, "Cache hit $/1M");
  if (!hit.ok) return hit;
  const miss = parseOptionalRate(fields.miss, "Cache miss $/1M");
  if (!miss.ok) return miss;
  const band = {
    ...(input.value != null ? { inputPer1M: input.value } : {}),
    ...(output.value != null ? { outputPer1M: output.value } : {}),
    ...(hit.value != null ? { inputCacheHitPer1M: hit.value } : {}),
    ...(miss.value != null ? { inputCacheMissPer1M: miss.value } : {}),
  };
  return {
    ok: true,
    ...(Object.keys(band).length ? { band } : {}),
  };
}

function buildPricingFromFields(
  fields: PricingFormFields,
): { ok: true; pricing?: ProviderPricing } | { ok: false; error: string } {
  const flat = buildBand({
    input: fields.inputPer1M,
    output: fields.outputPer1M,
    hit: fields.inputCacheHitPer1M,
    miss: fields.inputCacheMissPer1M,
  });
  if (!flat.ok) return flat;

  let schedule: ProviderPricing["schedule"] | undefined;
  if (fields.useSchedule) {
    const windowsRaw = fields.peakWindows.trim();
    const windows = windowsRaw ? parsePeakWindowsUtc(windowsRaw) : undefined;
    if (windowsRaw && !windows) {
      return {
        ok: false,
        error:
          "Peak windows invalid. Use UTC ranges like 01:00-04:00, 06:00-10:00.",
      };
    }
    const peak = buildBand({
      input: fields.peakInput,
      output: fields.peakOutput,
      hit: fields.peakCacheHit,
      miss: fields.peakCacheMiss,
    });
    if (!peak.ok) return peak;
    const offPeak = buildBand({
      input: fields.offPeakInput,
      output: fields.offPeakOutput,
      hit: fields.offPeakCacheHit,
      miss: fields.offPeakCacheMiss,
    });
    if (!offPeak.ok) return offPeak;
    if (windows?.length || peak.band || offPeak.band) {
      schedule = {
        peakWindowsUtc: windows ?? [],
        ...(peak.band ? { peak: peak.band } : {}),
        ...(offPeak.band ? { offPeak: offPeak.band } : {}),
      };
    }
  }

  const docs = fields.docsUrl.trim();
  const notes = fields.pricingNotes.trim();
  let sourceUrl: string | undefined;
  if (docs) {
    try {
      sourceUrl = new URL(docs).toString();
    } catch {
      return {
        ok: false,
        error: "Pricing docs URL is invalid.",
      };
    }
  } else if (fields.pricingExtra?.sourceUrl) {
    sourceUrl = fields.pricingExtra.sourceUrl;
  }
  const pricing: ProviderPricing = {
    ...(flat.band ?? {}),
    ...(schedule ? { schedule } : {}),
    ...(fields.pricingExtra?.byModel
      ? { byModel: fields.pricingExtra.byModel }
      : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(notes
      ? { notes }
      : fields.pricingExtra?.notes
        ? { notes: fields.pricingExtra.notes }
        : {}),
    ...(fields.pricingExtra?.fetchedAt
      ? { fetchedAt: fields.pricingExtra.fetchedAt }
      : {}),
  };

  if (!Object.keys(pricing).length) return { ok: true };
  return { ok: true, pricing };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    Boolean(el.isContentEditable)
  );
}

/** e.code "Digit1"…"Digit9" → 1…9 (shift/alt-safe, unlike e.key). */
function digitFromCode(code: string): number | null {
  const m = /^Digit([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
/** Sentinel: use the in-form draft credentials for pricing lookup. */
const LOOKUP_THIS = "__this__";

export function OnboardingWizard(props: {
  open: boolean;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [view, setView] = useState<View>("list");
  const [providers, setProviders] = useState<ListedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  /** Context windows discovered via provider GET /v1/models (id → tokens). */
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({});
  const [contextWindowSource, setContextWindowSource] = useState<
    "manual" | "provider" | null
  >(null);
  const [paid, setPaid] = useState(false);
  const [pricingFields, setPricingFields] = useState<PricingFormFields>(
    emptyPricingFields,
  );
  const [lookupProviderId, setLookupProviderId] = useState<string>(LOOKUP_THIS);
  const [fetchingPricing, setFetchingPricing] = useState(false);
  const [pricingLogs, setPricingLogs] = useState<string[]>([]);
  const pricingLogRef = useRef<HTMLPreElement | null>(null);
  const [pendingPricing, setPendingPricing] = useState<ProviderPricing | null>(
    null,
  );
  /** Context window suggested by Fetch pricing online (applied with rates). */
  const [pendingContextWindow, setPendingContextWindow] = useState<
    number | null
  >(null);
  const [thinking, setThinking] = useState(false);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  /** Empty string = unset; otherwise digit string for context window tokens. */
  const [contextWindow, setContextWindow] = useState("");
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { open, onCancel, onComplete } = props;
  const stateRef = useRef({
    view,
    busy,
    listing,
    fetchingPricing,
    pendingPricing,
    pendingContextWindow,
    model,
    baseUrl,
    apiKey,
    name,
    paid,
    pricingFields,
    lookupProviderId,
    thinking,
    editingId,
    providers,
    onCancel,
    onComplete,
  });
  stateRef.current = {
    view,
    busy,
    listing,
    fetchingPricing,
    pendingPricing,
    pendingContextWindow,
    model,
    baseUrl,
    apiKey,
    name,
    paid,
    pricingFields,
    lookupProviderId,
    thinking,
    editingId,
    providers,
    onCancel,
    onComplete,
  };

  function patchPricing(patch: Partial<PricingFormFields>) {
    setPricingFields((prev) => ({ ...prev, ...patch }));
  }

  async function refreshList() {
    const list = await getBridge()?.provider.list();
    setProviders(list?.providers ?? []);
    setActiveId(list?.activeId ?? null);
  }

  useEffect(() => {
    if (!open) return;
    const unsub = getBridge()?.provider.onFetchPricingProgress?.((ev) => {
      setPricingLogs((prev) => {
        const next = [...prev, ev.message];
        return next.length > 200 ? next.slice(-200) : next;
      });
    });
    return () => {
      unsub?.();
    };
  }, [open]);

  useEffect(() => {
    const el = pricingLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [pricingLogs]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setView("list");
    setBusy(false);
    setListing(false);
    setFetchingPricing(false);
    setPendingPricing(null);
    setHydrated(false);
    setEditingId(null);
    setError(null);
    void (async () => {
      try {
        await refreshList();
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function startNew() {
    setEditingId(null);
    setName("");
    setBaseUrl(DEFAULT_BASE_URL);
    setApiKey("");
    setModel("");
    setModels([]);
    setModelWindows({});
    setContextWindowSource(null);
    setPaid(false);
    setPricingFields(emptyPricingFields());
    setLookupProviderId(LOOKUP_THIS);
    setPendingPricing(null);
    setThinking(false);
    setReasoningEffort("high");
    setContextWindow("");
    setError(null);
    setView("form");
  }

  async function startEdit(id: string) {
    setBusy(true);
    setError(null);
    try {
      await getBridge()?.provider.setActive(id);
      const cfg = await getBridge()?.provider.getConfig();
      setEditingId(cfg?.id ?? id);
      setName(cfg?.name ?? "");
      setBaseUrl(cfg?.baseUrl ?? DEFAULT_BASE_URL);
      setApiKey(cfg?.apiKey ?? "");
      setModel(cfg?.defaultModel ?? "");
      setModels([]);
      setModelWindows({});
      setContextWindowSource(
        typeof cfg?.contextWindowTokens === "number" ? "manual" : null,
      );
      setPaid(Boolean(cfg?.paid));
      const fields = pricingToFields(cfg?.pricing ?? null);
      if (!fields.docsUrl && cfg?.baseUrl) {
        fields.docsUrl = guessPricingDocsUrl(cfg.baseUrl) ?? "";
      }
      setPricingFields(fields);
      setLookupProviderId(cfg?.id ?? LOOKUP_THIS);
      setPendingPricing(null);
      setThinking(Boolean(cfg?.thinking));
      setReasoningEffort(cfg?.reasoningEffort ?? "high");
      setContextWindow(
        typeof cfg?.contextWindowTokens === "number" &&
          cfg.contextWindowTokens > 0
          ? String(cfg.contextWindowTokens)
          : "",
      );
      setView("form");
      await refreshList();
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    setBusy(true);
    try {
      await getBridge()?.provider.setActive(id);
      await refreshList();
      onComplete();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await getBridge()?.provider.delete(id);
      await refreshList();
    } finally {
      setBusy(false);
    }
  }

  function applyContextWindowFromProvider(
    modelId: string,
    windows: Record<string, number>,
  ) {
    const n = windows[modelId];
    if (typeof n === "number" && n >= 4_000) {
      setContextWindow(String(n));
      setContextWindowSource("provider");
      return true;
    }
    return false;
  }

  async function listModels() {
    const bridge = getBridge();
    if (!bridge || stateRef.current.listing) return;
    setListing(true);
    setError(null);
    try {
      const { baseUrl: url, apiKey: key, model: currentModel } =
        stateRef.current;
      const payload: { baseUrl: string; apiKey: string; model?: string } = {
        baseUrl: url,
        apiKey: key,
      };
      if (currentModel) payload.model = currentModel;
      const result = await bridge.provider.verify(payload);
      if (!result?.ok) {
        setError(
          result?.error?.userMessage ??
            result?.error?.technicalDetail ??
            "Could not list models from this provider.",
        );
        return;
      }
      const listed = (result.models ?? []).filter(
        (m): m is string => typeof m === "string" && m.trim().length > 0,
      );
      if (listed.length === 0) {
        setModels([]);
        setModelWindows({});
        setError(
          "Provider returned no models. Check the base URL / API key, or type a model id manually.",
        );
        return;
      }
      const windows: Record<string, number> = {};
      for (const detail of result.modelDetails ?? []) {
        if (
          detail?.id &&
          typeof detail.contextWindowTokens === "number" &&
          detail.contextWindowTokens >= 4_000
        ) {
          windows[detail.id] = detail.contextWindowTokens;
        }
      }
      setModels(listed);
      setModelWindows(windows);
      const nextModel =
        currentModel && listed.includes(currentModel)
          ? currentModel
          : listed[0]!;
      setModel(nextModel);
      applyContextWindowFromProvider(nextModel, windows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setListing(false);
    }
  }

  async function cancelPricingFetch() {
    const bridge = getBridge();
    if (!bridge?.provider.cancelFetchPricing) return;
    try {
      await bridge.provider.cancelFetchPricing();
    } catch {
      /* ignore */
    }
    setPricingLogs((prev) => [...prev, "Cancel requested…"]);
  }

  async function fetchPricingOnline() {
    const bridge = getBridge();
    const s = stateRef.current;
    if (!bridge || s.fetchingPricing || s.busy) return;
    if (!s.baseUrl.trim()) {
      setError("Set a base URL before fetching pricing.");
      return;
    }
    setFetchingPricing(true);
    setError(null);
    setPendingPricing(null);
    setPendingContextWindow(null);
    setPricingLogs(["Starting fetch…"]);
    try {
      const docs =
        s.pricingFields.docsUrl.trim() ||
        guessPricingDocsUrl(s.baseUrl) ||
        undefined;
      const lookupId = s.lookupProviderId;
      const result = await bridge.provider.fetchPricing({
        ...(lookupId === LOOKUP_THIS || !lookupId
          ? {
              lookupDraft: {
                baseUrl: s.baseUrl,
                apiKey: s.apiKey,
                model: s.model.trim() || "default",
              },
            }
          : { lookupProviderId: lookupId }),
        target: {
          ...(s.name.trim() ? { name: s.name.trim() } : {}),
          baseUrl: s.baseUrl,
          ...(s.model.trim() ? { defaultModel: s.model.trim() } : {}),
        },
        ...(docs ? { docsUrl: docs } : {}),
      });
      if (result?.cancelled) {
        setPricingLogs((prev) => [...prev, "Cancelled."]);
        setError(null);
        return;
      }
      if (!result?.ok || !result.pricing) {
        setError(
          result?.error?.userMessage ??
            result?.error?.technicalDetail ??
            "Could not fetch pricing online.",
        );
        setPricingLogs((prev) => [
          ...prev,
          result?.error?.userMessage ?? "Fetch failed.",
        ]);
        return;
      }
      setPendingPricing(result.pricing);
      setPendingContextWindow(
        typeof result.contextWindowTokens === "number" &&
          result.contextWindowTokens >= 4_000
          ? result.contextWindowTokens
          : null,
      );
      if (result.docsUrl) {
        patchPricing({ docsUrl: result.docsUrl });
      }
      setPaid(true);
      setError(null);
      setPricingLogs((prev) => [...prev, "Done — review and apply."]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPricingLogs((prev) => [
        ...prev,
        err instanceof Error ? err.message : String(err),
      ]);
    } finally {
      setFetchingPricing(false);
    }
  }

  function applyPendingPricing() {
    const pending = stateRef.current.pendingPricing;
    if (!pending) return;
    const fields = pricingToFields(pending);
    if (!fields.docsUrl && pending.sourceUrl) {
      fields.docsUrl = pending.sourceUrl;
    }
    setPricingFields(fields);
    setPaid(true);
    const ctx = stateRef.current.pendingContextWindow;
    if (typeof ctx === "number" && ctx >= 4_000) {
      setContextWindow(String(ctx));
      setContextWindowSource("provider");
    }
    setPendingPricing(null);
    setPendingContextWindow(null);
    setError(null);
  }

  function discardPendingPricing() {
    setPendingPricing(null);
    setPendingContextWindow(null);
  }

  async function save() {
    const bridge = getBridge();
    const s = stateRef.current;
    if (!bridge || s.busy || !s.model.trim()) return;
    if (s.pendingPricing) {
      setError("Confirm or discard the fetched pricing before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const built = buildPricingFromFields(s.pricingFields);
      if (!built.ok) {
        setError(built.error);
        setBusy(false);
        return;
      }
      const windowRaw = contextWindow.trim().replace(/[_\s,]/g, "");
      let contextWindowTokens: number | null | undefined;
      if (windowRaw) {
        const n = Number(windowRaw);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 4_000) {
          setError(
            "Context window must be an integer ≥ 4000 tokens (or leave blank).",
          );
          setBusy(false);
          return;
        }
        contextWindowTokens = n;
      } else if (s.editingId) {
        // Explicitly clear a previously saved window.
        contextWindowTokens = null;
      }
      await bridge.provider.saveConfig({
        ...(s.editingId ? { id: s.editingId } : {}),
        name: name.trim() || (paid ? "Cloud provider" : "Local provider"),
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        defaultModel: s.model.trim(),
        paid,
        ...(built.pricing ? { pricing: built.pricing } : {}),
        thinking,
        reasoningEffort,
        ...(contextWindowTokens !== undefined
          ? { contextWindowTokens }
          : {}),
        makeActive: true,
      });
      await refreshList();
      stateRef.current.onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function saveRef() {
    void save();
  }
  const saveRefStable = useRef(saveRef);
  saveRefStable.current = saveRef;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const s = stateRef.current;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (s.fetchingPricing) {
          void cancelPricingFetch();
          return;
        }
        if (s.pendingPricing) {
          discardPendingPricing();
          return;
        }
        if (s.view === "form") {
          setError(null);
          setView("list");
        } else {
          s.onCancel();
        }
        return;
      }

      if (s.view === "list") {
        const digit = digitFromCode(e.code);
        if (!isTypingTarget(e.target)) {
          if (e.key.toLowerCase() === "a" && !e.metaKey && !e.altKey) {
            e.preventDefault();
            startNew();
            return;
          }
          if (digit && s.providers[digit - 1]) {
            const provider = s.providers[digit - 1]!;
            e.preventDefault();
            if (e.metaKey) void startEdit(provider.id);
            else if (e.altKey) void remove(provider.id);
            else void activate(provider.id);
            return;
          }
        }
        return;
      }

      // Form view — pending pricing confirmation takes Enter.
      if (s.pendingPricing) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          applyPendingPricing();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void listModels();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (s.fetchingPricing) void cancelPricingFetch();
        else void fetchPricingOnline();
        return;
      }
      if (!isTypingTarget(e.target)) {
        if (e.key.toLowerCase() === "t" && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setThinking((v) => !v);
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          setError(null);
          setView("list");
          return;
        }
        if (s.thinking) {
          const opt = EFFORT_OPTIONS.find((o) => o.shortcut === e.key);
          if (opt) {
            e.preventDefault();
            setReasoningEffort(opt.value);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveRefStable.current();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const listView = (
    <>
      <p className="provider-dialog-lead">
        Saved providers. Activate one or add a new OpenAI-compatible endpoint.
      </p>
      <ul className="provider-list">
        {providers.map((p, index) => (
          <li
            key={p.id}
            className={
              p.id === activeId
                ? "provider-list-item provider-list-item-active"
                : "provider-list-item"
            }
          >
            <button
              type="button"
              className="provider-list-main"
              disabled={busy}
              onClick={() => void activate(p.id)}
            >
              <span className="provider-list-name">
                {p.paid ? <span className="provider-paid-sign">$</span> : null}
                {p.name}
              </span>
              <span className="provider-list-meta">
                {p.defaultModel} · {p.baseUrl}
              </span>
              <span className="provider-list-sc">
                {index < 9 ? `· ${index + 1}` : ""}
              </span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void startEdit(p.id)}
            >
              Edit{index < 9 ? ` · ⌘${index + 1}` : ""}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void remove(p.id)}
            >
              Delete{index < 9 ? ` · ⌥${index + 1}` : ""}
            </button>
          </li>
        ))}
        {providers.length === 0 ? (
          <li className="muted">No providers yet.</li>
        ) : null}
      </ul>
      <div className="onboarding-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={startNew}
        >
          Add provider · A
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Close · Esc
        </button>
      </div>
    </>
  );

  const pf = pricingFields;

  const formView = (
    <form
      className="onboarding-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (pendingPricing) applyPendingPricing();
        else void save();
      }}
    >
      <label>
        Display name
        <input
          className="input"
          value={name}
          placeholder="e.g. DeepSeek"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Base URL
        <input
          className="input"
          value={baseUrl}
          onChange={(e) => {
            const next = e.target.value;
            setBaseUrl(next);
            if (!pricingFields.docsUrl.trim()) {
              const guess = guessPricingDocsUrl(next);
              if (guess) patchPricing({ docsUrl: guess });
            }
          }}
          placeholder="https://api.deepseek.com"
        />
      </label>
      <label>
        API key
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Optional for local"
        />
      </label>
      <div className="provider-model-field">
        <label htmlFor="model">Default model</label>
        <div className="provider-model-row">
          {models.length > 0 ? (
            <select
              id="model"
              className="input"
              value={model}
              onChange={(e) => {
                const next = e.target.value;
                setModel(next);
                applyContextWindowFromProvider(next, modelWindows);
              }}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {modelWindows[m] ? ` · ${modelWindows[m]!.toLocaleString()} ctx` : ""}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="model"
              className="input"
              value={model}
              placeholder="e.g. gpt-4o-mini"
              onChange={(e) => setModel(e.target.value)}
            />
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={listing}
            onClick={() => void listModels()}
          >
            {listing ? "Listing…" : "List models · ⌘L"}
          </button>
        </div>
        <span className="start-build-hint">
          {models.length > 0
            ? `${models.length} model${models.length === 1 ? "" : "s"} from provider`
            : "List models from the endpoint, or type a model id manually"}
        </span>
      </div>

      <label>
        Context window (tokens)
        <input
          className="input"
          inputMode="numeric"
          value={contextWindow}
          placeholder="e.g. 128000 (leave blank for IDE default)"
          onChange={(e) => {
            setContextWindow(e.target.value);
            setContextWindowSource("manual");
          }}
        />
        <span className="start-build-hint">
          {contextWindowSource === "provider"
            ? "Filled from Fetch pricing & context / provider docs. Compaction uses ~75% of this."
            : models.length > 0 && Object.keys(modelWindows).length === 0
              ? "Use Fetch pricing & context · ⌘G (or List models) to try auto-fill. Otherwise enter manually (32k / 64k / 128k / 200k)."
              : "Fetch pricing & context · ⌘G extracts context window from docs when available. Compaction triggers around 75% of this value."}
        </span>
      </label>

      <label className="start-build-check">
        <input
          type="checkbox"
          checked={paid}
          onChange={(e) => setPaid(e.target.checked)}
        />
        <span>
          Paid provider <span className="provider-paid-sign">$</span> — show
          cost estimates in the top bar
        </span>
      </label>

      {paid ? (
        <div className="provider-pricing-block">
          <div className="provider-pricing-fetch-row">
            <label className="provider-pricing-lookup">
              Lookup via
              <select
                className="input"
                value={lookupProviderId}
                onChange={(e) => setLookupProviderId(e.target.value)}
              >
                <option value={LOOKUP_THIS}>This form (draft) · self</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.defaultModel}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !baseUrl.trim()}
              onClick={() =>
                fetchingPricing
                  ? void cancelPricingFetch()
                  : void fetchPricingOnline()
              }
            >
              {fetchingPricing
                ? "Cancel fetch · Esc"
                : "Fetch pricing & context · ⌘G"}
            </button>
          </div>
          {(fetchingPricing || pricingLogs.length > 0) && (
            <pre
              ref={pricingLogRef}
              className="provider-pricing-log"
              aria-live="polite"
            >
              {pricingLogs.join("\n")}
            </pre>
          )}
          <label>
            Pricing docs URL
            <input
              className="input"
              value={pf.docsUrl}
              placeholder="https://api-docs.deepseek.com/quick_start/pricing/"
              onChange={(e) => patchPricing({ docsUrl: e.target.value })}
            />
          </label>

          {pendingPricing ? (
            <div className="provider-pricing-confirm" role="status">
              <p className="provider-pricing-confirm-lead">
                Fetched rates ready — review and apply to the form (does not
                save yet).
                {pendingContextWindow
                  ? ` Also found context window: ${pendingContextWindow.toLocaleString()} tokens.`
                  : ""}
              </p>
              {pendingPricing.notes ? (
                <p className="start-build-hint">{pendingPricing.notes}</p>
              ) : null}
              <pre className="provider-pricing-confirm-json">
                {JSON.stringify(
                  {
                    ...pendingPricing,
                    ...(pendingContextWindow
                      ? { contextWindowTokens: pendingContextWindow }
                      : {}),
                  },
                  null,
                  2,
                )}
              </pre>
              <div className="provider-pricing-confirm-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={discardPendingPricing}
                >
                  Discard · Esc
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={applyPendingPricing}
                >
                  Apply to form · Enter
                </button>
              </div>
            </div>
          ) : null}

          <div className="provider-pricing-grid">
            <label>
              Input $/1M
              <input
                className="input"
                inputMode="decimal"
                placeholder="e.g. 0.44"
                value={pf.inputPer1M}
                onChange={(e) => patchPricing({ inputPer1M: e.target.value })}
              />
            </label>
            <label>
              Output $/1M
              <input
                className="input"
                inputMode="decimal"
                placeholder="e.g. 1.32"
                value={pf.outputPer1M}
                onChange={(e) => patchPricing({ outputPer1M: e.target.value })}
              />
            </label>
            <label>
              Cache hit $/1M
              <input
                className="input"
                inputMode="decimal"
                placeholder="e.g. 0.014"
                value={pf.inputCacheHitPer1M}
                onChange={(e) =>
                  patchPricing({ inputCacheHitPer1M: e.target.value })
                }
              />
            </label>
            <label>
              Cache miss $/1M
              <input
                className="input"
                inputMode="decimal"
                placeholder="e.g. 0.44"
                value={pf.inputCacheMissPer1M}
                onChange={(e) =>
                  patchPricing({ inputCacheMissPer1M: e.target.value })
                }
              />
            </label>
          </div>

          <label className="start-build-check">
            <input
              type="checkbox"
              checked={pf.useSchedule}
              onChange={(e) => patchPricing({ useSchedule: e.target.checked })}
            />
            <span>Time-based peak / off-peak rates (UTC)</span>
          </label>

          {pf.useSchedule ? (
            <>
              <label>
                Peak windows UTC
                <input
                  className="input"
                  value={pf.peakWindows}
                  placeholder="01:00-04:00, 06:00-10:00"
                  onChange={(e) =>
                    patchPricing({ peakWindows: e.target.value })
                  }
                />
              </label>
              <p className="start-build-hint">Peak rates</p>
              <div className="provider-pricing-grid">
                <label>
                  Peak input $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.peakInput}
                    onChange={(e) =>
                      patchPricing({ peakInput: e.target.value })
                    }
                  />
                </label>
                <label>
                  Peak output $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.peakOutput}
                    onChange={(e) =>
                      patchPricing({ peakOutput: e.target.value })
                    }
                  />
                </label>
                <label>
                  Peak cache hit $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.peakCacheHit}
                    onChange={(e) =>
                      patchPricing({ peakCacheHit: e.target.value })
                    }
                  />
                </label>
                <label>
                  Peak cache miss $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.peakCacheMiss}
                    onChange={(e) =>
                      patchPricing({ peakCacheMiss: e.target.value })
                    }
                  />
                </label>
              </div>
              <p className="start-build-hint">Off-peak rates</p>
              <div className="provider-pricing-grid">
                <label>
                  Off-peak input $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.offPeakInput}
                    onChange={(e) =>
                      patchPricing({ offPeakInput: e.target.value })
                    }
                  />
                </label>
                <label>
                  Off-peak output $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.offPeakOutput}
                    onChange={(e) =>
                      patchPricing({ offPeakOutput: e.target.value })
                    }
                  />
                </label>
                <label>
                  Off-peak cache hit $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.offPeakCacheHit}
                    onChange={(e) =>
                      patchPricing({ offPeakCacheHit: e.target.value })
                    }
                  />
                </label>
                <label>
                  Off-peak cache miss $/1M
                  <input
                    className="input"
                    inputMode="decimal"
                    value={pf.offPeakCacheMiss}
                    onChange={(e) =>
                      patchPricing({ offPeakCacheMiss: e.target.value })
                    }
                  />
                </label>
              </div>
            </>
          ) : null}

          {pf.pricingExtra?.byModel &&
          Object.keys(pf.pricingExtra.byModel).length > 0 ? (
            <p className="start-build-hint">
              Per-model rates stored for{" "}
              {Object.keys(pf.pricingExtra.byModel).join(", ")} (from fetch).
            </p>
          ) : null}

          <label>
            Notes
            <input
              className="input"
              value={pf.pricingNotes}
              placeholder="Optional caveats"
              onChange={(e) => patchPricing({ pricingNotes: e.target.value })}
            />
          </label>
        </div>
      ) : null}

      <label className="start-build-check">
        <input
          type="checkbox"
          checked={thinking}
          onChange={(e) => setThinking(e.target.checked)}
        />
        <span>
          Thinking mode · T — DeepSeek-style chain-of-thought (
          <code>thinking</code> + <code>reasoning_effort</code>)
        </span>
      </label>

      {thinking ? (
        <div
          className="provider-effort-row"
          role="group"
          aria-label="Reasoning effort"
        >
          {EFFORT_OPTIONS.map(({ value, shortcut, label }) => (
            <button
              key={value}
              type="button"
              className={
                reasoningEffort === value
                  ? "btn btn-sm"
                  : "btn btn-secondary btn-sm"
              }
              onClick={() => setReasoningEffort(value)}
            >
              {label} · {shortcut}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="start-build-error">{error}</p> : null}

      <div className="onboarding-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => {
            if (pendingPricing) {
              discardPendingPricing();
              return;
            }
            setError(null);
            setView("list");
          }}
        >
          {pendingPricing ? "Discard · Esc" : "Back · Esc"}
        </button>
        <button
          type="submit"
          className="btn"
          disabled={
            busy ||
            listing ||
            fetchingPricing ||
            (!pendingPricing && !model.trim())
          }
        >
          {busy
            ? "Saving…"
            : pendingPricing
              ? "Apply to form · Enter"
              : "Save · Enter"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-dialog-title"
      >
        <div className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Providers</div>
            <h2 className="provider-dialog-title" id="provider-dialog-title">
              {view === "list"
                ? "Model providers"
                : editingId
                  ? "Edit provider"
                  : "New provider"}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              if (pendingPricing) {
                discardPendingPricing();
                return;
              }
              if (view === "form") {
                setError(null);
                setView("list");
              } else {
                onCancel();
              }
            }}
          >
            {pendingPricing
              ? "Discard · Esc"
              : view === "form"
                ? "Back · Esc"
                : "Close · Esc"}
          </button>
        </div>
        <div className="provider-dialog-body">
          {!hydrated ? (
            <p className="provider-dialog-lead">Loading…</p>
          ) : view === "list" ? (
            listView
          ) : (
            formView
          )}
        </div>
      </div>
    </div>
  );
}
