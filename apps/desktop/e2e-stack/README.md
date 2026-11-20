# Desktop MCP stack journey

This browser journey drives the desktop UI against a running, isolated API and
Runner. It starts its own deterministic local model stub and uses the SDK STDIO
Echo fixture on the API host. API responses and MCP tool calls use the product.

The journey covers opening the add form, saving its default disabled
configuration, discovering two tools, enabling and selecting the source,
editing the description and reloading, calling Echo from chat and checking
the successful invocation and model-visible tool result, and cancelling then
confirming deletion. It verifies that deletion persists and removes the
default connector reference. Temporary project, session, model and server
records are removed in teardown.

## Running

Start an isolated product stack from the candidate checkout, with its own data
directory, ports and token. The API and this test must share the checkout so
the STDIO fixture path is available on the API host. Use the existing
`scripts/start-stack.sh --mode local --no-jiuwenswarm` entry point for the
native agent backend.

With `E2E_BASE_URL` pointing at that loopback API and `E2E_API_TOKEN` set to
its local access token, run from the repository root.

```bash
node test/sync-e2e.mjs --write
npm ci --prefix .e2e
ln -sfn ../../../.e2e/node_modules apps/desktop/e2e-stack/node_modules
.e2e/node_modules/.bin/playwright install chromium
.e2e/node_modules/.bin/playwright test \
  --config apps/desktop/e2e-stack/playwright.config.ts
```

The config reuses the desktop Vite entry on port 4176 and proxies it to
`E2E_BASE_URL`, whose fallback is the test-stack port 4410. Each step writes
a screenshot and a journey report. Reports and results go under the ignored
`.e2e/` directory.

The test requires no external model credentials. It registers and removes its
own local model profile. Missing stack credentials or unhealthy required services
fail the journey. The default desktop mock suite and this stack entry are run
locally and have not been added to the repository CI catalog.
