#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cp -n .env.example .env 2>/dev/null || true
pnpm install
pnpm seed
echo "Seed complete. Start with: pnpm dev:api & pnpm dev:web"
