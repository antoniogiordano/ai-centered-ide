---
name: ai-first-ide
repo:
  shape: monorepo
  packageManager: pnpm
runtimes:
  - id: node
    version: ">=22"
backend:
  language: typescript
  frameworks:
    - electron
  roots:
    - apps/desktop
    - packages
frontend:
  language: typescript
  frameworks:
    - react
  roots:
    - apps/renderer
testing:
  unit:
    lib: vitest
    command: pnpm test
quality:
  lint: pnpm lint
  typecheck: pnpm typecheck
meta:
  updatedAt: "2026-08-04T00:00:00.000Z"
  sources:
    name: user_confirmed
    repo: user_confirmed
    runtimes: user_confirmed
    backend: user_confirmed
    frontend: user_confirmed
    testing: user_confirmed
    quality: user_confirmed
---

# AI-First IDE

Desktop IDE that puts the agent loop first: planning, architecture, tools, and git inside a trusted workspace perimeter.

## Notes

- Stack facts are primarily **detected** from the monorepo (`package.json`, apps, packages).
- This file holds **product intent** plus sparse overrides when detection is ambiguous.
