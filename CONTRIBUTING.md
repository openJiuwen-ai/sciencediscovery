# Contributing to ScienceDiscovery

Thanks for your interest in contributing. This document covers the development setup, the test commands, and the end-to-end environment. For what the project is and how to run it, start with the [README](README.md).

## Prerequisites

Everything listed under [README → Quick start → Requirements](README.md#requirements) (Linux x86_64, Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, bubblewrap 0.6+ (0.8+ recommended), git).

Run the stack once before running the full check suite — the API agent-path tests spawn the gateway and need its Python environment:

```bash
./scripts/start-stack.sh --mode local   # provisions .sciencediscovery-data/envs/{gateway,paper}
```

Alternatively, provide a standalone `services/gateway/.venv`.

## Development commands

```bash
pnpm check        # typecheck, paper tests, build, and package unit tests
pnpm test         # build + recursive package unit tests
pnpm smoke        # build + @sciencediscovery/api unit tests only
pnpm paper:setup  # locked PDF parser venv (project-local; app runtime uses .sciencediscovery-data/envs/paper)
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

## CI layers

CI groups the commands above into three layer entry points. Reproducing a
pipeline failure locally means running the same one:

```bash
pnpm ci:ut    # pnpm check, then the memory-graph pytest suite
pnpm ci:st    # build, then the hermetic agent-loop smoke
pnpm ci:e2e   # starts its own isolated stack and runs the @mocked journeys
```

Each writes `run.log` and a machine-readable summary below `CI_RESULTS_DIR`,
and gives the run a scratch data directory below `CI_RUNTIME_DIR`. Both default
to paths that exist only inside the `.ci` toolchain image, so outside that image
point them somewhere writable:

```bash
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:st
```

Live and hardware layers (`ci:st:real`, `ci:e2e:real`, `ci:st:npu`,
`ci:e2e:legacy`) fail closed behind their `CI_ALLOW_*` variables and are never
part of a default command. See [.ci/README.md](.ci/README.md) for the toolchain
image, the per-layer Docker commands, and the tag catalog used to select cases
(`pnpm ci:tags`, `pnpm ci:list`, `pnpm ci:run`).

## License headers

Every source file starts with the Apache-2.0 header below, written in that
file's comment syntax:

```text
Copyright (C) 2026-2026 Huawei Technologies Co., Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Comment markers, matching what is already in the tree:

| Files | Marker | Reference |
| --- | --- | --- |
| `.ts`, `.tsx`, `.js`, `.mjs` | `//` on every line | [apps/web/src/session-activity.ts](apps/web/src/session-activity.ts) |
| `.py`, `.sh`, `.yml`, `.toml`, `Dockerfile` | `#` on every line | [.ci/run-e2e.sh](.ci/run-e2e.sh) |
| `.css` | `/*` block with ` * ` continuation lines | [apps/web/src/styles/conversation.css](apps/web/src/styles/conversation.css) |
| `.html` | one `<!-- -->` block | [apps/web/index.html](apps/web/index.html) |

The header is the first thing in the file, except where the format demands
something earlier — a shebang (`#!/usr/bin/env bash`) or a doctype
(`<!doctype html>`) — in which case it follows on the next line. Blank lines
inside the header stay commented (`//` or `#` with nothing after it), and one
uncommented blank line separates the header from the code.

### Exceptions

These do not carry a header:

- **Documentation and plain text** — `.md`, `.txt`, `LICENSE`, `CODEOWNERS`.
- **Formats with no comment syntax** — `.json` (including `package.json` and
  `tsconfig*.json`), `.python-version`, and similar. Do not invent a `//`
  comment to work around strict JSON.
- **Files generated in full by a script** — lockfiles such as `pnpm-lock.yaml`,
  and any artifact a generator writes end to end. Put the header in the
  generator instead, and have it emit one only when the output format supports
  comments. A file that is merely scaffolded and then edited by hand is not
  generated: it needs the header.
- **Binary assets** — images, fonts, PDFs.

## Architecture and docs

Module boundaries, the agent backend, and connector internals are documented under [docs/](docs/) (Chinese). Start with [docs/README.md](docs/README.md).
