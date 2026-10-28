# apps/desktop real E2E (tier L3)

The desktop counterpart of the `tier:l3` merge-gate journeys: a real API, a
real Runner and a real model, driven through the desktop browser entry instead
of a mock. The mock entry lives in [`../e2e`](../e2e/README.md) and stays the
PR-level (L2) suite.

The two entries are separate on purpose. A mocked case must never be counted
as evidence for a real one, and a real one must not need credentials to be
collected.

## What runs

| File | Tier | Journey |
|---|---|---|
| `setup.real.spec.ts` | L3 | first-run wizard against a real endpoint; needs an **empty** model catalog |
| `models.real.spec.ts` | L3 | 设置 › 模型 › 测试连接 against the real endpoint |
| `conversation.real.spec.ts` | L3 | real stream and persistence; Stop cancels the live Run |
| `permission.real.spec.ts` | L3 | real `run_shell` approval, then the same Run finishes |
| `workspace.real.spec.ts` | L3 | real upload, file list and preview |
| `runner.real.spec.ts` | L3 | real Runner catalog: local allowlist; a connected remote Runner's resources |

Every test carries `@real @category:e2e @os:linux @arch:amd64 @model:real
@tier:l3`, which is the tag set the shared catalog uses for the first real tier.

A journey needs a real model. `E2E_MODEL_ID` reuses one already on the stack
and never deletes it; without it, the suite registers an owned profile from
`E2E_LLM_BASE_URL`/`E2E_LLM_MODEL`/`E2E_LLM_TOKEN` and removes it afterwards.
Reuse is the right mode against a workstation instance whose key is stored
server-side: the probe and the conversation still reach the real endpoint.

## Running it

From the repository root:

```bash
export E2E_API_TOKEN=...           # the token the stack printed on first start
export E2E_BASE_URL=http://127.0.0.1:4410
export E2E_LLM_BASE_URL=https://.../v1
export E2E_LLM_MODEL=...
export E2E_LLM_TOKEN=...

# Or, when the stack already holds a profile whose key cannot be exported:
export E2E_MODEL_ID=...            # id from GET /api/models

PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" \
  apps/desktop/e2e-real/node_modules/.bin/playwright test \
  --config apps/desktop/e2e-real/playwright.config.ts
```

`apps/desktop/e2e-real/node_modules` is a local symlink to `.e2e/node_modules`;
neither it nor `test-results/` is committed.

The config starts the desktop Vite server on **4176** (not the mock suite's
4175) and proxies `/api` and `/health` to `E2E_BASE_URL`. It never falls back to
the product's own 4310 default, so a run cannot write into a person's instance.

## Provisioning the remote-resource case

`runner.real.spec.ts`'s second case needs a connected remote Runner. A Runner
with its **own** `SCIENCE_AGENT_DATA_DIR` is enough: it is a real Runner process
over loopback, not an SSH host, and it never shares the stack's workspaces.

Start it from the same checkout/build as the API under test:

```bash
TOKEN=$(openssl rand -hex 24)
DATA=$(mktemp -d)
SCIENCE_AGENT_RUNNER_TOKEN="$TOKEN" \
SCIENCE_AGENT_RUNNER_PORT=4411 \
SCIENCE_AGENT_DATA_DIR="$DATA" \
SCIENCE_AGENT_NPU_BROKER=0 SCIENTIFIC_ENVS=0 \
  node services/runner/dist/server.js &
```

Register it with the stack, then ask the API to connect it:

```bash
curl -sS -X POST "$E2E_BASE_URL/api/runners" \
  -H "authorization: Bearer $E2E_API_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"alias\":\"desktop-e2e\",\"connectionKind\":\"direct\",
       \"endpoint\":{\"host\":\"127.0.0.1\",\"port\":4411,\"protocol\":\"http\"},
       \"token\":\"$TOKEN\"}"

curl -sS -X POST "$E2E_BASE_URL/api/runners/<id>/connect" \
  -H "authorization: Bearer $E2E_API_TOKEN"
```

`connect` answers `ready` and the catalog then carries the Runner's
`runnerStatus.resources` — the readings the case asserts. Remove it afterwards:

```bash
curl -sS -X DELETE "$E2E_BASE_URL/api/remote-hosts/<id>" \
  -H "authorization: Bearer $E2E_API_TOKEN"
kill %1
rm -rf "$DATA"
```

## Skips

A missing credential or an absent stack skips with a named reason rather than
failing; a wrong credential (HTTP 401/403 on `/health`) fails, because that is a
configuration error rather than a workstation without a stack.

Two cases need a state the fixture cannot create:

- `setup.real.spec.ts` runs only when `/api/models` is empty. Point it at a
  throwaway stack.
- the remote-resource case in `runner.real.spec.ts` runs only when the API
  reports a ready remote Runner with `runnerStatus.resources`.
- `models.real.spec.ts` skips when the reused provider spends the probe's
  synthetic output budget on reasoning and returns `finish_reason: length`.
  The row then says support is inconclusive; the endpoint answered, but this
  case cannot prove availability from that verdict.

## What is still not covered

- Artifact generation and version switching against a real model. The existing
  real API suite covers backend artifact delivery; here the workspace case stops
  at real upload → list → preview.
- The suite is not registered in the shared `.e2e` catalog yet. Doing that
  means adding a Playwright project plus a desktop webServer to
  `test/playwright.config.ts`, not a second case list.

## Data cleanup

Each test removes the Project, Session and model profile it created in
`finally`, through a fresh request context so a torn-down page cannot leave
records behind. The one exception is `setup.real.spec.ts`, which by definition
writes the first model of a throwaway stack.
