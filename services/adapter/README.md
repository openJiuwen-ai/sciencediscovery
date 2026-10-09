# ScienceDiscovery adapter

Python front door for the JiuwenSwarm migration (issue 84). It owns the public
port, proxies every route it has not taken over to the legacy TypeScript API, and
runs agent turns on JiuwenSwarm when `SCIENCE_AGENT_EXECUTOR=jiuwenswarm`.

To run it from source, see [Local mode](../../docs/en/getting-started/deployment.md#local-mode-host-processes).
This file is for people working on the adapter.

## Direction

The legacy API keeps owning sessions, messages, run events and permission records.
Only the **agent executor** is swapped: the legacy `createAgent` seam
(`AgentRunBindings.createAgent`) is filled by `createJiuwenSwarmAgentFactory`
(`services/api/src/agent-run/jiuwenswarm-agent.ts`), which calls this adapter.

```text
browser ──▶ adapter :4310 ──proxy──▶ legacy API :4410 ──createAgent──┐
                │  ▲                                                  │ POST /agent/runs
                │  └──── tool calls (loopback bridge, per run) ◀──────┤ (NDJSON events)
                ▼
           JiuwenSwarm gateway (WebSocket)  ──▶  model, via /llm/<token>/v1 (this adapter)
                └── MCP tools ─▶ /mcp/<token>  (this adapter)
```

A run, end to end:

1. The legacy API builds the run's tools exactly as the native agent would (workspace
   tools plus plugin tools such as `update_plan` and `task`), starts a loopback bridge
   that executes them, and posts the prompt, model, system prompt and tool list to
   `POST /agent/runs`.
2. The adapter hosts that toolset as a per-run MCP server (`mcp_server.py`), registers
   it with JiuwenSwarm for this run only, and points JiuwenSwarm at a private model
   alias whose endpoint is a per-run proxy route (`llm_proxy.py`).
3. JiuwenSwarm runs the loop. Tool calls come back over MCP and are forwarded to the
   bridge, so permissions, the runner, artifacts and their events behave as before.
   Model calls go through the proxy to the real endpoint.
4. The adapter maps JiuwenSwarm's frames to run events (`events.py`) and streams them
   back as NDJSON; the legacy API turns them into the events the UI already renders.

To investigate a four-minute gateway idle timeout, set
`SCIENCE_AGENT_TRACE_GATEWAY_PROGRESS=1` on the Node API process before startup.
Its `[gateway-progress]` log records a payload-free snapshot every 30 seconds:
the session and Agent IDs, last progress type and age, and each active model
request's purpose, elapsed time, and upstream/downstream chunk counts. A run
deadline records the same snapshot even when the flag is off. An empty active
request list points toward adapter or Swarm round preparation; an active request
with no upstream chunks points toward the model transport. `[model-arguments]`
records a request ID, tool names and truncation/usage metadata when a model
returns malformed tool arguments. These logs omit prompts, responses, argument
contents and credentials.

Why a model proxy: JiuwenSwarm names MCP tools `mcp_<server>_<tool>`, offers the model
dozens of tools of its own and wraps the prompt in its persona. The proxy restores the
tool names, cuts the list to the run's toolset, substitutes the caller's system prompt
and hands the model the original tool schemas.

## Modules

| Module | Role |
|---|---|
| `app.py`, `proxy.py` | FastAPI app; streaming reverse proxy (SSE included) to the legacy API |
| `agent_runs.py` | `POST /agent/runs`: orchestrates one run and streams NDJSON |
| `gateway.py` | `ChatRun` (one chat on one connection, approval answers, cancel) and `rpc()` |
| `events.py` | `RunEventMapper`: gateway frames → run events, error classification, usage |
| `mcp_server.py` | Stateless per-run MCP server; forwards tool calls to the bridge |
| `llm_proxy.py` | Per-run OpenAI chat-completions proxy; forwards to the API's loopback model gateway |
| `models.py` | Puts the run's model alias into JiuwenSwarm's global model list |
| `schema.py` | Relaxes tool schemas for JiuwenSwarm; restores dropped empty arguments |

## What was measured on JiuwenSwarm 0.2.6 (not inferred)

Frames are recorded in `tests/fixtures/jw_*.raw`; `tests/stub_llm.py` scripts the model
so a run is reproducible.

- **Chat**: `chat.send` on the gateway (`/tui`). `res accepted`, then
  `chat.processing_status`, `chat.delta`\*, `chat.final`.
- **End of a run** is `chat.processing_status` with `is_complete`, **not** `chat.final`
  (a run paused for approval emits an empty `chat.final` and carries on).
- **Tools**: `chat.tool_call` / `chat.tool_update` / `chat.tool_result`. The result is a
  Python `repr` string (`success=True data={...} error=None ...`), not JSON. MCP results
  also carry the structured `raw_output`.
- **Approval** (JiuwenSwarm's own permission engine): an empty-error `tool_result` with no
  prior `tool_call`, then `chat.ask_user_question` (`source: permission_interrupt`). The
  options are positional (once, session, forever, deny) and labelled in the UI language.
  The answer is a second `chat.send` on the same connection. After a denial the tool
  result is the bare option label. `permissions.enabled` is off by default; `echo`/`pwd`
  are auto-allowed even with `bash: ask`.
- **Cancel**: `chat.interrupt` (`intent: cancel`, not streamed) gets a `res`; the run then
  just ends. No `chat.interrupt_result` arrives on the run's stream.
- **MCP**: management RPCs (`mcp.register_custom`, `mcp.connect`, `models.*`) are served on
  the web channel (`ws://<host>:<web port>/ws`), not `/tui`. A run reaches a server only
  when `chat.send` carries `"mcp": ["<name>"]`. With `progressive_tool_enabled: true` (the
  default) MCP tools are deferred behind `tool_search`/`tool_call`; the adapter needs it
  set to `false` (see `scripts/jiuwenswarm.sh`).
- **Models**: `models.replace_all` applies without a restart and replaces the whole list;
  `chat.send` selects an entry with `model_name`, which is also the id sent to the provider.
  Adding a model triggers an image-modality probe request (tool-less, non-streaming).
- **Tool call time limit**: JiuwenSwarm's MCP client gives every call 30 s (`[mcp-timeout] default_timeout=30.0s`) and fails a longer one with an empty `[182301] execute invoke failed, error=''`, without retrying a non-idempotent tool. `mcp.register_custom` accepts `timeout_s`, which the adapter sets per run.
- **Argument handling**: JiuwenSwarm validates MCP tool arguments strictly (pydantic) where
  the native agent never validated, and it **drops empty arrays and objects** from a call
  (`{"plan": []}` arrives as `{}`; `""`, `0` and `false` survive). `schema.py` compensates.
- **A client that disconnects mid-run** gets nothing more, and a new connection is not subscribed to
  that run's output. The run itself **keeps going** (measured: its output resumes on a new connection after
  `chat.resume`). `chat.resume` from a new connection answers `chat.interrupt_result` "task resumed" and
  the run's frames flow to it again, but **nothing sent in the gap is replayed** (a 6 s gap lost 6 frames);
  with no run it answers "task completed". `ChatRun` uses it to take a run up again when its connection to the
  gateway drops (three tries, then the run fails). An earlier reading of this section (the run ends when
  its client leaves) was wrong. A second `chat.send` on the same session still takes the session over.
- **Two connections on one session**: a second `chat.send` while a run is active does not queue and
  is not refused; it takes over. The first run stopped, and the *second* run's frames reached **both**
  connections. A connection that only listens (sends no request) receives nothing. The legacy API queues
  runs per session, so it must keep serialising them; the gateway will not.
- **Model failures** (401, 429, 500, or a stream that breaks halfway) all arrive as `chat.error` with
  `[181001] model call failed, reason: openAI API async stream error: <Exception>: Error code: <status> - ...`,
  followed by the usual completion status; a partial reply that streamed before a broken stream is
  delivered first. Each failed once within about a second, so there is no retry. Not observed: any
  `execution.error` or `runtime.error` (nothing in these scenarios produces them).
- **Usage**: `chat.usage_metadata` (one per model call) carries token counts including
  reasoning and cache fields; `chat.usage_summary` repeats their sum.

## Configuration

Choosing the backend and every variable, with defaults, is in one place:
[Local mode](../../docs/en/getting-started/deployment.md#local-mode-host-processes). In short:
`./scripts/start-stack.sh --mode local --jiuwenswarm` (the same as `SCIENCE_AGENT_ADAPTER=1
SCIENCE_AGENT_EXECUTOR=jiuwenswarm`); `GET /agent/info` on the public port says which backend runs and
whether JiuwenSwarm answers (it takes the API's `SCIENCE_AGENT_AUTH_TOKEN`, or `SCIENCE_AGENT_ADAPTER_TOKEN`).
The adapter itself reads `SCIENCE_AGENT_HOST`, `SCIENCE_AGENT_PORT`, `SCIENCE_AGENT_LEGACY_PORT`/`_URL`,
`JIUWENSWARM_GATEWAY_URL`, `JIUWENSWARM_MGMT_URL`, `SCIENCE_AGENT_ADAPTER_PUBLIC_URL`,
`SCIENCE_AGENT_ADAPTER_TOKEN`, `SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S`, `SCIENCE_AGENT_EXECUTOR` and
`SCIENCE_AGENT_ADAPTER_DEBUG` (`config.py`).

## Tests

    UV_PROJECT_ENVIRONMENT=/tmp/adapter-venv uv sync --extra test
    /tmp/adapter-venv/bin/python -m pytest                       # ~100 unit tests, no JiuwenSwarm needed

Opt-in tests that talk to a real JiuwenSwarm (set the URLs first; a scripted stub
model is in `tests/stub_llm.py`):

    JIUWENSWARM_GATEWAY_URL=... JIUWENSWARM_MGMT_URL=... JIUWENSWARM_LIVE_SCENARIO=agent_run \
      pytest tests/test_gateway_live.py           # scenarios: plain, bash, approval, deny, cancel, mcp, agent_run
    REAL_LLM_BASE_URL=... REAL_LLM_MODEL=... REAL_LLM_KEY=... pytest tests/test_real_llm.py

The stub must be freshly started for each live scenario (its script is consumed one turn
per request); see the docstring of `tests/test_gateway_live.py`. Credentials are only
ever read from the environment.

TypeScript side: `cd services/api && pnpm build && node --test dist/agent-run/jiuwenswarm-agent.test.js`.

## Status against the milestone-0 journeys

Verified on Linux (bubblewrap) with `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`:
`journey-first-run`, `journey-compact-process` (2), `journey-plan-workspace`,
`journey-delegate-subtask`, `journey-deliver-result`: all pass. `journey-real-request`
passes against a live OpenAI-compatible endpoint.

Not done yet:

- **History and context**: JiuwenSwarm is the only holder of the model's context. It keeps each agent's
  conversation in a stable session (`sessionKey`: the caller's session id for the main agent,
  `<session>--<agent>` for a subagent), persisted in its checkpoint database, and compresses it itself (its
  context engine compresses at 80% of one global window, `JIUWENSWARM_CONTEXT_WINDOW_TOKENS`; a model entry's
  own window is dropped by `models.replace_all` in 0.2.6, so there is no per-model setting). The adapter sends
  and rebuilds no history: a conversation that began on the built-in loop is not known to JiuwenSwarm
  (there is no call that writes into a session's context; `history.append_record` only writes the display
  record). The context survives a restart of JiuwenSwarm (`test/contract/jw-only/live.mjs history-restart`). Not
  verified: how its compression behaves on a full window.
- **Deferred tools**: JiuwenSwarm fixes the tool list at the start of a run, so every deferred MCP tool is
  promoted up front and `tool_search` is offered as well (`offerDeferredTools`).
- **Tool output store** (`ToolOutputStore`, oversized results by reference) is not part of
  the toolset; tool arguments are not schema-validated (as in the native agent).
- **Protocols**: JiuwenSwarm only speaks OpenAI chat completions to a model. The API starts a loopback
  model gateway per run (`services/api/src/agent-run/jiuwenswarm-model-gateway.ts`) that serves those
  requests through the native model client, so every protocol and variant the UI can configure
  (OpenAI chat completions with the DeepSeek/Gemini/Kimi/Qwen/MiniMax/Ollama variants, OpenAI Responses,
  Anthropic Messages) works, with the same thinking controls, network proxy, retries (including 429
  back-off) and usage accounting as the built-in loop. The provider's own assistant messages (Anthropic
  thinking blocks and signatures, Responses reasoning items) are restored on later requests and kept in
  the saved history. Images are not sent (the gateway refuses a request that carries one, which is how
  JiuwenSwarm's image probe learns the model has no image input here).
- **Model alias**: an entry is keyed by model id, so two endpoints serving the same id
  share one entry while a run is active.
- Everything outside `/agent/*` and `/llm/*` and `/mcp/*` is still proxied to the legacy API.

## JiuwenSwarm's default model (`sd-default`)

JiuwenSwarm makes some model calls of its own: the summaries written when it compresses a conversation, session
titles, the image-input probe of a new model. They use its *default model*, not the model of the run, and a fresh
install's default is a placeholder (`https://example.com/...`) that answers with an HTML page, so a compression
attempt failed with `APIStatusError: <!doctype html>` and nothing was compressed. The adapter therefore keeps one
entry, `sd-default`, first in JiuwenSwarm's list and flagged as the default, whose endpoint is
`/llm/default/v1` on the adapter (`llm_proxy.default_completions`). That route sends the call, untouched (no system
prompt, tool list or tool name rewritten), to the model of the run that started last and is still going, and answers
503 when no run is in progress. It is set at start-up and before each run. Consequence: the JiuwenSwarm instance is
ScienceDiscovery's own.
