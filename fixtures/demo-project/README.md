# Demo Project

Minimal full-stack app for AI-Centered IDE Phase 9–10 acceptance.

## Stack

- Frontend: React + Vite (port 5173)
- Backend: Fastify + better-sqlite3 (port 3001)
- Optional Postgres via Docker Compose (port 5432) for env/supervisor demos

## Quick start (no Docker for API)

```bash
cd fixtures/demo-project
cp .env.example .env
pnpm install
pnpm seed
pnpm --filter @demo/api dev   # terminal 1
pnpm --filter @demo/web dev   # terminal 2
```

Open http://localhost:5173 — login `demo@example.com` / `password`, list items, create item.

## Docker Compose (Postgres)

```bash
docker compose up -d
```

See [BUG.md](BUG.md) for the intentional bug (do not read if you are the agent under test).
