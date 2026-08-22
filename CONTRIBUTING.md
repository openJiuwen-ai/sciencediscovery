# Contributing to ScienceDiscovery

Thanks for your interest in contributing. This document covers the development setup, the test commands, and the end-to-end environment. For what the project is and how to run it, start with the [README](README.md).

## Prerequisites

Everything listed under [README → Quick start → Requirements](README.md#requirements) (Linux x86_64, Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, bubblewrap 0.6+ (0.8+ recommended), git).

Run the stack once before running the full check suite — the API agent-path tests spawn the gateway and need its Python environment:

```bash
./scripts/start-stack.sh --mode local   # provisions data/envs/gateway and data/envs/paper
```

Alternatively, provide a standalone `services/gateway/.venv`.

## Development commands

```bash
pnpm check        # typecheck, paper tests, build, and package unit tests
pnpm test         # build + recursive package unit tests
pnpm smoke        # build + @sciencediscovery/api unit tests only
pnpm paper:setup  # locked PDF parser venv (project-local; app runtime uses data/envs/paper)
pnpm paper:test   # PDF extraction tests
pnpm dev          # API watch (after build; does not start runner/gateway by itself)
pnpm --filter @sciencediscovery/web dev   # UI hot reload on :5173 (proxies API :4310)
```

## Agent-loop smoke tests

Targeted smokes, not wired into `pnpm smoke`; run from the repository root:

```bash
./test/api/run_m1_smoke.sh       # Node adapter (hermetic)
./test/api/run_real_smoke.sh     # adapter → gateway → live model → real tool
```

## Browser e2e (Playwright)

Requires an isolated running stack on `:4310` (or `E2E_BASE_URL`) and its
generated access token exported as `E2E_API_TOKEN`. Specs live in `test/`; the
local environment is **`.e2e/`** (fully gitignored: deps, reports,
screenshots). Committed bootstrap files under `test/` recreate it:

```bash
# first time (or after cloning)
node test/sync-e2e.mjs --write
cd .e2e && npm install # also links test/node_modules → .e2e/node_modules
./node_modules/.bin/playwright install chromium
npm test
```

Every npm test/list command first checks that `.e2e` exactly matches the
committed manifest, lockfile, and config. A stale copy fails with `BLOCKED`
before Playwright discovery; run `node test/sync-e2e.mjs --write` from the
repository root and repeat `npm install` in `.e2e`.

Specs are split into tagged Playwright projects. `mocked` contains only
explicitly tagged journeys driven by local stub models, needs no external
credentials, and is what `npm test` runs by default. (`E2E_API_TOKEN` still
authenticates the local stack.) `real` is a small set of natural-language user
smokes that call live LLMs or external services; the project only exists when
`E2E_REAL=1` is set. Untagged legacy specs are quarantined in a separate
explicit opt-in project:

```bash
cd .e2e
npm run test:mocked      # stable stubbed group
npm run test:real        # live group; explicit opt-in with declared credentials
npm run test:real:list   # safe discovery of the live group; does not run it
npm run test:mixed       # mocked + live groups; explicit opt-in
npm run test:list        # default mocked-only discovery check
npm run test:legacy:list # inventory quarantined, unaudited specs
npm run check:meta       # validates the per-test E2E-META comment blocks
```

Every migrated test carries an `E2E-META` comment (purpose, steps, environment,
mocked/real type, each external capability, credentials, cost/side effects)
checked by `test/check-e2e-meta.mjs`. New E2E files are organized by complete
user journey, not shell/Python/environment/internal modules, and reuse
`test/helpers/journeys.ts` for common user actions.

Journey specs (`test/journey-*.spec.ts`) are additionally written as numbered
**user steps** through the `journey` fixture:

```ts
await journey.step("打开工作台", "首页显示品牌与上手入口。", async () => { /* act + assert */ });
```

Each run writes `report.md` and a self-contained `report.html` — scenario goal,
preconditions, a step table, a per-step screenshot, and that step's key logs —
into the gitignored `.e2e/journey-reports/<spec>/<test>/`, for passing, failing,
and blocked runs alike. `check-e2e-meta.mjs` enforces the fixture, the scenario
declaration, and the absence of ad-hoc `page.screenshot()` in journey specs.

See [.agents/skills/e2e-testing/SKILL.md](.agents/skills/e2e-testing/SKILL.md)
for the full conventions, including the copyable journey skeleton, the automatic
HTTP/WebSocket guard, isolation, failure attribution, and
discovered/executed/skipped reporting.

Integration/e2e tests under `test/` are **not** part of `pnpm check`.

## Architecture and docs

Module boundaries, the agent backend, and connector internals are documented under [docs/](docs/) (Chinese). Start with [docs/README.md](docs/README.md).
