# Contributing to ScienceDiscovery

Thanks for your interest in contributing. This document covers the development setup, the test commands, and the end-to-end environment. For what the project is and how to run it, start with the [README](README.md).

## Prerequisites

Everything listed under [README → Quick start → Requirements](README.md#requirements) (Linux x86_64, Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, bubblewrap 0.6+ (0.8+ recommended), git with submodule support).

Run the stack once before running the full check suite — the API agent-path tests spawn the gateway and need its Python environment:

```bash
./scripts/start-stack.sh --mode local   # provisions data/envs/gateway and data/envs/paper
```

Alternatively, provide a standalone `services/gateway/.venv`.

## Development commands

```bash
pnpm check        # typecheck, paper tests, build, and package unit tests
pnpm test         # build + recursive package unit tests
pnpm smoke        # build + @science-agent/api unit tests only
pnpm paper:setup  # locked PDF parser venv (project-local; app runtime uses data/envs/paper)
pnpm paper:test   # PDF extraction tests
pnpm dev          # API watch (after build; does not start runner/gateway by itself)
pnpm --filter @science-agent/web dev   # UI hot reload on :5173 (proxies API :4310)
```

## Agent-loop smoke tests

Targeted smokes, not wired into `pnpm smoke`; run from the repository root:

```bash
./test/gateway/run_m0_smoke.sh   # gateway with mock model
./test/gateway/run_real_smoke.sh # gateway against the live model in repo-root .env
./test/api/run_m1_smoke.sh       # Node adapter (hermetic)
./test/api/run_real_smoke.sh     # adapter → gateway → live model → real tool
```

## Browser e2e (Playwright)

Requires a running stack on `:4310`. Specs live in `test/`; the local environment is **`.e2e/`** (fully gitignored: deps, reports, screenshots). Committed bootstrap files under `test/` recreate it:

```bash
# first time (or after cloning)
mkdir -p .e2e
cp test/e2e.package.json .e2e/package.json
cp test/e2e.package-lock.json .e2e/package-lock.json
cp test/playwright.config.ts .e2e/playwright.config.ts
cd .e2e && npm install && npx playwright install chromium   # also links test/node_modules → .e2e/node_modules
cd .e2e && npm test
```

Integration/e2e tests under `test/` are **not** part of `pnpm check`.

## Architecture and docs

Module boundaries, the agent backend, and connector internals are documented under [docs/](docs/) (Chinese). Start with [docs/README.md](docs/README.md).
