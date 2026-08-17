# services/gateway — web-provider sidecar

A thin Python service whose only client is the Node control API. It does **not**
run the agent loop: the loop, model transport, and MCP client are native to
`services/api` (see
[Agent backend](../../docs/en/explanation/agent-backend.md)). What remains here
is the surface that still depends on the bundled vendor engine:

- `POST /internal/web/invoke` — execute one resolved web-provider request
  (loopback only, authenticated with the gateway internal token)
- `GET /health` — liveness for the start-up scripts

The same environment also supplies the Python interpreter for the bundled stdio
MCP servers, which the Node control plane spawns as subprocesses.

```
apps/web ──SSE──▶ services/api (Node)
                     │  agent loop, model calls, MCP client — all in-process
                     └──/internal/web/invoke──▶ services/gateway (this)
                                                   │ vendor web providers
                                                   ▼
                                             upstream search / fetch
```

Node keeps ownership of permission, credentials, cache, CAS, and audit for
`web_search` / `web_fetch`; only provider execution happens here.

## Layout

- `src/science_agent_gateway/server.py` — FastAPI app: `/health` plus the web
  router.
- `src/science_agent_gateway/web_api.py` — the internal web endpoint and its
  request/response contracts.
- `src/science_agent_gateway/web_providers.py`, `web_worker.py` — built-in
  providers and the isolated-subprocess worker used when a request pins its own
  proxy.
- `src/science_agent_gateway/_engine/` — the only adapter allowed to import the
  bundled vendor package. It is down to `web.py`, which is imported lazily so a
  missing vendor install fails web provider invocation alone.
- `src/science_agent_gateway/internal_auth.py`, `bootstrap_tokens.py` — the
  loopback bearer check shared by internal routes.
- `src/science_agent_gateway/uniprot_mcp.py`, `public_biomed_mcp.py` —
  provider-facing stdio MCP servers. Node connects to them directly with the
  official MCP SDK and remains authoritative for governance and downloads.

## Setup and run

The repository run script provisions and starts this service automatically; the
environment lives with all other runtime state at `<data dir>/envs/gateway`
(Python 3.12 via `.python-version`; uv defaults to a newer Python that lacks
some transitive wheels).

For standalone development:

```bash
git submodule update --init --recursive third_party/deer-flow
cd services/gateway
uv sync                                            # creates ./.venv
.venv/bin/python -m science_agent_gateway.server   # port 4312 by default
```

The Node API reaches this service through `SCIENCE_AGENT_GATEWAY_URL`
(default `:4312`). Model credentials never come here — the agent loop runs in
Node and talks to the model endpoint itself.

## Tests

```bash
cd services/gateway && .venv/bin/python -m unittest discover -s tests
```

End-to-end agent-loop smokes live in the repository `test/api/` tree
(`run_m1_smoke.sh` for the hermetic path, `run_real_smoke.sh` for a live model).
