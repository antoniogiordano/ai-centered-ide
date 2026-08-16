import { useEffect, useRef, useState } from "react";
import {
  parseUsdRate,
  REASONING_EFFORT_VALUES,
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
};

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
  const [paid, setPaid] = useState(false);
  const [inputPer1M, setInputPer1M] = useState("");
  const [outputPer1M, setOutputPer1M] = useState("");
  const [thinking, setThinking] = useState(false);
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { open, onCancel, onComplete } = props;
  const stateRef = useRef({
    view,
    busy,
    listing,
    model,
    baseUrl,
    apiKey,
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
    model,
    baseUrl,
    apiKey,
    thinking,
    editingId,
    providers,
    onCancel,
    onComplete,
  };

  async function refreshList() {
    const list = await getBridge()?.provider.list();
    setProviders(list?.providers ?? []);
    setActiveId(list?.activeId ?? null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setView("list");
    setBusy(false);
    setListing(false);
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
    setPaid(false);
    setInputPer1M("");
    setOutputPer1M("");
    setThinking(false);
    setReasoningEffort("high");
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
      // Don't pretend we listed models — user can re-list from the form.
      setModels([]);
      setPaid(Boolean(cfg?.paid));
      setInputPer1M(
        cfg?.pricing?.inputPer1M != null ? String(cfg.pricing.inputPer1M) : "",
      );
      setOutputPer1M(
        cfg?.pricing?.outputPer1M != null
          ? String(cfg.pricing.outputPer1M)
          : "",
      );
      setThinking(Boolean(cfg?.thinking));
      setReasoningEffort(cfg?.reasoningEffort ?? "high");
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
        setError(
          "Provider returned no models. Check the base URL / API key, or type a model id manually.",
        );
        return;
      }
      setModels(listed);
      setModel((prev) => (prev && listed.includes(prev) ? prev : listed[0]!));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setListing(false);
    }
  }

  async function save() {
    const bridge = getBridge();
    const s = stateRef.current;
    if (!bridge || s.busy || !s.model.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const inRaw = inputPer1M.trim();
      const outRaw = outputPer1M.trim();
      const inRate = inRaw ? parseUsdRate(inRaw) : undefined;
      const outRate = outRaw ? parseUsdRate(outRaw) : undefined;
      if (inRaw && inRate == null) {
        setError(
          "Input $/1M is invalid. Use a number like 2.5 or 2,5 (comma or dot).",
        );
        setBusy(false);
        return;
      }
      if (outRaw && outRate == null) {
        setError(
          "Output $/1M is invalid. Use a number like 10 or 10,00 (comma or dot).",
        );
        setBusy(false);
        return;
      }
      const pricing =
        inRate != null || outRate != null
          ? {
              ...(inRate != null ? { inputPer1M: inRate } : {}),
              ...(outRate != null ? { outputPer1M: outRate } : {}),
            }
          : undefined;
      await bridge.provider.saveConfig({
        ...(s.editingId ? { id: s.editingId } : {}),
        name: name.trim() || (paid ? "Cloud provider" : "Local provider"),
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        defaultModel: s.model.trim(),
        paid,
        ...(pricing && Object.keys(pricing).length ? { pricing } : {}),
        thinking,
        reasoningEffort,
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
    // Stable entry point for the keydown handler (save reads via stateRef).
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

      // Form view.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void listModels();
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
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Close · Esc
        </button>
        <button type="button" className="btn" onClick={startNew}>
          Add provider · A
        </button>
      </div>
    </>
  );

  const formView = (
    <form
      className="provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="field">
        <label htmlFor="providerName">Display name</label>
        <input
          id="providerName"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. OpenAI, Ollama, Together"
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="baseUrl">Base URL</label>
        <input
          id="baseUrl"
          className="input"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={DEFAULT_BASE_URL}
        />
      </div>

      <div className="field">
        <label htmlFor="apiKey">API key (optional for local)</label>
        <input
          id="apiKey"
          className="input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="model">Default model</label>
        <div className="provider-model-row">
          {models.length > 0 ? (
            <select
              id="model"
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
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
        <div className="provider-pricing-grid">
          <label>
            Input $/1M tokens
            <input
              className="input"
              inputMode="decimal"
              placeholder="e.g. 2,5 or 2.5"
              value={inputPer1M}
              onChange={(e) => setInputPer1M(e.target.value)}
            />
          </label>
          <label>
            Output $/1M tokens
            <input
              className="input"
              inputMode="decimal"
              placeholder="e.g. 10 or 10,00"
              value={outputPer1M}
              onChange={(e) => setOutputPer1M(e.target.value)}
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
            setError(null);
            setView("list");
          }}
        >
          Back · Esc
        </button>
        <button
          type="submit"
          className="btn"
          disabled={busy || listing || !model.trim()}
        >
          {busy ? "Saving…" : "Save · Enter"}
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
              if (view === "form") {
                setError(null);
                setView("list");
              } else {
                onCancel();
              }
            }}
          >
            {view === "form" ? "Back · Esc" : "Close · Esc"}
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
