import { useEffect, useRef, useState } from "react";
import {
  formatPeakWindowsUtc,
  formatRateBand,
  catalogNeedsHuman,
  fillCatalogGaps,
  modelCapabilityGaps,
  guessPricingDocsUrl,
  resolvePricingBand,
  inferProviderKind,
  mergeProviderModels,
  parsePeakWindowsUtc,
  parseUsdRate,
  PROVIDER_KINDS,
  providerKindLabel,
  REASONING_EFFORT_VALUES,
  type PricingRateBand,
  type ProviderKind,
  type ProviderModelPricing,
  type ProviderModelCatalogEntry,
  type ProviderPricing,
  type ReasoningEffort,
} from "@ai-ide/shared";
import { getBridge } from "../bridge";
import {
  cycleModelFlag,
  ProviderModelCatalog,
} from "./ProviderModelCatalog";

/** Protocol options, in the order the P shortcut cycles through them. */
const KIND_OPTIONS = PROVIDER_KINDS.map((value) => ({
  value,
  label: providerKindLabel(value),
}));

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
type FormTab = "connection" | "models" | "pricing";

function modHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘${key}` : `Ctrl+${key}`;
}

type ListedProvider = {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  paid: boolean;
  contextWindowTokens?: number | undefined;
  models?: ProviderModelCatalogEntry[] | undefined;
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

function hasFlatRates(pricing: ProviderPricing): boolean {
  return (
    pricing.inputPer1M != null ||
    pricing.outputPer1M != null ||
    pricing.inputCacheHitPer1M != null ||
    pricing.inputCacheMissPer1M != null ||
    Boolean(pricing.schedule)
  );
}

function modelPricingFromFlat(pricing: ProviderPricing): ProviderModelPricing {
  return {
    ...(pricing.inputPer1M != null ? { inputPer1M: pricing.inputPer1M } : {}),
    ...(pricing.outputPer1M != null ? { outputPer1M: pricing.outputPer1M } : {}),
    ...(pricing.inputCacheHitPer1M != null
      ? { inputCacheHitPer1M: pricing.inputCacheHitPer1M }
      : {}),
    ...(pricing.inputCacheMissPer1M != null
      ? { inputCacheMissPer1M: pricing.inputCacheMissPer1M }
      : {}),
    ...(pricing.schedule ? { schedule: pricing.schedule } : {}),
  };
}

function rateFieldsFromModel(
  rates: ProviderModelPricing | undefined,
): Pick<
  PricingFormFields,
  | "inputPer1M"
  | "outputPer1M"
  | "inputCacheHitPer1M"
  | "inputCacheMissPer1M"
  | "useSchedule"
  | "peakWindows"
  | "peakInput"
  | "peakOutput"
  | "peakCacheHit"
  | "peakCacheMiss"
  | "offPeakInput"
  | "offPeakOutput"
  | "offPeakCacheHit"
  | "offPeakCacheMiss"
> {
  const schedule = rates?.schedule;
  const useSchedule = Boolean(
    schedule?.peakWindowsUtc?.length || schedule?.peak || schedule?.offPeak,
  );
  return {
    inputPer1M: rateStr(rates?.inputPer1M),
    outputPer1M: rateStr(rates?.outputPer1M),
    inputCacheHitPer1M: rateStr(rates?.inputCacheHitPer1M),
    inputCacheMissPer1M: rateStr(rates?.inputCacheMissPer1M),
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
  };
}

function modelRatesFromFields(fields: PricingFormFields):
  | { ok: true; rates?: ProviderModelPricing }
  | { ok: false; error: string } {
  const flat = buildBand({
    input: fields.inputPer1M,
    output: fields.outputPer1M,
    hit: fields.inputCacheHitPer1M,
    miss: fields.inputCacheMissPer1M,
  });
  if (!flat.ok) return flat;

  let schedule: ProviderModelPricing["schedule"] | undefined;
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

  const rates: ProviderModelPricing = {
    ...(flat.band ?? {}),
    ...(schedule ? { schedule } : {}),
  };
  if (!Object.keys(rates).length) return { ok: true };
  return { ok: true, rates };
}

/**
 * Load provider docs/notes plus the selected model's rates.
 * Legacy provider-wide rates migrate onto that model when byModel is empty.
 */
function pricingToFields(
  pricing: ProviderPricing | null | undefined,
  modelId?: string | null,
): PricingFormFields {
  if (!pricing) return emptyPricingFields();
  const byModel = { ...(pricing.byModel ?? {}) };
  const selected = modelId?.trim() ?? "";
  if (selected && !byModel[selected] && hasFlatRates(pricing)) {
    byModel[selected] = modelPricingFromFlat(pricing);
  }
  return {
    ...rateFieldsFromModel(selected ? byModel[selected] : undefined),
    docsUrl: pricing.sourceUrl ?? "",
    pricingNotes: pricing.notes ?? "",
    pricingExtra: {
      ...(Object.keys(byModel).length ? { byModel } : {}),
      ...(pricing.sourceUrl ? { sourceUrl: pricing.sourceUrl } : {}),
      ...(pricing.notes ? { notes: pricing.notes } : {}),
      ...(pricing.fetchedAt ? { fetchedAt: pricing.fetchedAt } : {}),
    },
  };
}

function mergeIncomingPricing(
  fields: PricingFormFields,
  incoming: ProviderPricing,
  selectedModel: string,
): PricingFormFields {
  const flushed = flushSelectedModelRates(fields, selectedModel);
  const byModel = {
    ...(flushed.pricingExtra?.byModel ?? {}),
    ...(incoming.byModel ?? {}),
  };
  const selected = selectedModel.trim();
  const selectedRates = selected ? byModel[selected] : undefined;
  return {
    ...flushed,
    ...(selectedRates ? rateFieldsFromModel(selectedRates) : {}),
    docsUrl:
      incoming.sourceUrl &&
      /pricing/i.test(incoming.sourceUrl) &&
      !/\/models\//i.test(incoming.sourceUrl)
        ? incoming.sourceUrl
        : flushed.docsUrl,
    pricingNotes: incoming.notes || flushed.pricingNotes,
    pricingExtra: {
      ...(flushed.pricingExtra ?? {}),
      ...(Object.keys(byModel).length ? { byModel } : {}),
      ...(incoming.sourceUrl ? { sourceUrl: incoming.sourceUrl } : {}),
      ...(incoming.notes ? { notes: incoming.notes } : {}),
      ...(incoming.fetchedAt ? { fetchedAt: incoming.fetchedAt } : {}),
    },
  };
}

function flushSelectedModelRates(
  fields: PricingFormFields,
  modelId: string,
): PricingFormFields {
  const id = modelId.trim();
  if (!id) return fields;
  const built = modelRatesFromFields(fields);
  if (!built.ok) return fields;
  const byModel = { ...(fields.pricingExtra?.byModel ?? {}) };
  if (built.rates) byModel[id] = built.rates;
  else delete byModel[id];
  return {
    ...fields,
    pricingExtra: {
      ...(fields.pricingExtra ?? {}),
      ...(Object.keys(byModel).length ? { byModel } : { byModel: undefined }),
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
  | { ok: true; band?: PricingRateBand }
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
  modelId?: string | null,
): { ok: true; pricing?: ProviderPricing } | { ok: false; error: string } {
  const flushed = flushSelectedModelRates(fields, modelId ?? "");
  const rates = modelRatesFromFields(flushed);
  if (!rates.ok) return rates;

  const docs = flushed.docsUrl.trim();
  const notes = flushed.pricingNotes.trim();
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
  } else if (flushed.pricingExtra?.sourceUrl) {
    sourceUrl = flushed.pricingExtra.sourceUrl;
  }
  const byModel = flushed.pricingExtra?.byModel;
  const pricing: ProviderPricing = {
    ...(byModel && Object.keys(byModel).length ? { byModel } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(notes
      ? { notes }
      : flushed.pricingExtra?.notes
        ? { notes: flushed.pricingExtra.notes }
        : {}),
    ...(flushed.pricingExtra?.fetchedAt
      ? { fetchedAt: flushed.pricingExtra.fetchedAt }
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

function uniqueModelIds(ids: Array<string | undefined>): string[] {
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

/** Models the lookup LLM may run as, for the chosen lookup provider. */
function lookupModelChoices(args: {
  lookupProviderId: string;
  providers: ListedProvider[];
  catalog: ProviderModelCatalogEntry[];
  formModel: string;
  lookupModel: string;
}): string[] {
  if (args.lookupProviderId === LOOKUP_THIS || !args.lookupProviderId) {
    return uniqueModelIds([
      ...args.catalog.map((entry) => entry.id),
      args.formModel,
      args.lookupModel,
    ]);
  }
  const provider = args.providers.find((p) => p.id === args.lookupProviderId);
  return uniqueModelIds([
    ...(provider?.models ?? []).map((entry) => entry.id),
    provider?.defaultModel,
    args.lookupModel,
  ]);
}

export function OnboardingWizard(props: {
  open: boolean;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [view, setView] = useState<View>("list");
  const [formTab, setFormTab] = useState<FormTab>("connection");
  const [providers, setProviders] = useState<ListedProvider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [kind, setKind] = useState<ProviderKind>("openai-compatible");
  /**
   * Until the user touches the protocol, typing a base URL keeps re-proposing
   * one. After an explicit pick the choice sticks, so a gateway that proxies
   * Anthropic on a neutral host survives further edits to the URL.
   */
  const [kindPinned, setKindPinned] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  /** Context windows discovered via provider GET /v1/models (id → tokens). */
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({});
  const [catalog, setCatalog] = useState<ProviderModelCatalogEntry[]>([]);
  const [pendingModels, setPendingModels] = useState<
    ProviderModelCatalogEntry[] | null
  >(null);
  const [contextWindowSource, setContextWindowSource] = useState<
    "manual" | "provider" | null
  >(null);
  const [paid, setPaid] = useState(false);
  const [pricingFields, setPricingFields] = useState<PricingFormFields>(
    emptyPricingFields,
  );
  const [lookupProviderId, setLookupProviderId] = useState<string>(LOOKUP_THIS);
  const [lookupModel, setLookupModel] = useState("");
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
    formTab,
    busy,
    listing,
    fetchingPricing,
    pendingPricing,
    pendingContextWindow,
    pendingModels,
    model,
    catalog,
    baseUrl,
    kind,
    apiKey,
    name,
    paid,
    pricingFields,
    lookupProviderId,
    lookupModel,
    thinking,
    editingId,
    providers,
    onCancel,
    onComplete,
  });
  stateRef.current = {
    view,
    formTab,
    busy,
    listing,
    fetchingPricing,
    pendingPricing,
    pendingContextWindow,
    pendingModels,
    model,
    catalog,
    baseUrl,
    kind,
    apiKey,
    name,
    paid,
    pricingFields,
    lookupProviderId,
    lookupModel,
    thinking,
    editingId,
    providers,
    onCancel,
    onComplete,
  };

  function patchPricing(patch: Partial<PricingFormFields>) {
    setPricingFields((prev) => ({ ...prev, ...patch }));
  }

  function patchModelRates(patch: Partial<PricingFormFields>) {
    setPricingFields((prev) =>
      flushSelectedModelRates({ ...prev, ...patch }, stateRef.current.model),
    );
  }

  function pickKind(next: ProviderKind) {
    setKind(next);
    setKindPinned(true);
  }

  function cycleKind() {
    setKindPinned(true);
    setKind((prev) => {
      const i = PROVIDER_KINDS.indexOf(prev);
      return PROVIDER_KINDS[(i + 1) % PROVIDER_KINDS.length]!;
    });
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
      if (ev.models?.length) {
        setCatalog((prev) =>
          fillCatalogGaps(mergeProviderModels(prev, ev.models ?? [])),
        );
      }
      if (ev.pricing) {
        const incoming = ev.pricing;
        setPricingFields((prev) =>
          mergeIncomingPricing(prev, incoming, stateRef.current.model),
        );
        if (
          incoming.inputPer1M != null ||
          incoming.outputPer1M != null ||
          incoming.byModel
        ) {
          setPaid(true);
        }
        if (incoming.sourceUrl) {
          setPricingFields((prev) => ({
            ...prev,
            docsUrl: incoming.sourceUrl ?? prev.docsUrl,
          }));
        }
      }
      if (
        typeof ev.contextWindowTokens === "number" &&
        ev.contextWindowTokens >= 4_000
      ) {
        setContextWindow(String(ev.contextWindowTokens));
        setContextWindowSource("provider");
      }
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
    setKind(inferProviderKind(DEFAULT_BASE_URL));
    setKindPinned(false);
    setApiKey("");
    setModel("");
    setModels([]);
    setModelWindows({});
    setCatalog([]);
    setPendingModels(null);
    setContextWindowSource(null);
    setPaid(false);
    setPricingFields(emptyPricingFields());
    setLookupProviderId(LOOKUP_THIS);
    setLookupModel("");
    setPendingPricing(null);
    setThinking(false);
    setReasoningEffort("high");
    setContextWindow("");
    setError(null);
    setFormTab("connection");
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
      setKind(cfg?.kind ?? inferProviderKind(cfg?.baseUrl ?? DEFAULT_BASE_URL));
      setKindPinned(true);
      setApiKey(cfg?.apiKey ?? "");
      setModel(cfg?.defaultModel ?? "");
      setModels((cfg?.models ?? []).map((entry) => entry.id));
      setModelWindows({});
      setCatalog(fillCatalogGaps(cfg?.models ?? []));
      setPendingModels(null);
      setContextWindowSource(
        typeof cfg?.contextWindowTokens === "number" ? "manual" : null,
      );
      setPaid(Boolean(cfg?.paid));
      const fields = pricingToFields(
        cfg?.pricing ?? null,
        cfg?.defaultModel ?? "",
      );
      if (!fields.docsUrl && cfg?.baseUrl) {
        fields.docsUrl = guessPricingDocsUrl(cfg.baseUrl) ?? "";
      }
      setPricingFields(fields);
      setLookupProviderId(cfg?.id ?? LOOKUP_THIS);
      setLookupModel(cfg?.defaultModel ?? "");
      setPendingPricing(null);
      setThinking(Boolean(cfg?.thinking));
      setReasoningEffort(cfg?.reasoningEffort ?? "high");
      setContextWindow(
        typeof cfg?.contextWindowTokens === "number" &&
          cfg.contextWindowTokens > 0
          ? String(cfg.contextWindowTokens)
          : "",
      );
      setFormTab("connection");
      setView("form");
      await refreshList();
    } finally {
      setBusy(false);
    }
  }

  function pickLookupProvider(id: string) {
    setLookupProviderId(id);
    if (id === LOOKUP_THIS || !id) {
      setLookupModel(stateRef.current.model.trim());
      return;
    }
    const provider = stateRef.current.providers.find((p) => p.id === id);
    setLookupModel(provider?.defaultModel.trim() ?? "");
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
    setFormTab("models");
    setError(null);
    try {
      const {
        baseUrl: url,
        apiKey: key,
        model: currentModel,
        kind: protocol,
      } = stateRef.current;
      const payload: {
        baseUrl: string;
        apiKey: string;
        kind: ProviderKind;
        model?: string;
      } = {
        baseUrl: url,
        apiKey: key,
        kind: protocol,
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
      const listedEntries: ProviderModelCatalogEntry[] = listed.map((id) => ({
        id,
        source: "listed" as const,
        ...(windows[id] ? { contextWindowTokens: windows[id] } : {}),
      }));
      setCatalog((prev) =>
        fillCatalogGaps(mergeProviderModels(prev, listedEntries)),
      );
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
    setFormTab("models");
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
      const lookupChoices = lookupModelChoices({
        lookupProviderId: lookupId,
        providers: s.providers,
        catalog: s.catalog,
        formModel: s.model,
        lookupModel: s.lookupModel,
      });
      const lookupModelId =
        s.lookupModel.trim() ||
        lookupChoices[0] ||
        s.model.trim() ||
        "default";
      const knownPricing = buildPricingFromFields(s.pricingFields, s.model);
      const catalogPricing =
        knownPricing.ok && knownPricing.pricing
          ? knownPricing.pricing
          : undefined;
      const incompleteIds = s.catalog
        .filter(
          (entry) =>
            modelCapabilityGaps(entry, {
              paid: true,
              ...(catalogPricing ? { pricing: catalogPricing } : {}),
            }).length > 0,
        )
        .map((entry) => entry.id);
      const lookupIds =
        incompleteIds.length > 0
          ? incompleteIds
          : s.catalog.length
            ? s.catalog.map((entry) => entry.id)
            : s.model.trim()
              ? [s.model.trim()]
              : [];
      const result = await bridge.provider.fetchPricing({
        ...(lookupId === LOOKUP_THIS || !lookupId
          ? {
              lookupDraft: {
                baseUrl: s.baseUrl,
                apiKey: s.apiKey,
                model: lookupModelId,
                kind: s.kind,
              },
            }
          : { lookupProviderId: lookupId }),
        ...(lookupModelId && lookupModelId !== "default"
          ? { lookupModel: lookupModelId }
          : {}),
        target: {
          ...(s.name.trim() ? { name: s.name.trim() } : {}),
          baseUrl: s.baseUrl,
          ...(s.model.trim() ? { defaultModel: s.model.trim() } : {}),
          ...(lookupIds.length ? { modelIds: lookupIds } : {}),
        },
        ...(docs ? { docsUrl: docs } : {}),
      });
      if (result?.cancelled) {
        if (result.models?.length) {
          setCatalog((prev) =>
            fillCatalogGaps(mergeProviderModels(prev, result.models ?? [])),
          );
        }
        if (result.pricing) {
          setPricingFields((prev) =>
            mergeIncomingPricing(
              prev,
              result.pricing!,
              stateRef.current.model,
            ),
          );
        }
        setPricingLogs((prev) => [...prev, "Cancelled — kept models fetched so far."]);
        setError(null);
        return;
      }
      if (!result?.ok) {
        if (result.models?.length) {
          setCatalog((prev) =>
            fillCatalogGaps(mergeProviderModels(prev, result.models ?? [])),
          );
        }
        if (result.pricing) {
          setPricingFields((prev) =>
            mergeIncomingPricing(
              prev,
              result.pricing!,
              stateRef.current.model,
            ),
          );
        }
        const message =
          result?.error?.userMessage ??
          result?.error?.technicalDetail ??
          "Could not fetch model data online.";
        setError(message);
        setPricingLogs((prev) => [...prev, message]);
        return;
      }
      const fetchedPricing = result.pricing ?? null;
      const hasRates = Boolean(
        fetchedPricing?.inputPer1M != null ||
          fetchedPricing?.outputPer1M != null ||
          fetchedPricing?.byModel,
      );
      if (result.models?.length) {
        setCatalog((prev) =>
          fillCatalogGaps(mergeProviderModels(prev, result.models ?? [])),
        );
      }
      if (fetchedPricing) {
        setPricingFields((prev) =>
          mergeIncomingPricing(
            prev,
            fetchedPricing,
            stateRef.current.model,
          ),
        );
      }
      if (
        typeof result.contextWindowTokens === "number" &&
        result.contextWindowTokens >= 4_000
      ) {
        setContextWindow(String(result.contextWindowTokens));
        setContextWindowSource("provider");
      }
      if (result.docsUrl) {
        patchPricing({ docsUrl: result.docsUrl });
      }
      if (hasRates) setPaid(true);
      setPendingPricing(null);
      setPendingModels(null);
      setPendingContextWindow(null);
      setError(null);
      setPricingLogs((prev) => [
        ...prev,
        result.models?.length
          ? `Done — ${result.models.length} model${
              result.models.length === 1 ? "" : "s"
            } updated in the catalog.`
          : "Done.",
      ]);
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
    const pendingCaps = stateRef.current.pendingModels;
    if (!pending && !pendingCaps?.length) return;
    if (pending) {
      const fields = pricingToFields(pending, stateRef.current.model.trim());
      if (!fields.docsUrl && pending.sourceUrl) {
        fields.docsUrl = pending.sourceUrl;
      }
      setPricingFields(fields);
      const hasRates = Boolean(
        pending.inputPer1M != null ||
          pending.outputPer1M != null ||
          pending.byModel,
      );
      if (hasRates) setPaid(true);
    }
    if (pendingCaps?.length) {
      setCatalog((prev) => mergeProviderModels(prev, pendingCaps));
    }
    const ctx = stateRef.current.pendingContextWindow;
    if (typeof ctx === "number" && ctx >= 4_000) {
      setContextWindow(String(ctx));
      setContextWindowSource("provider");
      const selected = stateRef.current.model.trim();
      if (selected) {
        setCatalog((prev) =>
          mergeProviderModels(prev, [
            {
              id: selected,
              contextWindowTokens: ctx,
              source: "fetched",
            },
          ]),
        );
      }
    }
    setPendingPricing(null);
    setPendingModels(null);
    setPendingContextWindow(null);
    setError(null);
  }

  function discardPendingPricing() {
    setPendingPricing(null);
    setPendingModels(null);
    setPendingContextWindow(null);
  }

  function patchCatalog(
    id: string,
    patch: Partial<ProviderModelCatalogEntry>,
  ) {
    setCatalog((prev) =>
      mergeProviderModels(prev, [{ id, ...patch, source: "user" }]),
    );
  }

  function selectCatalogModel(id: string) {
    const previous = stateRef.current.model.trim();
    setPricingFields((prev) => {
      const flushed = previous ? flushSelectedModelRates(prev, previous) : prev;
      return {
        ...flushed,
        ...rateFieldsFromModel(flushed.pricingExtra?.byModel?.[id]),
      };
    });
    setModel(id);
    const entry = stateRef.current.catalog.find((item) => item.id === id);
    if (entry?.contextWindowTokens) {
      setContextWindow(String(entry.contextWindowTokens));
      setContextWindowSource("provider");
    }
  }

  async function save() {
    const bridge = getBridge();
    const s = stateRef.current;
    if (!bridge || s.busy || !s.model.trim()) return;
    if (s.pendingPricing || s.pendingModels?.length) {
      setError("Confirm or discard the fetched model data before saving.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const built = buildPricingFromFields(s.pricingFields, s.model);
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
        kind: s.kind,
        paid,
        ...(built.pricing ? { pricing: built.pricing } : {}),
        ...(s.catalog.length
          ? { models: s.catalog }
          : s.model.trim()
            ? {
                models: [
                  {
                    id: s.model.trim(),
                    source: "user" as const,
                    ...(contextWindowTokens && contextWindowTokens > 0
                      ? { contextWindowTokens }
                      : {}),
                  },
                ],
              }
            : {}),
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
        if (s.pendingPricing || s.pendingModels?.length) {
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
      if (s.pendingPricing || s.pendingModels?.length) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          applyPendingPricing();
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const tabDigit = digitFromCode(e.code);
        if (tabDigit === 1) {
          e.preventDefault();
          setFormTab("connection");
          return;
        }
        if (tabDigit === 2) {
          e.preventDefault();
          setFormTab("models");
          return;
        }
        if (tabDigit === 3) {
          e.preventDefault();
          setFormTab("pricing");
          return;
        }
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
        const catalogDigit = digitFromCode(e.code);
        if (
          (s.formTab === "models" || s.formTab === "pricing") &&
          catalogDigit &&
          s.catalog[catalogDigit - 1] &&
          !e.shiftKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          selectCatalogModel(s.catalog[catalogDigit - 1]!.id);
          return;
        }
        if (
          s.formTab === "models" &&
          e.key.toLowerCase() === "v" &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          const id = s.model.trim();
          if (id) {
            const current = s.catalog.find((entry) => entry.id === id);
            patchCatalog(id, { vision: cycleModelFlag(current?.vision) });
          }
          return;
        }
        if (
          s.formTab === "models" &&
          e.key.toLowerCase() === "f" &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          const id = s.model.trim();
          if (id) {
            const current = s.catalog.find((entry) => entry.id === id);
            patchCatalog(id, { tools: cycleModelFlag(current?.tools) });
          }
          return;
        }
        if (
          s.formTab === "connection" &&
          e.key.toLowerCase() === "t" &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          setThinking((v) => !v);
          return;
        }
        if (
          s.formTab === "connection" &&
          e.key.toLowerCase() === "p" &&
          !e.metaKey &&
          !e.altKey
        ) {
          e.preventDefault();
          cycleKind();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          setError(null);
          setView("list");
          return;
        }
        if (s.formTab === "connection" && s.thinking) {
          const effortDigit = digitFromCode(e.code);
          const effort =
            effortDigit && effortDigit <= EFFORT_OPTIONS.length
              ? EFFORT_OPTIONS[effortDigit - 1]
              : undefined;
          if (
            effort &&
            (s.catalog.length === 0 || e.shiftKey)
          ) {
            e.preventDefault();
            setReasoningEffort(effort.value);
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
  const hasPendingFetch = Boolean(pendingPricing || pendingModels?.length);
  const displayedCatalog =
    catalog.length > 0
      ? catalog
      : model.trim()
        ? [{ id: model.trim(), source: "user" as const }]
        : [];
  const lookupModelOptions = lookupModelChoices({
    lookupProviderId,
    providers,
    catalog: displayedCatalog,
    formModel: model,
    lookupModel,
  });
  const lookupModelValue = lookupModel.trim() || lookupModelOptions[0] || "";
  const builtFormPricing = buildPricingFromFields(pricingFields, model);
  const formPricing = builtFormPricing.ok ? builtFormPricing.pricing : null;
  const humanGaps = catalogNeedsHuman({
    models: displayedCatalog,
    paid,
    ...(formPricing ? { pricing: formPricing } : {}),
  });

  const formView = (
    <form
      className="onboarding-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (hasPendingFetch) applyPendingPricing();
        else void save();
      }}
    >
      <div className="provider-form-tabs" role="tablist" aria-label="Provider form">
        {(
          [
            { id: "connection" as const, label: "Connection", hint: modHint("1") },
            { id: "models" as const, label: "Models", hint: modHint("2") },
            { id: "pricing" as const, label: "Pricing", hint: modHint("3") },
          ] as const
        ).map((tab) => {
          const badge =
            tab.id === "models" && humanGaps
              ? humanGaps
              : tab.id === "pricing" && paid && !formPricing
                ? "!"
                : tab.id === "models" && hasPendingFetch
                  ? "•"
                  : null;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={formTab === tab.id}
              className={`provider-form-tab ${
                formTab === tab.id ? "provider-form-tab-active" : ""
              }`}
              onClick={() => setFormTab(tab.id)}
            >
              {tab.label}
              {badge != null ? (
                <span className="provider-form-tab-badge">{badge}</span>
              ) : null}
              <span className="provider-form-tab-sc">· {tab.hint}</span>
            </button>
          );
        })}
      </div>

      <div className="provider-form-panel" hidden={formTab !== "connection"}>
      <div className="provider-form-section">
        <h3 className="provider-form-heading">Endpoint</h3>
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
            if (!kindPinned) setKind(inferProviderKind(next));
            if (!pricingFields.docsUrl.trim()) {
              const guess = guessPricingDocsUrl(next);
              if (guess) patchPricing({ docsUrl: guess });
            }
          }}
          placeholder="https://api.deepseek.com"
        />
      </label>
      <label>
        Protocol · P
        <select
          className="input"
          value={kind}
          onChange={(e) => pickKind(e.target.value as ProviderKind)}
        >
          {KIND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <p className="start-build-hint">
        {kind === "anthropic"
          ? "Native Anthropic Messages API: x-api-key auth, prompt caching, images inside tool results."
          : kind === "deepseek"
            ? "DeepSeek API: chain-of-thought reasoning is returned separately."
            : "Standard /v1/chat/completions with a Bearer key — also the right pick for local servers."}
      </p>
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
      </div>
      <div className="provider-form-section">
        <h3 className="provider-form-heading">Reasoning</h3>
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
                {label} · {catalog.length ? `⇧${shortcut}` : shortcut}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      </div>

      <div className="provider-form-panel" hidden={formTab !== "models"}>
      <div className="provider-form-section">
        <h3 className="provider-form-heading">Catalog</h3>
      <div className="provider-model-field">
        <label htmlFor="model">Default model</label>
        <div className="provider-model-row">
          {catalog.length === 0 ? (
            <input
              id="model"
              className="input"
              value={model}
              placeholder="e.g. gpt-4o-mini"
              onChange={(e) => setModel(e.target.value)}
            />
          ) : null}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={listing}
            onClick={() => void listModels()}
          >
            {listing ? "Listing…" : `List models · ${modHint("L")}`}
          </button>
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
              : `Fetch model data · ${modHint("G")}`}
          </button>
        </div>
        <span className="start-build-hint">
          {displayedCatalog.length > 0
            ? `${displayedCatalog.length} model${
                displayedCatalog.length === 1 ? "" : "s"
              } — pick one (1–9), then fill Unknown flags. ${
                humanGaps
                  ? `${humanGaps} still need you.`
                  : "All flags complete."
              }`
            : "List models from the endpoint, then fetch pricing / vision / tools. Type an id if the server has no catalog."}
        </span>
        <div className="provider-pricing-lookup-row">
          <label className="provider-pricing-lookup">
            Lookup provider
            <select
              className="input"
              value={lookupProviderId}
              onChange={(e) => pickLookupProvider(e.target.value)}
            >
              <option value={LOOKUP_THIS}>This form (draft)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="provider-pricing-lookup">
            Lookup model
            <select
              className="input"
              value={lookupModelValue}
              onChange={(e) => setLookupModel(e.target.value)}
              disabled={lookupModelOptions.length === 0}
            >
              {lookupModelOptions.length === 0 ? (
                <option value="">No models listed</option>
              ) : (
                lookupModelOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>
        <label>
          Docs URL (pricing / model cards)
          <input
            className="input"
            value={pf.docsUrl}
            placeholder="https://lmstudio.ai/docs/app/basics/models"
            onChange={(e) => patchPricing({ docsUrl: e.target.value })}
          />
        </label>
        {fetchingPricing || pricingLogs.length > 0 ? (
          <pre
            ref={pricingLogRef}
            className="provider-pricing-log"
            aria-live="polite"
          >
            {pricingLogs.join("\n")}
          </pre>
        ) : null}
        <ProviderModelCatalog
          models={displayedCatalog}
          selectedId={model}
          paid={paid}
          {...(formPricing ? { pricing: formPricing } : {})}
          onSelect={selectCatalogModel}
          onPatch={patchCatalog}
        />
        {pendingPricing || pendingModels?.length ? (
          <div className="provider-pricing-confirm" role="status">
            <p className="provider-pricing-confirm-lead">
              Fetched model data ready — apply to the form (does not save yet).
              {pendingModels?.length
                ? ` ${pendingModels.length} model capabilit${
                    pendingModels.length === 1 ? "y" : "ies"
                  }.`
                : ""}
              {pendingContextWindow
                ? ` Context window: ${pendingContextWindow.toLocaleString()} tokens.`
                : ""}
            </p>
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
            const raw = e.target.value.trim().replace(/[_\s,]/g, "");
            const n = Number(raw);
            const selected = stateRef.current.model.trim();
            if (selected && Number.isInteger(n) && n >= 4_000) {
              patchCatalog(selected, { contextWindowTokens: n });
            }
          }}
        />
        <span className="start-build-hint">
          {contextWindowSource === "provider"
            ? "Filled from Fetch model data / provider docs. Compaction uses ~75% of this."
            : models.length > 0 && Object.keys(modelWindows).length === 0
              ? "Use Fetch model data · ⌘G (or List models) to try auto-fill. Otherwise enter manually (32k / 64k / 128k / 200k)."
              : "Fetch model data · ⌘G fills context window from docs when available. Compaction triggers around 75% of this value."}
        </span>
      </label>
      </div>
      </div>

      <div className="provider-form-panel" hidden={formTab !== "pricing"}>
      <div className="provider-form-section">
        <h3 className="provider-form-heading">Cost</h3>
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
          {displayedCatalog.length > 0 ? (
            <div
              className="provider-pricing-models"
              role="tablist"
              aria-label="Model rates"
            >
              {displayedCatalog.map((entry, index) => {
                const band = resolvePricingBand(formPricing, {
                  model: entry.id,
                });
                const summary = formatRateBand(band);
                const active = entry.id === model.trim();
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`provider-pricing-model ${
                      active ? "provider-pricing-model-active" : ""
                    }`}
                    onClick={() => selectCatalogModel(entry.id)}
                  >
                    <span className="provider-pricing-model-id">{entry.id}</span>
                    <span className="provider-pricing-model-meta">
                      {summary ?? "no price"}
                      {index < 9 ? ` · ${index + 1}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <p className="start-build-hint">
            {model.trim()
              ? `USD per 1M tokens for ${model.trim()}. Flash and Pro (and every other id) have their own rates — pick a model, then edit.`
              : "Pick a model on the Models tab first. Each model has its own price list."}
          </p>
          <fieldset className="provider-pricing-rates" disabled={!model.trim()}>
          <div className="provider-pricing-grid">
            <label>
              Input $/1M
              <input
                className="input"
                inputMode="decimal"
                placeholder="e.g. 0.44"
                value={pf.inputPer1M}
                onChange={(e) => patchModelRates({ inputPer1M: e.target.value })}
              />
            </label>
            <label>
              Output $/1M
              <input
                className="input"
                inputMode="decimal"
                placeholder="e.g. 1.32"
                value={pf.outputPer1M}
                onChange={(e) => patchModelRates({ outputPer1M: e.target.value })}
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
                  patchModelRates({ inputCacheHitPer1M: e.target.value })
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
                  patchModelRates({ inputCacheMissPer1M: e.target.value })
                }
              />
            </label>
          </div>

          <label className="start-build-check">
            <input
              type="checkbox"
              checked={pf.useSchedule}
              onChange={(e) => patchModelRates({ useSchedule: e.target.checked })}
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
                    patchModelRates({ peakWindows: e.target.value })
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
                      patchModelRates({ peakInput: e.target.value })
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
                      patchModelRates({ peakOutput: e.target.value })
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
                      patchModelRates({ peakCacheHit: e.target.value })
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
                      patchModelRates({ peakCacheMiss: e.target.value })
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
                      patchModelRates({ offPeakInput: e.target.value })
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
                      patchModelRates({ offPeakOutput: e.target.value })
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
                      patchModelRates({ offPeakCacheHit: e.target.value })
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
                      patchModelRates({ offPeakCacheMiss: e.target.value })
                    }
                  />
                </label>
              </div>
            </>
          ) : null}
          </fieldset>

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
      ) : (
        <p className="start-build-hint">
          Turn on Paid provider when this endpoint bills per token. Each model
          then gets its own rate list — Fetch model data · {modHint("G")} can
          fill them.
        </p>
      )}
      </div>
      </div>

      {error ? <p className="start-build-error">{error}</p> : null}

      <div className="onboarding-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => {
            if (hasPendingFetch) {
              discardPendingPricing();
              return;
            }
            setError(null);
            setView("list");
          }}
        >
          {hasPendingFetch ? "Discard · Esc" : "Back · Esc"}
        </button>
        <button
          type="submit"
          className="btn"
          disabled={
            busy ||
            listing ||
            fetchingPricing ||
            (!hasPendingFetch && !model.trim())
          }
        >
          {busy
            ? "Saving…"
            : hasPendingFetch
              ? "Apply to form · Enter"
              : "Save · Enter"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="overlay provider-overlay" role="presentation">
      <div
        className={`provider-dialog ${
          view === "form" ? "provider-dialog-form" : ""
        }`}
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
              if (pendingPricing || pendingModels?.length) {
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
            {pendingPricing || pendingModels?.length
              ? "Discard · Esc"
              : view === "form"
                ? "Back · Esc"
                : "Close · Esc"}
          </button>
        </div>
        <div
          className={`provider-dialog-body ${
            view === "form" ? "provider-dialog-body-form" : ""
          }`}
        >
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
