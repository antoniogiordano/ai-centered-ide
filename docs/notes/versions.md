# Versions — Phase 1.5

Date: 2026-07-31

| Component | Version | Rationale |
| --- | --- | --- |
| Node | 22.x LTS (dev may use 20+; CI targets 22) | Active LTS; Electron 33 embeds Node 20-compatible ABI for native modules |
| Electron | 33.x | Stable channel with `WebContentsView` / `BrowserView`, Chromium security updates |
| TypeScript | 5.7.x | Strict mode, project references |
| React | 19.x | Current stable; Vite plugin support |
| Vite | 6.x | Fast renderer builds |
| Monaco | 0.52.x | On-demand editor in product (Phase 7) |
| Cypress | 14.x | Generated E2E tests (Phase 9) |
| node-pty | 1.x | PTY for tool gateway |
| keytar | 7.9.x | OS keychain bindings |
| better-sqlite3 | 11.x | Local persistence (Phase 2) |
| pnpm | 9+/10+ | Monorepo workspaces |
| Zod | 3.x | Runtime IPC/schema validation |

## Update policy

- Electron: track stable; bump within major after spike re-validation of native modules.
- Node tooling: stay on active LTS.
- React/Vite/TS: minor/patch freely; major only with a dedicated upgrade note.
- Native modules (node-pty, keytar, better-sqlite3): pin exact versions per Electron ABI; rebuild on Electron bump.
