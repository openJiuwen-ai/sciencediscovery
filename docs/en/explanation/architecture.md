# Runtime Architecture

## 1. Product position

ScienceDiscovery is a local, single-user scientific agent for Linux. A browser connects to the Node control API, a Python agent-loop gateway drives model conversations, and workspace tools, sandbox execution, data connectors, PDF extraction, permissions, provenance, and review return to the Node control plane.

It is not a multi-tenant cloud service. The API binds to loopback by default. Authentication is one static bearer token and there is no TLS; explicitly exposing another interface is appropriate only on a trusted, protected network.

## 2. Runtime architecture (logical view)

### 2.1 How many resident processes?

`./scripts/start-stack.sh --mode local` keeps three product processes resident; `run-local.sh` is a compatibility wrapper:

| # | Process | Startup | Default listener | Role |
|---|---|---|---|---|
| 1 | Gateway | `data/envs/gateway/bin/python -m science_agent_gateway.server` | `127.0.0.1:4312` | Receives `POST /run`, runs the agent loop, streams NDJSON |
| 2 | Runner | `node services/runner/dist/server.js` | `127.0.0.1:4311` | Runs Python/R/shell inside Bubblewrap; manages allowlisted Host NPU jobs when enabled |
| 3 | API | `node services/api/dist/server.js` | `127.0.0.1:4310` | Browser REST, SSE, static UI, and tool callback |

```text
Browser → API :4310 → Gateway :4312 → external model
                    ↘ Runner :4311 → bwrap/Python/R in Session workspace
Gateway ── /internal/tool-exec callback ──→ API
```

The browser is a client, not a repository service. All three HTTP services are loopback-only by default. During a chat, the browser talks only to API `4310`; API calls gateway/runner and receives gateway tool callbacks locally.

### 2.2 Which modules are not resident processes?

| Name | Resident? | Actual form |
|---|---|---|
| `services/paper` | no | API launches `paper_worker.py` per PDF and it exits afterward |
| deer-flow | no | Python library/submodule installed in the gateway environment; no separate port |
| `apps/web` | no in production | Static assets served by API; optional Vite `:5173` in development |
| `services/memory-graph` | disabled by default | Experimental Python sidecar on loopback `:17674`; requires explicit enablement and external storage |
| persistent kernels/Bubblewrap jobs | on demand | Runner children reclaimed after idle timeout |
| Host NPU Broker jobs | on demand | Started by Runner only when `SCIENCE_AGENT_NPU_BROKER=1`; allowlisted host workloads, not a separate daemon or arbitrary command surface |
| models and scientific databases | remote | Outbound HTTPS, not local processes |

The default remains three resident processes. Enabling Science Memory adds one; Host NPU Broker jobs are only Runner-spawned child processes.

### 2.3 Does deer-flow receive HTTP in a separate process?

No. `third_party/deer-flow` is upstream source, and ScienceDiscovery starts neither its official server, frontend, nor runtime. Gateway installs `deerflow-harness`; all `deerflow.*` integration sits behind its private `_engine/` adapter. ScienceDiscovery's own `science_agent_gateway.server` receives `GET /health` and `POST /run` on `4312`. Each request supplies prompt, tools, model, and history to LangChain `create_agent`.

### 2.4 One user-message sequence

1. Browser submits through API `4310` using REST/SSE.
2. API assembles `GatewayAgent`, the Session tool table, prompt, and model credentials.
3. API posts messages, tools, model, and callback URL to gateway `4312`.
4. Gateway runs `create_agent` and the external model; tool calls post to API `/internal/tool-exec`.
5. API executes the real tool, possibly calling runner `4311`, an outbound connector, or workspace storage.
6. Gateway consumes tool results and loops until it emits `end` with `final_messages`.
7. API converts events to frontend `AgentEvent`, streams them, and persists history.

Gateway is stateless; API supplies full `messages` on every turn.

### 2.5 Responsibility split

| Layer | Resident | Owns | Does not own |
|---|---|---|---|
| Web | static/optional dev server | UI, streaming, permission cards, settings | authoritative business state |
| API | yes, `4310` | Session state, real tools, MCP governance, permission/provenance/review, storage | model agent loop |
| Gateway | yes, `4312` | model loop, MCP queries, provider retry | sandbox and governance persistence |
| Runner | yes, `4311` | Bubblewrap code execution; allowlisted Host NPU Broker jobs when enabled | business semantics or arbitrary host shell |
| Paper | per invocation | bounded PDF extraction | network retrieval |
| deer-flow | library | model-adapter integration | separate HTTP service |
