# apps/desktop E2E

A browser entry for the desktop front end, separate from the repository-wide
`.e2e` suite. The shared suite drives `apps/web` against a real stack and a
fixture workspace; the desktop journeys here start from the states that suite
cannot provide — no token, no project, no model — so each spec owns its
workspace instead.

This is the **L2** entry: every `/api/**` response is mocked, so it runs on a
PR without credentials. The real-model counterpart lives in
[`../e2e-real`](../e2e-real/README.md) and is tagged `tier:l3`; the two must not
be counted as each other's evidence.

## What runs

`playwright.config.ts` starts the desktop Vite app on port 4175. `fixtures.ts`
answers every `/api/**` request from memory, so no Python service is needed and
two specs cannot see each other's writes. The mock is stateful for the writes
the specs exercise: rename, delete, create, settings, provider/model setup and
upload. An endpoint the mock does not know answers `404 not mocked` rather than
an empty success, so a new call cannot silently pass.

## Running it

From the repository root:

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.e2e/browsers" \
  apps/desktop/e2e/node_modules/.bin/playwright test \
  --config apps/desktop/e2e/playwright.config.ts
```

`apps/desktop/e2e/node_modules` is a local symlink to `.e2e/node_modules`,
because `@playwright/test` is installed only for the shared suite. The browsers
are the shared `.e2e/browsers` set. Neither is committed.

Run one file by appending its name, for example `boot.spec.ts`.

## This suite is a local gate, not a CI one

No workflow runs `apps/desktop/e2e`: neither the config nor its port (4175)
appears under `.github` or `.ci`, and `pnpm test` only runs
`apps/desktop/tests/*.test.ts{,x}`. A spec added here is evidence when someone
runs it by hand, and nothing will notice a regression in it. Wire it into a
layer (pinned to the same Chromium as `.e2e`) or say plainly, in the PR that
adds a spec, that the evidence is local — do not describe it as a CI gate.

## Specs

| File | Journey |
|---|---|
| `boot.spec.ts` | credential gate, offline screen, rejected token, empty workspace, resume |
| `setup.spec.ts` | first run with no model: test, then continue |
| `failure-cards.spec.ts` | timeout cards, keyboard diagnostics, narrow layout, persisted replay, repeated failures, recovery and language switch |
| `conversation.spec.ts` | compose, Enter vs Shift+Enter, SSE answer, persisted transcript |
| `sessions.spec.ts` | rename and delete, both proved across a reload |
| `settings.spec.ts` | default model and interface language surviving a reload |
| `workspace.spec.ts` | file picker upload, and the health-reported size ceiling |

`failure-cards.spec.ts` uses the same per-page API isolation and shares only the
step reporter with `test/helpers/journey-report.ts`. It requires no API server,
model stub or global timeout changes. The main journey’s five steps check Desktop rendering of
mocked SSE failures and replay; they do not verify real backend timeout
classification or persistence. Run it with the Desktop config above, appending
`failure-cards.spec.ts`. It is intentionally outside the Web E2E catalogue.

Three additional cases cover standalone tool, kernel and untyped timeout notices
beside a later completed answer. Each reloads in Chinese and English, checks the
operation-specific or neutral title, and opens the unchanged raw diagnostic.
