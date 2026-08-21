# AI-Centered IDE

Local-first desktop IDE where the AI is the primary operator of code. Humans direct goals, approve diffs, verify in the browser, and record Cypress tests.

See [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) for vision and phase index.

## Requirements

- Node 20+ (22 LTS recommended)
- pnpm 9+
- macOS / Windows / Linux (native modules: better-sqlite3, keytar; PTY via shell runner)

## Setup

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm lint
pnpm typecheck
```

## Develop

```bash
pnpm --filter @ai-ide/desktop dev
```

Runs Electron main + Vite renderer. Onboarding configures a Base URL and a protocol (OpenAI-compatible, Anthropic Messages or DeepSeek); without a live endpoint the agent uses the mock provider.

## Demo fixture

```bash
cd fixtures/demo-project
cp .env.example .env
pnpm install && pnpm seed
pnpm dev:api   # :3001
pnpm dev:web   # :5173
```

## Package layout

| Path | Role |
| --- | --- |
| `apps/desktop` | Electron main, preload, IPC |
| `apps/renderer` | React cockpit |
| `packages/shared` | Domain + Zod IPC contracts |
| `packages/storage` | SQLite + config + credentials interface |
| `packages/provider` | Vercel AI SDK transport (OpenAI-compatible / Anthropic / DeepSeek) + mock |
| `packages/workspace` | Perimeter, FS, Git, checkpoints |
| `packages/tools` | Tool gateway, policy, PTY runner |
| `packages/agent` | Turn loop / FSM |
| `packages/environment` | Manifest, env (no value reads), redaction |
| `packages/qa` | Recorder → Cypress generator |
| `spikes/*` | Phase 1 throwaway discovery |
| `fixtures/demo-project` | Acceptance demo |

## Security defaults

- Renderer: `contextIsolation`, sandbox, no `nodeIntegration`
- Workspace write perimeter with realpath checks
- No automatic commits; no agent push
- Secrets in OS keychain only; env values never enter model context
- Command denylist non-empty; destructive actions always confirm
