import type { CredentialStore } from "@ai-ide/storage";
import { MemoryCredentialStore } from "@ai-ide/storage";

export async function createKeytarCredentialStore(): Promise<CredentialStore> {
  try {
    const keytar = await import("keytar");
    return {
      async get(service, account) {
        return keytar.default.getPassword(service, account);
      },
      async set(service, account, password) {
        await keytar.default.setPassword(service, account, password);
      },
      async delete(service, account) {
        return keytar.default.deletePassword(service, account);
      },
      async isAvailable() {
        return true;
      },
    };
  } catch {
    return new MemoryCredentialStore();
  }
}
