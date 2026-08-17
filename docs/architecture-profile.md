# AICI Architecture Profile

Contract for workspace tech-stack metadata + product intent.

## Two artifacts

| Artifact | Answers | Path / home |
|---|---|---|
| **Architecture doc** | Product intent + sparse overrides | `.aici/ARCHITECTURE.md` |
| **Detected stack** | What the repo actually uses | Derived at runtime from files |
| **Environment manifest** (Fase 8) | How we run and test it | TBD |

Do not treat `ARCHITECTURE.md` as a second `package.json`. Stack facts come from detection; the markdown file holds **intent** and **overrides** only when detection is wrong or incomplete.

## File

- Path: `.aici/ARCHITECTURE.md`
- Format: YAML frontmatter (sparse `ArchitectureProfile` patch) + markdown body (intent)
- Legacy: `.aifi/ARCHITECTURE.md` and `.aifi/architecture.json` are still read once for migration
- Validated with Zod (`ArchitectureProfilePatchSchema` in `@ai-ide/shared`)

## Effective profile

```
effective = merge(detect(repo), overrides_from_frontmatter)
```

- `read_architecture` returns `{ derived, overrides, intent, effective, drift }`
- `upsert_architecture` merges sparse overrides and/or replaces intent body
- Drift = override path disagrees with detection (shown in UI + prompt)

## Core override fields

Same shape as before, but sparse:

- `repo`, `runtimes`, `backend` / `frontend`, `testing`, `quality`, `data`, `api`
- Provenance in frontmatter `meta.sources`: `detected` | `agent_proposed` | `user_confirmed`

## Lifecycle

1. **Detect** — heuristics produce derived stack (no write required).
2. **Plan** — agent declares stack/deps in the plan; may sparse-update ARCHITECTURE.md intent/overrides. No dedicated Architecture agent chat.
3. **Build** — install packages and implement via tools after the user starts build.
4. **Confirm** — user can edit/save ARCHITECTURE.md in Settings (⌘⇧A).
5. **Consume** — system prompt includes effective profile + intent + drift.

## Tools / IPC

- Tools: `read_architecture`, `upsert_architecture`
- IPC: `workspace:architecture-get`, `workspace:architecture-detect`, `workspace:architecture-save`

## Out of scope (v1)

Auth, IaC, mobile targets, perfect multi-language detection, environment supervisor (Fase 8).
