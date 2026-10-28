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

## Specs

| File | Journey |
|---|---|
| `boot.spec.ts` | credential gate, offline screen, rejected token, empty workspace, resume |
| `setup.spec.ts` | first run with no model: test, then continue |
| `conversation.spec.ts` | compose, Enter vs Shift+Enter, SSE answer, persisted transcript |
| `sessions.spec.ts` | rename and delete, both proved across a reload |
| `settings.spec.ts` | default model and interface language surviving a reload |
| `workspace.spec.ts` | file picker upload, and the health-reported size ceiling |
