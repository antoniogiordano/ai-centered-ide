import { useEffect, useRef, useState } from "react";
import { getBridge } from "../bridge";

type Step = "baseUrl" | "apiKey" | "verify" | "model";

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
  const [step, setStep] = useState<Step>("baseUrl");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const { open, onCancel, onComplete } = props;
  const stateRef = useRef({
    step,
    busy,
    model,
    baseUrl,
    apiKey,
    onCancel,
    onComplete,
  });
  stateRef.current = {
    step,
    busy,
    model,
    baseUrl,
    apiKey,
    onCancel,
    onComplete,
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStep("baseUrl");
    setBusy(false);
    setHydrated(false);
    void (async () => {
      try {
        const cfg = await getBridge()?.provider.getConfig();
        if (cancelled) return;
        setBaseUrl(cfg?.baseUrl?.trim() ? cfg.baseUrl : DEFAULT_BASE_URL);
        setApiKey(cfg?.apiKey ?? "");
        if (cfg?.defaultModel) {
          setModel(cfg.defaultModel);
          setModels([cfg.defaultModel]);
        } else {
          setModel("");
          setModels([]);
        }
      } catch {
        if (!cancelled) {
          setBaseUrl(DEFAULT_BASE_URL);
          setApiKey("");
          setModel("");
          setModels([]);
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function verify() {
    const bridge = getBridge();
    if (!bridge) return;
    setBusy(true);
    try {
      const { baseUrl: url, apiKey: key, model: currentModel } =
        stateRef.current;
      const payload: { baseUrl: string; apiKey: string; model?: string } = {
        baseUrl: url,
        apiKey: key,
      };
      if (currentModel) payload.model = currentModel;
      const result = await bridge.provider.verify(payload);
      if (!result.ok) return;
      setModels(result.models ?? []);
      setStep("model");
    } catch {
      /* silent */
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const bridge = getBridge();
    const { model: currentModel, baseUrl: url, apiKey: key } =
      stateRef.current;
    if (!bridge || !currentModel.trim()) return;
    setBusy(true);
    try {
      await bridge.provider.saveConfig({
        baseUrl: url,
        apiKey: key,
        defaultModel: currentModel.trim(),
      });
      stateRef.current.onComplete();
    } catch {
      /* silent */
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    const { step: current } = stateRef.current;
    if (current === "apiKey") setStep("baseUrl");
    else if (current === "verify") setStep("apiKey");
    else if (current === "model") setStep("verify");
  }

  function submitStep() {
    const { step: current, busy: isBusy, model: currentModel } =
      stateRef.current;
    if (isBusy) return;
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
        stateRef.current.onCancel();
        return;
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

      {step === "baseUrl" && (
        <div className="field">
          <label htmlFor="baseUrl">Base URL</label>
          <input
            id="baseUrl"
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            autoFocus
          />
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
            >
              Cancel <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setStep("apiKey")}
            >
              Continue <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      )}

      {step === "apiKey" && (
        <div className="field">
          <label htmlFor="apiKey">API Key (optional for local)</label>
          <input
            id="apiKey"
            className="input"
            type="password"
            value={apiKey}
            placeholder="Leave empty for Ollama / local"
            onChange={(e) => setApiKey(e.target.value)}
            autoFocus
          />
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
            >
              Cancel <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep("baseUrl")}
            >
              Back <kbd>⌫</kbd>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setStep("verify")}
            >
              Continue <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      )}

      {step === "verify" && (
        <div className="field">
          <p style={{ color: "var(--text-muted)", margin: 0, fontSize: 13 }}>
            Fetch the model list from <code>{baseUrl}</code>, then pick a
            default.
          </p>
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setStep("apiKey")}
            >
              Back <kbd>⌫</kbd>
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void verify()}
            >
              {busy ? "Loading models…" : "List models"} <kbd>Enter</kbd>
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
              <option value="">Select a model</option>
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
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel <kbd>Esc</kbd>
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setStep("verify")}
            >
              Back <kbd>⌫</kbd>
            </button>
            <button
              type="button"
              className="btn"
              disabled={!model.trim() || busy}
              onClick={() => void save()}
            >
              Save <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div
      className="palette-overlay provider-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="provider-dialog-header">
          <div>
            <div className="provider-dialog-kicker">Settings</div>
            <h2 id="provider-dialog-title" className="provider-dialog-title">
              AI provider
            </h2>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCancel}
            title="Close (Esc)"
          >
            Esc
          </button>
        </header>
        <div className="provider-dialog-body">
          <p className="provider-dialog-lead">
            OpenAI-compatible Base URL, optional API key, then pick a model.
          </p>
          {body}
        </div>
      </div>
    </div>
  );
}
