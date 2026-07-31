/**
 * Spike keychain — throwaway discovery (Phase 1.4)
 * CRUD against the OS keychain via keytar. Never falls back to plaintext on disk.
 */
import { platform } from "node:os";
import keytar from "keytar";

const SERVICE = "ai-first-ide-spike";
const ACCOUNT = "spike-test-account";
const VALUE = `spike-secret-${Date.now()}`;
const VALUE2 = `spike-secret-updated-${Date.now()}`;

async function main() {
  console.log(`OS=${platform()} keytar spike`);

  try {
    console.log("SET...");
    await keytar.setPassword(SERVICE, ACCOUNT, VALUE);

    console.log("GET...");
    const got = await keytar.getPassword(SERVICE, ACCOUNT);
    if (got !== VALUE) throw new Error(`Expected ${VALUE}, got ${got}`);
    console.log("GET OK (value matches, not printed)");

    console.log("UPDATE...");
    await keytar.setPassword(SERVICE, ACCOUNT, VALUE2);
    const got2 = await keytar.getPassword(SERVICE, ACCOUNT);
    if (got2 !== VALUE2) throw new Error("Update failed");
    console.log("UPDATE OK");

    console.log("DELETE...");
    const deleted = await keytar.deletePassword(SERVICE, ACCOUNT);
    if (!deleted) throw new Error("Delete returned false");
    const after = await keytar.getPassword(SERVICE, ACCOUNT);
    if (after !== null) throw new Error("Password still present after delete");
    console.log("DELETE OK");

    console.log("\nKeychain spike OK — no plaintext fallback used");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Keychain unavailable or locked:", message);
    console.error(
      "POLICY: refuse operation; never write credentials to disk in plaintext.",
    );
    process.exitCode = 1;
  }
}

main();
