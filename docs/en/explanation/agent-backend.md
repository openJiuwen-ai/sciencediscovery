# Agent Backend and Gateway Adapter Boundary

## 1. Summary

- The only agent-loop engine is this repository's Python `services/gateway`, not the complete deer-flow service stack.
- deer-flow is vendored as `third_party/deer-flow`; gateway installs its `deerflow-harness` package as an editable uv path dependency.
- `deerflow.*` imports, dynamic provider paths, and provider configuration types stay inside gateway `_engine/`; gateway main flow and Node consume product-generic interfaces.
- Agent assembly uses public `langchain.agents.create_agent`; `_engine/` converts provider middleware, state, and model patches.
- ScienceDiscovery does not use deer-flow's frontend, complete runtime/configuration center, sandbox, or upload system. Node retains tools, permission, provenance, and governance; gateway reuses DeerFlow for MCP and Web protocol calls.

## 2. One end-to-end turn

```text
Web user → Node API builds GatewayAgent and workspace tools
         → POST gateway /run
         → gateway create_agent + model stream
         → tool call POST API /internal/tool-exec
         → Node real tool/runner/connector/permission/provenance
         → result returns to gateway loop
         → gateway end(final_messages)
         → Node persists history and streams UI AgentEvent
```

Node owns messages, tools, permission epochs, and workspace files. Gateway persists no Session state; `thread_id` is currently the Session ID for tracing. Node owns provider credentials, proxy, and timeout settings and sends generic fields. `_engine/` maps provider implementation and does not read disk `config.yaml`.

## 3. Product components

### 3.1 `GatewayAgent`

It builds prompt/tools, generates and registers one callback token per run, posts history/prompt/tool specs/model/callback to gateway, translates NDJSON text/thinking/tool events, adopts `final_messages`, and unregisters the token.

Agent idle defaults to 240 seconds and full-turn timeout to unlimited. Both are configurable. Main-agent timeout pauses while waiting for subagents/external tools. A subagent defaults to `max_turns=300` and `timeout_seconds=7200`; task inputs are bounded by server validation.

The first main user input is injected as `<run_contract>` in the system prompt. A child uses delegated prompt, Brief, and handoff. Contracts do not enter `messages` and are not summarized as history. Node sends gateway's returned `final_messages` directly between AgentRuns instead of pre-summarizing again.

### 3.2 Tool callback route

`POST /internal/tool-exec` accepts per-run bearer auth and `{name,args,toolCallId}`, returning `{content,is_error}`. Tokens exist only in an in-memory map during `execute()`.

### 3.3 Gateway package

```text
science_agent_gateway/
  _engine/           # provider adapter boundary
  server.py          # FastAPI /health and /run
  model.py           # generic reasoning-model factory
  tools.py           # proxy StructuredTool construction
  callback.py        # synchronous Node callback
  mcp_api.py         # authenticated scientific MCP access
  public_biomed_mcp.py
  uniprot_mcp.py
```

## 4. Gateway interfaces

### 4.1 Node to gateway: `POST /run`

`RunRequest` contains `thread_id`, OpenAI-style `messages`, Node-built `system_prompt`, exact `tools[]` specs, frozen skill metadata without full instructions, model base URL/key/name/options, callback URL/token, and optional summarization configuration.

The `application/x-ndjson` response emits AI text/thinking/tool calls, ToolMessage results, `end` with final messages/usage, or `error` with message.

### 4.2 Gateway to Node

Gateway uses synchronous httpx from a worker thread for `/internal/tool-exec`, matching synchronous LangGraph tool scheduling.

### 4.3 Operations

Gateway health is `GET /health`; API aggregates its own health. Gateway defaults are `SCIENCE_AGENT_GATEWAY_HOST=127.0.0.1`, port `4312`; API selects it with `SCIENCE_AGENT_GATEWAY_URL` and callback URL.

### 4.4 Internal adapter and LangChain seam

`_engine.agent`, `.model`, `.mcp`, and `.web` expose generic middleware/state/model/MCP/Web abstractions. `create_agent`, `StructuredTool`, LangChain message conversion, and `agent.stream(..., stream_mode=["messages","values"])` assemble and drive the turn. Deer-flow's own sandbox, marketplace, UI/TUI, default MCP/subagent stack, upload/workspace, and filesystem skill-reading path are explicitly not integrated. Future middleware must retain Node tool-governance callbacks.

### 4.5 Other model calls

Paper-page vision in `papers.ts` directly fetches an OpenAI-compatible `chat/completions` endpoint from API. Main conversation/tool-loop model calls occur in gateway.

## 5. `/run` algorithm

Gateway parses the request/callback target, builds the reasoning model, creates one callback-backed `StructuredTool` per spec, calls `create_agent`, converts input messages, and streams in a worker thread through an asyncio queue. Values expose complete tool calls; message chunks expose text/thinking/tool results. Final state becomes OpenAI-style `final_messages`. Client disconnect sets a stop event observed at event boundaries.

## 6. How workspace tools enter the loop

Node owns implementations in `createWorkspaceTools`; gateway receives specs only. Web tools are still Node proxies: `WebBroker` performs permission, credential, cache, CAS, and audit before gateway `/internal/web/invoke` maps generic options and invokes a provider. Keys never enter model context or environment variables.

Disabling an MCP source removes its tool entirely; scientific-environment setup adds R/environment tools; permission failures return tool errors the model can explain. Categories are base workspace, Web, deferred scientific MCP, Artifact/PDF, scientific environment, skill, and orchestration tools. See [Built-in tools](../reference/builtin-tools.md).

Skills are the deliberate metadata exception: Node sends frozen `skills[]` metadata so gateway can provide native `describe_skill`; full instructions still come through Node `read_skill` from the snapshot.

### 6.1 Subagent Brief v1 contract

`brief` requires a 1–2000-character `goal`, 1–20 constraints, 1–20 output requirements, and 1–12 collaboration rules (each 1–1000). Optional JSON Schema 2020-12 is at most 20,000 serialized bytes and depth 64. Server owns `version`, starting at 1 and incrementing on PATCH.

Schema compiles on create/PATCH; invalid/unknown/oversized input is 400. Completion validates the last non-empty assistant step as one JSON object. Failure marks the subagent failed and retains validation/raw output without setting `structuredResult`.

PATCH is allowed for completed/failed, returns 409 for running/cancelled/timed-out, 404 when absent, and 400 for invalid Brief/schema.

## 7. Verification entry points

```bash
./test/gateway/run_m0_smoke.sh
./test/gateway/run_real_smoke.sh
./test/api/run_m1_smoke.sh
./test/api/run_real_smoke.sh
```

## 8. Related documentation

- [Runtime architecture](architecture.md)
- [Science connectors](science-connectors.md)
- [Subagent orchestration](subagent-orchestration.md)
- [Skill progressive disclosure](skill-progressive-disclosure.md)
- [Gateway README](../../../services/gateway/README.md)
