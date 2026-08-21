import { randomUUID } from "node:crypto";
import {
  ProviderRegistrySchema,
  addUsage,
  buildProviderHud,
  emptyProviderRegistry,
  emptyProviderUsage,
  inferProviderKind,
  mergeProviderModels,
  migrateLegacyProviderConfig,
  providerKeychainAccount,
  type ProviderHud,
  type ProviderKind,
  type ProviderModelCatalogEntry,
  type ProviderRegistry,
  type ProviderUsage,
  type SavedProvider,
} from "@ai-ide/shared";
import type { CredentialStore } from "@ai-ide/storage";
import { CREDENTIAL_SERVICE, getAppCredential } from "@ai-ide/storage";
import type { ProjectStorage } from "@ai-ide/storage";

const REGISTRY_KEY = "providerRegistry";
const LEGACY_CONFIG_KEY = "providerConfig";
const LEGACY_KEY_ACCOUNT = "default";

export class ProviderRegistryStore {
  private sessionUsage = emptyProviderUsage();

  constructor(
    private readonly storage: ProjectStorage,
    private readonly credentials: CredentialStore | null,
  ) {}

  resetSessionUsage(): void {
    this.sessionUsage = emptyProviderUsage();
  }

  getSessionUsage(): ProviderUsage {
    return this.sessionUsage;
  }

  getActiveProvider(): SavedProvider | null {
    const registry = this.loadRegistry();
    if (!registry.activeId) return null;
    return registry.providers.find((p) => p.id === registry.activeId) ?? null;
  }

  loadRegistry(): ProviderRegistry {
    const existing = this.storage.getPreference<ProviderRegistry>(REGISTRY_KEY);
    const legacy = this.storage.getPreference<{
      baseUrl?: string;
      defaultModel?: string;
    }>(LEGACY_CONFIG_KEY);
    const migrated = migrateLegacyProviderConfig(legacy, existing ?? null);
    if (
      !existing?.providers?.length &&
      migrated.providers.length > 0
    ) {
      this.saveRegistry(migrated);
      // Best-effort: copy legacy keychain key onto the migrated provider.
      void this.migrateLegacyKey(migrated.providers[0]!.id);
    }
    return migrated;
  }

  saveRegistry(registry: ProviderRegistry): void {
    this.storage.setPreference(
      REGISTRY_KEY,
      ProviderRegistrySchema.parse(registry),
    );
  }

  getActive(): SavedProvider | null {
    const registry = this.loadRegistry();
    if (!registry.activeId) return null;
    return registry.providers.find((p) => p.id === registry.activeId) ?? null;
  }

  buildHud(): ProviderHud {
    return buildProviderHud({
      registry: this.loadRegistry(),
      sessionUsage: this.sessionUsage,
    });
  }

  async getApiKey(providerId: string): Promise<string> {
    if (!this.credentials) return "";
    const modern = await getAppCredential(
      this.credentials,
      providerKeychainAccount(providerId),
    );
    if (modern) return modern;
    // Fallback for migrated legacy-default.
    if (providerId === "legacy-default") {
      return (await getAppCredential(this.credentials, LEGACY_KEY_ACCOUNT)) ?? "";
    }
    return "";
  }

  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!this.credentials || !apiKey.trim()) return;
    await this.credentials.set(
      CREDENTIAL_SERVICE,
      providerKeychainAccount(providerId),
      apiKey.trim(),
    );
  }

  upsertProvider(input: {
    id?: string;
    name: string;
    baseUrl: string;
    defaultModel: string;
    kind?: ProviderKind;
    paid: boolean;
    pricing?: SavedProvider["pricing"];
    models?: ProviderModelCatalogEntry[];
    thinking?: boolean;
    reasoningEffort?: SavedProvider["reasoningEffort"];
    contextWindowTokens?: number | null;
    apiKey?: string;
    makeActive?: boolean;
  }): SavedProvider {
    const registry = this.loadRegistry();
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const existingIdx = registry.providers.findIndex((p) => p.id === id);
    const prior =
      existingIdx >= 0 ? registry.providers[existingIdx] : undefined;
    // Replace pricing wholesale when provided (nested schedule/byModel).
    const nextPricing =
      input.pricing !== undefined ? input.pricing : prior?.pricing;
    const nextWindow =
      input.contextWindowTokens !== undefined
        ? input.contextWindowTokens
        : prior?.contextWindowTokens;
    const nextModels =
      input.models !== undefined
        ? mergeProviderModels(prior?.models, input.models)
        : prior?.models;
    const baseUrl = input.baseUrl.trim();
    const next: SavedProvider = {
      id,
      name: input.name.trim() || "Provider",
      baseUrl,
      defaultModel: input.defaultModel.trim(),
      kind: input.kind ?? prior?.kind ?? inferProviderKind(baseUrl),
      paid: Boolean(input.paid),
      thinking: input.thinking ?? prior?.thinking ?? false,
      reasoningEffort:
        input.reasoningEffort ?? prior?.reasoningEffort ?? "high",
      ...(typeof nextWindow === "number" && nextWindow > 0
        ? { contextWindowTokens: nextWindow }
        : {}),
      ...(nextPricing && Object.keys(nextPricing).length
        ? { pricing: nextPricing }
        : {}),
      ...(nextModels?.length ? { models: nextModels } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    if (existingIdx >= 0) {
      registry.providers[existingIdx] = next;
    } else {
      registry.providers.push(next);
    }
    if (input.makeActive !== false) {
      registry.activeId = id;
    }
    this.saveRegistry(registry);
    if (input.apiKey?.trim()) {
      void this.setApiKey(id, input.apiKey);
    }
    return next;
  }

  setDefaultModel(
    providerId: string,
    model: string,
  ): SavedProvider | null {
    const registry = this.loadRegistry();
    const idx = registry.providers.findIndex((p) => p.id === providerId);
    if (idx < 0) return null;
    const prior = registry.providers[idx]!;
    const nextModel = model.trim();
    if (!nextModel) return null;
    const entry = prior.models?.find((item) => item.id === nextModel);
    const next: SavedProvider = {
      ...prior,
      defaultModel: nextModel,
      updatedAt: new Date().toISOString(),
      ...(entry?.contextWindowTokens
        ? { contextWindowTokens: entry.contextWindowTokens }
        : {}),
    };
    registry.providers[idx] = next;
    this.saveRegistry(registry);
    return next;
  }

  patchModelCapabilities(
    providerId: string,
    modelId: string,
    patch: Partial<Omit<ProviderModelCatalogEntry, "id">>,
  ): SavedProvider | null {
    const registry = this.loadRegistry();
    const idx = registry.providers.findIndex((p) => p.id === providerId);
    if (idx < 0) return null;
    const prior = registry.providers[idx]!;
    const models = mergeProviderModels(prior.models, [
      { id: modelId, ...patch },
    ]);
    const next: SavedProvider = {
      ...prior,
      models,
      updatedAt: new Date().toISOString(),
    };
    registry.providers[idx] = next;
    this.saveRegistry(registry);
    return next;
  }

  setActive(providerId: string): boolean {
    const registry = this.loadRegistry();
    if (!registry.providers.some((p) => p.id === providerId)) return false;
    registry.activeId = providerId;
    this.saveRegistry(registry);
    this.resetSessionUsage();
    return true;
  }

  deleteProvider(providerId: string): boolean {
    const registry = this.loadRegistry();
    const before = registry.providers.length;
    registry.providers = registry.providers.filter((p) => p.id !== providerId);
    if (registry.providers.length === before) return false;
    if (registry.activeId === providerId) {
      registry.activeId = registry.providers[0]?.id ?? null;
      this.resetSessionUsage();
    }
    delete registry.usageByProviderId[providerId];
    this.saveRegistry(registry);
    return true;
  }

  recordUsage(delta: ProviderUsage): ProviderHud {
    this.sessionUsage = addUsage(this.sessionUsage, delta);
    const registry = this.loadRegistry();
    const activeId = registry.activeId;
    if (activeId) {
      const prev =
        registry.usageByProviderId[activeId] ?? emptyProviderUsage();
      registry.usageByProviderId[activeId] = addUsage(prev, delta);
      this.saveRegistry(registry);
    }
    return this.buildHud();
  }

  private async migrateLegacyKey(providerId: string): Promise<void> {
    if (!this.credentials) return;
    const legacy = await getAppCredential(this.credentials, LEGACY_KEY_ACCOUNT);
    if (!legacy) return;
    const existing = await getAppCredential(
      this.credentials,
      providerKeychainAccount(providerId),
    );
    if (existing) return;
    await this.credentials.set(
      CREDENTIAL_SERVICE,
      providerKeychainAccount(providerId),
      legacy,
    );
  }
}

export function createEmptyRegistryStore(
  storage: ProjectStorage,
): ProviderRegistryStore {
  return new ProviderRegistryStore(storage, null);
}

export { emptyProviderRegistry };
