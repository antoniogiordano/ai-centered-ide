export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, password: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}:${account}`;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.store.get(this.key(service, account)) ?? null;
  }

  async set(service: string, account: string, password: string): Promise<void> {
    this.store.set(this.key(service, account), password);
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.store.delete(this.key(service, account));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export const CREDENTIAL_SERVICE = "ai-first-ide";
