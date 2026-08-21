import {
  formatRateBand,
  modelCapabilityGaps,
  resolvePricingBand,
  type ProviderModelCapabilityGap,
  type ProviderModelCatalogEntry,
  type ProviderPricing,
} from "@ai-ide/shared";

function cycleFlag(value: boolean | undefined): boolean | undefined {
  if (value === undefined) return true;
  if (value === true) return false;
  return undefined;
}

function flagLabel(value: boolean | undefined): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

function gapLabel(gap: ProviderModelCapabilityGap): string {
  switch (gap) {
    case "vision":
      return "vision";
    case "tools":
      return "tools";
    case "pricing":
      return "price";
    case "context":
      return "context";
  }
}

/**
 * Per-model capabilities for a provider. The catalog is the source of truth
 * for vision / tools / context: a missing flag is shown as Unknown so the
 * human can fill it, especially on local servers that have no public docs.
 */
export function ProviderModelCatalog(props: {
  models: ProviderModelCatalogEntry[];
  selectedId: string;
  paid: boolean;
  pricing?: ProviderPricing | null | undefined;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Partial<ProviderModelCatalogEntry>) => void;
}) {
  const { models, selectedId, paid, pricing, onSelect, onPatch } = props;
  if (models.length === 0) return null;

  return (
    <div className="provider-model-catalog" role="group" aria-label="Models">
      <p className="start-build-hint">
        Vision, tools, and price live on the model, not the provider. Unknown
        means we could not find it — fill it in, especially for LM Studio /
        local servers.
      </p>
      <ul className="provider-model-catalog-list">
        {models.map((entry, index) => {
          const gaps = modelCapabilityGaps(entry, { paid, pricing });
          const selected = entry.id === selectedId;
          const price = formatRateBand(
            resolvePricingBand(pricing, { model: entry.id }),
          );
          return (
            <li
              key={entry.id}
              className={`provider-model-catalog-row ${
                selected ? "provider-model-catalog-row-active" : ""
              }`}
            >
              <button
                type="button"
                className="provider-model-catalog-pick"
                aria-pressed={selected}
                title={`Use ${entry.id} as the active model${
                  index < 9 ? ` (${index + 1})` : ""
                }`}
                onClick={() => onSelect(entry.id)}
              >
                <span className="provider-model-catalog-id">{entry.id}</span>
                {entry.contextWindowTokens ? (
                  <span className="provider-model-catalog-meta">
                    {entry.contextWindowTokens.toLocaleString()} ctx
                  </span>
                ) : null}
                {price ? (
                  <span className="provider-model-catalog-meta">{price}</span>
                ) : paid ? (
                  <span className="provider-model-catalog-meta">no price</span>
                ) : null}
                {index < 9 ? (
                  <span className="provider-model-catalog-sc">
                    · {index + 1}
                  </span>
                ) : null}
                {selected ? (
                  <span className="provider-model-catalog-active">Active</span>
                ) : null}
              </button>
              <div className="provider-model-catalog-flags">
                <button
                  type="button"
                  className={`btn btn-sm ${
                    entry.vision === undefined
                      ? "btn-secondary"
                      : "btn-primary"
                  }`}
                  title={`Vision for ${entry.id}${selected ? " (V)" : ""}`}
                  onClick={() =>
                    onPatch(entry.id, {
                      vision: cycleFlag(entry.vision),
                      source: "user",
                    })
                  }
                >
                  Vision · {flagLabel(entry.vision)}
                  {selected ? " · V" : ""}
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${
                    entry.tools === undefined ? "btn-secondary" : "btn-primary"
                  }`}
                  title={`Tool calling for ${entry.id}${selected ? " (F)" : ""}`}
                  onClick={() =>
                    onPatch(entry.id, {
                      tools: cycleFlag(entry.tools),
                      source: "user",
                    })
                  }
                >
                  Tools · {flagLabel(entry.tools)}
                  {selected ? " · F" : ""}
                </button>
              </div>
              {gaps.length ? (
                <p className="provider-model-catalog-gaps" role="status">
                  Needs you: {gaps.map(gapLabel).join(", ")}
                </p>
              ) : (
                <p className="provider-model-catalog-ok">Complete</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function cycleModelFlag(value: boolean | undefined): boolean | undefined {
  return cycleFlag(value);
}
