# Runtime Architecture

## 1. Product position

ScienceDiscovery is a local, single-user scientific agent for Linux. A browser connects to the Node control API, and **the agent loop runs inside that same Node process**. Workspace tools, sandbox execution, data connectors, PDF extraction, permissions, provenance, and review are all owned by the Node control plane.

It is not a multi-tenant cloud service. The API binds to loopback by default. Authentication is one static bearer token and there is no TLS; explicitly exposing another interface is appropriate only on a trusted, protected network.

## 2. Runtime architecture (logical view)

### 2.1 How many resident processes?

`./scripts/start-stack.sh --mode local` keeps two product processes resident; `run-local.sh` is a compatibility wrapper:

| # | Process | Startup | Default listener | Role |
|---|---|---|---|---|
| — | ~~Gateway~~ | removed | — | With native web providers the service is gone; `services/gateway` survives only as the interpreter environment for the bundled Python MCP servers |
| 2 | Runner | `node services/runner/dist/server.js` | `127.0.0.1:4311` | Runs Python/R/shell inside Bubblewrap; manages allowlisted Host NPU jobs when enabled |
| 3 | API | `node services/api/dist/server.js` | `127.0.0.1:4310` | Browser REST, SSE, static UI, **and the agent loop, model calls, tool execution, and the in-process MCP client** |

```text
Browser → API :4310 ── agent loop in-process ──→ external model (outbound HTTPS)
                    ── web providers in-process ─→ tavily / exa / brave / bing / duckduckgo / jina
                    ↘ Runner :4311 → bwrap/Python/R in Session workspace

services/gateway is not a process: its venv only supplies the interpreter for the
bundled Python MCP servers (biomed, UniProt), spawned by the API over stdio.
```

The browser is a client, not a repository service. Both HTTP services are loopback-only by default. During a chat the browser talks only to API `4310`; the API drives the model, the web providers, and the runner itself. There is no `POST /run` hop, no `/internal/tool-exec` callback, and no `/internal/web/invoke` hop.

### 2.2 Which modules are not resident processes?

| Name | Resident? | Actual form |
|---|---|---|
| `services/paper` | no | API launches `paper_worker.py` per PDF and it exits afterward |
| deer-flow | no | Python library/submodule installed in the gateway environment; no separate port. The agent loop no longer uses it; only web-provider execution still does |
| `apps/web` | no in production | Static assets served by API; optional Vite `:5173` in development |
| `services/memory-graph` | disabled by default | Experimental Python sidecar on loopback `:17674`; requires explicit enablement and external storage |
| persistent kernels/Bubblewrap jobs | on demand | Runner children reclaimed after idle timeout |
| Host NPU Broker jobs | on demand | Started by Runner only when `SCIENCE_AGENT_NPU_BROKER=1`; allowlisted host workloads, not a separate daemon or arbitrary command surface |
| models and scientific databases | remote | Outbound HTTPS, not local processes |

The default remains three resident processes. Enabling Science Memory adds one; Host NPU Broker jobs are only Runner-spawned child processes.

### 2.3 Which process runs the agent loop?

The API process. The loop is this repository's own TypeScript under `services/api/src/native-agent/`, entered through `createNativeAgent`; it uses **no LangChain or LangGraph**. Model calls go out from the API process directly through `undici`, in either the OpenAI-compatible or the Anthropic Messages dialect. Tool calls are `await`ed in-process against the same `createWorkspaceTools` handlers, so there is no cross-process callback. MCP servers are connected in-process with the official TypeScript SDK (stdio subprocess, SSE, or streamable HTTP); the bundled Python MCP servers (biomed, UniProt) are stdio subprocesses whose interpreter comes from the gateway venv, which is the second reason that environment still exists. See [agent-backend.md](agent-backend.md) for the module-level description.

### 2.4 One user-message sequence

1. Browser submits through API `4310` using REST/SSE.
2. API builds the `AgentProfile` and workspace options; `createAgentRun` constructs a `NativeAgent` with the prompt, Session tool table, and model endpoint.
3. The loop streams a model turn over outbound HTTPS; text and reasoning deltas reach the browser over SSE as they arrive.
4. When the model returns tool calls, the API executes the real tools in-process, possibly calling runner `4311`, an outbound connector, workspace storage, or an MCP server through the in-process client.
5. Tool results append to history and the loop takes another turn, until a turn produces no tool calls.
6. The loop returns `finalMessages`; the API persists history.

`web_search` / `web_fetch` provider calls also go out directly from the API process; there is no extra process hop left.

### 2.5 Responsibility split

| Layer | Resident | Owns | Does not own |
|---|---|---|---|
| Web | static/optional dev server | UI, streaming, permission cards, settings | authoritative business state |
| API | yes, `4310` | **agent loop and model calls**, Session state, real tools, in-process MCP client and governance, permission/provenance/review, storage | process-level sandbox isolation |
| Gateway | no (environment only) | interpreter environment for the bundled Python MCP servers | no longer a service: agent loop, web providers, sandbox, and governance are all elsewhere |
| Runner | yes, `4311` | Bubblewrap code execution; allowlisted Host NPU Broker jobs when enabled | business semantics or arbitrary host shell |
| Paper | per invocation | bounded PDF extraction | network retrieval |
| deer-flow | library | web-provider implementations | agent loop, separate HTTP service |
