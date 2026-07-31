import { useState } from "react";
import { getBridge } from "../bridge";

type Step = "baseUrl" | "apiKey" | "verify" | "model";

export function OnboardingWizard(props: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("baseUrl");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    const bridge = getBridge();
    if (!bridge) return;
    setBusy(true);
    setError(null);
    const payload: { baseUrl: string; apiKey: string; model?: string } = {
      baseUrl,
      apiKey,
    };
    if (model) payload.model = model;
    const result = await bridge.provider.verify(payload);
    setBusy(false);
    if (!result.ok) {
      setError(result.error?.userMessage ?? "Verification failed");
      return;
    }
    setModels(result.models ?? []);
    setStep("model");
  }

  async function save() {
    const bridge = getBridge();
    if (!bridge || !model) return;
    setBusy(true);
    await bridge.provider.saveConfig({ baseUrl, apiKey, defaultModel: model });
    setBusy(false);
    props.onComplete();
  }

  return (
    <div className="onboarding">
      <h2>Connect your AI provider</h2>
      <p style={{ color: "var(--text-muted)", margin: 0 }}>
        One required setup: Base URL for an OpenAI-compatible endpoint.
      </p>

      {step === "baseUrl" && (
        <div className="field">
          <label htmlFor="baseUrl">Base URL</label>
          <input
            id="baseUrl"
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setStep("apiKey")}>
            Continue
          </button>
        </div>
      )}

      {step === "apiKey" && (
        <div className="field">
          <label htmlFor="apiKey">API Key</label>
          <input
            id="apiKey"
            className="input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setStep("verify")}>
            Continue
          </button>
        </div>
      )}

      {step === "verify" && (
        <div>
          <button className="btn" disabled={busy} onClick={() => void verify()}>
            {busy ? "Verifying…" : "Verify connection"}
          </button>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      )}

      {step === "model" && (
        <div className="field">
          <label htmlFor="model">Default model</label>
          <select
            id="model"
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Select a model</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className="btn"
            style={{ marginTop: 12 }}
            disabled={!model || busy}
            onClick={() => void save()}
          >
            Save and continue
          </button>
        </div>
      )}
    </div>
  );
}
