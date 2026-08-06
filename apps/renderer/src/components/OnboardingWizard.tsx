import { useEffect, useRef, useState } from "react";
import { parseUsdRate } from "@ai-ide/shared";
import { getBridge } from "../bridge";

type Step = "list" | "baseUrl" | "apiKey" | "verify" | "model";

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

const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export function OnboardingWizard(props: {
  open: boolean;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("list");
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
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { open, onCancel, onComplete } = props;
  const stateRef = useRef({
    step,
    busy,
    model,
    baseUrl,
    apiKey,
    name,
    paid,
    inputPer1M,
    outputPer1M,
    editingId,
    providers,
    onCancel,
    onComplete,
  });
  stateRef.current = {
    step,
    busy,
    model,
    baseUrl,
    apiKey,
    name,
    paid,
    inputPer1M,
    outputPer1M,
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
    setStep("list");
    setBusy(false);
    setHydrated(false);
    setEditingId(null);
    setError(null);
    void (async () => {
      try {
        await refreshList();
        const cfg = await getBridge()?.provider.getConfig();
        if (cancelled) return;
        setBaseUrl(cfg?.baseUrl?.trim() ? cfg.baseUrl : DEFAULT_BASE_URL);
        setApiKey(cfg?.apiKey ?? "");
        setName(cfg?.name ?? "");
        setPaid(Boolean(cfg?.paid));
        setInputPer1M(
          cfg?.pricing?.inputPer1M != null
            ? String(cfg.pricing.inputPer1M)
            : "",
        );
        setOutputPer1M(
          cfg?.pricing?.outputPer1M != null
            ? String(cfg.pricing.outputPer1M)
            : "",
        );
        setModel(cfg?.defaultModel ?? "");
        setModels([]);
        setEditingId(cfg?.id ?? null);
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
    setError(null);
    setStep("baseUrl");
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
      // Don't pretend we listed models — force a fresh List models for the select.
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
      setStep("baseUrl");
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

  async function verify() {
    const bridge = getBridge();
    if (!bridge) return;
    setBusy(true);
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
        setStep("model");
        return;
      }
      setModels(listed);
      setModel((prev) => (prev && listed.includes(prev) ? prev : listed[0]!));
      setError(null);
      setStep("model");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const bridge = getBridge();
    const s = stateRef.current;
    if (!bridge || !s.model.trim()) return;
    setBusy(true);
    try {
      const inRaw = s.inputPer1M.trim();
      const outRaw = s.outputPer1M.trim();
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
        name: s.name.trim() || (s.paid ? "Cloud provider" : "Local provider"),
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        defaultModel: s.model.trim(),
        paid: s.paid,
        ...(pricing && Object.keys(pricing).length ? { pricing } : {}),
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

  function goBack() {
    const { step: current } = stateRef.current;
    if (current === "baseUrl") setStep("list");
    else if (current === "apiKey") setStep("baseUrl");
    else if (current === "verify") setStep("apiKey");
    else if (current === "model") setStep("verify");
  }

  function submitStep() {
    const { step: current, busy: isBusy, model: currentModel } =
      stateRef.current;
    if (isBusy) return;
    if (current === "list") return;
    if (current === "baseUrl") setStep("apiKey");
    else if (current === "apiKey") setStep("verify");
    else if (current === "verify") void verify();
    else if (current === "model" && currentModel.trim()) void save();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (stateRef.current.step === "list") stateRef.current.onCancel();
        else goBack();
        return;
      }

      if (stateRef.current.step === "list" && !isTypingTarget(e.target)) {
        if (e.key.toLowerCase() === "a") {
          e.preventDefault();
          startNew();
          return;
        }
        const digit = Number(e.key);
        if (
          digit >= 1 &&
          digit <= 9 &&
          stateRef.current.providers[digit - 1]
        ) {
          e.preventDefault();
          void activate(stateRef.current.providers[digit - 1]!.id);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitStep();
        return;
      }

      if (e.key === "Backspace" && !isTypingTarget(e.target)) {
        e.preventDefault();
        goBack();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const body = !hydrated ? (
    <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading…</p>
  ) : (
    <>
      {step === "list" && (
        <div className="field">
          <p className="muted" style={{ marginTop: 0 }}>
            Saved providers. Activate one or add a new OpenAI-compatible
            endpoint.
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
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void remove(p.id)}
                >
                  Delete
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
              className="btn btn-secondary"
              onClick={onCancel}
            >
              Close · Esc
            </button>
            <button type="button" className="btn" onClick={startNew}>
              Add provider · A
            </button>
          </div>
        </div>
      )}

      {step === "baseUrl" && (
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
          <label htmlFor="baseUrl">Base URL</label>
          <input
            id="baseUrl"
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep("list")}
            >
              Back · ⌫
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setStep("apiKey")}
            >
              Continue · Enter
            </button>
          </div>
        </div>
      )}

      {step === "apiKey" && (
        <div className="field">
          <label htmlFor="apiKey">API key (optional for local)</label>
          <input
            id="apiKey"
            className="input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep("baseUrl")}
            >
              Back · ⌫
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setStep("verify")}
            >
              Continue · Enter
            </button>
          </div>
        </div>
      )}

      {step === "verify" && (
        <div className="field">
          <p>List models from this endpoint to confirm it works.</p>
          {error ? <p className="start-build-error">{error}</p> : null}
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep("apiKey")}
            >
              Back · ⌫
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void verify()}
            >
              {busy ? "Listing…" : "List models · Enter"}
            </button>
          </div>
        </div>
      )}

      {step === "model" && (
        <div className="field">
          <label htmlFor="model">Default model</label>
          {models.length > 0 ? (
            <select
              id="model"
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              autoFocus
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
              autoFocus
            />
          )}
          <span className="start-build-hint">
            {models.length > 0
              ? `${models.length} model${models.length === 1 ? "" : "s"} from provider`
              : "No list yet — re-run List models or type an id"}
          </span>
          {error ? <p className="start-build-error">{error}</p> : null}

          <label className="start-build-check" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
            />
            <span>
              Paid provider <span className="provider-paid-sign">$</span> —
              show cost estimates in the top bar
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

          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setError(null);
                setStep("verify");
              }}
            >
              Re-list · ⌫
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !model.trim()}
              onClick={() => void save()}
            >
              Save · Enter
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="overlay" role="presentation">
      <div
        className="dialog onboarding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-dialog-title"
      >
        <div className="dialog-header">
          <h2 id="provider-dialog-title">Providers</h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCancel}
          >
            Esc
          </button>
        </div>
        <div className="dialog-body">{body}</div>
      </div>
    </div>
  );
}
