# Keychain spike results

Date: 2026-07-31  
OS: macOS Keychain via `keytar@7.9`.

## Checks

| Operation | Result |
| --- | --- |
| setPassword | OK |
| getPassword | OK |
| update (set again) | OK |
| deletePassword | OK |
| Unavailable/locked | Catch error → refuse; **no plaintext disk fallback** |

## Windows/Linux strategy

Re-run spike on CI (`windows-latest` Credential Manager, `ubuntu-latest` libsecret). If libsecret missing, fail closed with user-facing message (Phase 2).

## Product takeaway

`packages/storage` / desktop keychain service wraps keytar; credentials never in SQLite or config files.
