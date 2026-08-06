import { randomUUID } from "node:crypto";
import {
  ProviderRegistrySchema,
  addUsage,
  buildProviderHud,
  emptyProviderRegistry,
  emptyProviderUsage,
  migrateLegacyProviderConfig,
  providerKeychainAccount,
  type ProviderHud,
  type ProviderRegistry,
  type ProviderUsage,
  type SavedProvider,
} from "@ai-ide/shared";
import type { CredentialStore } from "@ai-ide/storage";
import { CREDENTIAL_SERVICE } from "@ai-ide/storage";
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
    const modern = await this.credentials.get(
      CREDENTIAL_SERVICE,
      providerKeychainAccount(providerId),
    );
    if (modern) return modern;
    // Fallback for migrated legacy-default.
    if (providerId === "legacy-default") {
      return (await this.credentials.get(CREDENTIAL_SERVICE, LEGACY_KEY_ACCOUNT)) ?? "";
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
    paid: boolean;
    pricing?: SavedProvider["pricing"];
    apiKey?: string;
    makeActive?: boolean;
  }): SavedProvider {
    const registry = this.loadRegistry();
    const now = new Date().toISOString();
    const id = input.id?.trim() || randomUUID();
    const existingIdx = registry.providers.findIndex((p) => p.id === id);
    const prior =
      existingIdx >= 0 ? registry.providers[existingIdx] : undefined;
    const mergedPricing = input.pricing
      ? {
          ...(prior?.pricing ?? {}),
          ...input.pricing,
        }
      : prior?.pricing;
    const next: SavedProvider = {
      id,
      name: input.name.trim() || "Provider",
      baseUrl: input.baseUrl.trim(),
      defaultModel: input.defaultModel.trim(),
      paid: Boolean(input.paid),
      ...(mergedPricing && Object.keys(mergedPricing).length
        ? { pricing: mergedPricing }
        : {}),
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
    const legacy = await this.credentials.get(
      CREDENTIAL_SERVICE,
      LEGACY_KEY_ACCOUNT,
    );
    if (!legacy) return;
    const existing = await this.credentials.get(
      CREDENTIAL_SERVICE,
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
