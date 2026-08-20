# services/gateway — agent orchestration sidecar (Rung C)

A thin Python service that runs the agent loop for ScienceDiscovery. The Node
control API consumes only product-owned HTTP contracts; bundled engine
dependencies are isolated behind the private `_engine/` adapter.

Each `POST /run` request composes an agent with
`langchain.agents.create_agent(...)`; every product-level parameter comes from
the request, i.e. from the Node control API:

- `system_prompt` — the workspace prompt Node builds per session
- `tools` — proxy tools generated from the session's live tool set
  (name / description / JSON schema pass straight through)
- `model` — the session's model profile (base_url / api_key / model)
- message state — the full turn history in OpenAI format; the gateway is
  stateless and returns `final_messages` for Node to replay next turn

The private `_engine/` adapter owns model, MCP, deferred-tool, skill-search and
Web-provider seams. No other Gateway module may directly import the bundled
engine package or name one of its dynamic provider paths.

Every tool the loop calls round-trips back into the Node control API
(`services/api`) over HTTP, so the bubblewrap runner, permission cards,
provenance, and review governance stay exactly where they are. The Node API is
this service's only client.

```
apps/web ──SSE──▶ services/api (Node)  ──/run NDJSON──▶ services/gateway (this)
                     ▲                                      │ agent loop (create_agent)
                     └────── /internal/tool-exec ◀──────────┘ (proxy tools call back)
```

## Layout

- `src/science_agent_gateway/_engine/` — the only adapter allowed to import
  bundled engine packages or resolve their dynamic provider paths.
- `src/science_agent_gateway/server.py` — FastAPI `POST /run`: assembles the
  agent per request, drives it on a worker thread, streams NDJSON events
  (text deltas, reasoning deltas, tool calls/results, terminal `end` with
  `final_messages` and usage).
- `src/science_agent_gateway/tools.py` — builds one forwarding
  `StructuredTool` per tool spec in the request, bound to that run's callback.
- `src/science_agent_gateway/callback.py` — the blocking HTTP call back into
  Node's tool-exec endpoint.
- `src/science_agent_gateway/mcp_api.py` — authenticated Node-only MCP catalog,
  reload, bounded invoke, deadline, and retry endpoints.
- `src/science_agent_gateway/uniprot_mcp.py` and `public_biomed_mcp.py` —
  provider-facing stdio MCP servers. They return records and artifact
  candidates; Node remains authoritative for governance and downloads.

Smoke fixtures and scripts live under the repository `test/` tree (not here):
`test/gateway/` (mock model, stub callback, gateway smokes) and `test/api/`
(Node adapter smokes).

## Setup and run

The repository run script provisions and starts this service automatically:
the environment lives with all other
runtime state at `<data dir>/envs/gateway` (Python 3.12 via `.python-version`;
uv defaults to a newer Python that lacks some transitive wheels).

For standalone development (also used by the smoke tests below):

```bash
git submodule update --init --recursive third_party/deer-flow
cd services/gateway
uv sync                                            # creates ./.venv
.venv/bin/python -m science_agent_gateway.server   # port 4312 by default
```

This is the only agent loop: the Node API sends every run here
(`SCIENCE_AGENT_GATEWAY_URL`, default `:4312`). The model credential comes
from the session's model profile on the Node side — the gateway itself needs
no model configuration.

## Smoke tests

Run from the repository root:

```bash
./test/gateway/run_m0_smoke.sh   # gateway with mock model: assembly + callback + streaming
./test/gateway/run_real_smoke.sh # gateway against the live model in the repo root .env
./test/api/run_m1_smoke.sh       # Node adapter (hermetic): payload + translation + multi-turn
./test/api/run_real_smoke.sh     # full path: adapter -> gateway -> live model -> real tool
```
