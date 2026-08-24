# Agent Backend: the Node-native agent loop

## 1. Summary

- **The agent loop runs inside the Node control plane** (`services/api`). The hop that handed one conversation turn to a Python sidecar is gone.
- The loop, model streaming, tool scheduling, deferred-tool discovery, and history compaction are this repository's own TypeScript. **No LangChain or LangGraph, and deer-flow does not drive the loop.**
- Model calls go out from Node directly (`undici`) in two dialects: **OpenAI-compatible** and **Anthropic Messages**.
- MCP servers are connected **in-process** with the official TypeScript SDK (stdio / SSE / streamable HTTP), not through a gateway HTTP hop.
- Tool implementations remain in the Node control plane: `packages/workspace` builds workspace tools, `packages/tools` owns registration and dispatch policy, and the API injects governance, provenance, execution, and data-source adapters. The native loop `await`s those handlers directly, so `POST /internal/tool-exec` is no longer needed.
- **The Python sidecar is no longer a service**: web providers are native too, so the gateway's HTTP service is gone; `services/gateway` is now only the host package and interpreter environment for the bundled Python MCP servers. See §10.

The former architecture (Python gateway running LangChain `create_agent`, Node `POST /run`, gateway callback to `/internal/tool-exec`) is retired; see §11.

## 2. End-to-end turn

```text
Browser ──SSE/REST──▶ services/api
                          │
                          │ runs/index.ts builds AgentProfile + WorkspaceAgentOptions
                          ▼
                    createAgentRun(profile, bindings, input)     ← agent-run/create-agent-run.ts
                          │  default factory: createNativeAgent
                          ▼
                    NativeAgent.execute(prompt)                  ← native-agent/index.ts
                          │
      ┌───────────────────┴────────────────────────────────────────────┐
      │  for turn in 0..MAX_MODEL_TURNS:                               │
      │    1. maybeCompact(history)          ← native-agent/compaction │
      │    2. streamModelTurn(...)           ← native-agent/model-client│
      │         └─outbound HTTPS─▶ configured model endpoint            │
      │         └─onTextDelta / onThinkingDelta ─▶ AgentEvent ─▶ SSE   │
      │    3. no tool_calls → break                                    │
      │    4. run every tool call of this turn concurrently            │
      │         └─▶ AgentTool.execute(...)   ← workspace + tools      │
      │              └─▶ permission gate / Runner:4311 / MCP / connectors│
      │    5. append tool results in call order, go back to step 1     │
      └────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                    finalMessages (OpenAI wire format, system stripped)
```

**State ownership.** Session messages, tool implementations, permission epochs, and workspace files are authoritative in Node. **No second process holds conversation state** — relative to the old architecture this is a simplification, not a change.

**History format.** OpenAI wire format throughout (`role` / `content` / `tool_calls` / `tool_call_id`). Assistant messages are stored **verbatim**, including unknown provider fields such as Gemini `thought_signature`. That is why the native loop needs no model-patch layer: the next request replays them as-is.

## 3. `agent-run/create-agent-run.ts` — starting one run

**Responsibility.** Translate the control plane's `AgentProfile` + `AgentRunInput` into a `NativeAgent` and expose a run-scoped handle. It contains no loop logic.

| Item | Value |
|---|---|
| Entry | `createAgentRun(profile, bindings, input): AgentRunHandle` |
| Default factory | `bindings.createAgent ?? createNativeAgent` — tests may inject a double; production is always the native loop |
| Returns | `{ abort(), beginExternalWait(), execute() }` |

Key mapping:

| Source | Passed to NativeAgent |
|---|---|
| `input.history` | `structuredClone`d into `gatewayHistory` (name kept; meaning is "authoritative transcript handed off by the preceding AgentRun") |
| `profile.budget.runTimeoutMs` | `runTimeoutMs` |
| `bindings.runIdleTimeoutMs` | `runIdleTimeoutMs` |
| `input.runContract` | `runContract`, injected into the system prompt as `<run_contract>`; never part of `messages`, so compaction cannot drop it |
| `profile.toolPolicy` | `{ allowed, disallowed }` |
| `profile.resources.connectorIds` | `enabledConnectorIds` |
| `profile.gatewayThreadId` | `sessionId` (logging/tracing only) |

**Failure behaviour.** `execute()` may run once; a second call throws `AgentRun <id> has already been executed`. `bindings.abortSignal` is forwarded to `agent.abort()`, and the `finally` block always detaches the listener and the event subscription.

## 4. `native-agent/index.ts` — the loop state machine

The core of the backend: the `NativeAgent` class.

### 4.1 Construction (once)

1. `buildTools(options)` calls `createWorkspaceTools` for the full tool table; a duplicate name throws `Duplicate workspace tool name`.
2. `buildDeferredToolState(...)` collects `deferred` tools into a catalog (§6).
3. `buildWorkspaceSystemPrompt(...)` produces the base prompt (skills, scientific environments, approval mode, specialist, subagent…).
4. The final system prompt is assembled as:

   ```text
   base workspace prompt
   <run_contract>…</run_contract>        (when runContract is set)
   <available-deferred-tools>…</…>       (when deferred tools exist)
   <mcp_routing_hints>…</…>              (when prefer-routing hints exist)
   ```

5. History normalization: `normalizeHistoryMessage` rewrites **legacy environment tool names** (`normalizeLegacyEnvironmentToolName`) in `message.name`, `tool_calls[].name`, and `tool_calls[].function.name`, so replaying an old Session never surfaces a tool name the model cannot match.
6. Model endpoint and `ModelClientPolicy` are resolved (§5.1).

### 4.2 The `execute(text)` loop

```text
history.push({role:"user", content:text})
autoPromoteFromRouting(...)                  ← keyword pre-promotion of deferred tools
armTurnDeadline(); markProgress()            ← arm both timers

for turn in 0 .. MAX_MODEL_TURNS(128):
    aborted? → raise
    maybeCompact()                           ← compact history when over the trigger
    emit turn_start
    modelTurn = streamModelTurn(...)         ← one streamed turn; every chunk calls markProgress
    history.push(modelTurn.assistantMessage) ← stored verbatim
    if modelTurn.toolCalls is empty → break
    emit tool_execution_start per call
    outcomes = await Promise.all(calls.map(executeToolCall))   ← concurrent
    emit tool_execution_end per result and history.push({role:"tool", ...})
emit model_usage (+ usage)
return { finalMessages: deep copy of history without system messages }
```

Notes:

- **`MAX_MODEL_TURNS = 128`** is only a runaway-loop backstop; the real bound is the time budget.
- Multiple tool calls in one assistant turn run **concurrently**, but results are appended **in call order** so runs stay reproducible.
- `finalMessages` strips `role === "system"` for the explicit RequestExecution handoff.

### 4.3 Timeouts: two independent timers

| Timer | Option | Default | Meaning |
|---|---|---|---|
| Whole run | `runTimeoutMs` | `DEFAULT_AGENT_TURN_TIMEOUT_MS = 0` (unlimited) | Hard deadline for one complete run |
| No progress | `runIdleTimeoutMs` | `DEFAULT_AGENT_IDLE_TIMEOUT_MS = 240_000` | Longest gap since the last progress mark |

"Progress" means `markProgress()` fired: on every model stream chunk, at the end of a model turn, and after each tool result is appended.

**External waits.** `beginExternalWait()` returns a release function and supports nesting. The first entry calls `pauseRunDeadline()`, which clears both timers and subtracts elapsed time from `remainingRunMs`; when the count returns to zero `resumeRunDeadline()` re-arms them. A main agent waiting on a subagent or a human approval uses this so the child's own `timeout_seconds` / `max_turns` govern instead.

**Error wording is a contract.** Timeout errors **must** contain `timeout`: `classifySubagentFailure` matches `/timeout/i` to preserve the public `timed_out` subagent status. The two messages are `Agent run stalled: no gateway progress for N ms` and `Agent run timeout: gateway turn exceeded N ms`.

**Cancellation.** `abort()` sets `abortRequested` and aborts the `AbortController`; the signal reaches both the model request and tool `execute`. `raiseForAbort` separates timeout (converted to the timeout error), explicit cancellation (`Agent run cancelled`), and genuine errors (rethrown unchanged).

### 4.4 Tool dispatch and failure shape

`executeToolCall` decides in this order:

1. **Argument parse failure** → `INVALID_TOOL_ARGUMENTS`, `retryable: true`; no handler runs.
2. **`tool_search`** → deferred-catalog search (§6); does not pass the permission gate.
3. **A still-hidden deferred tool** → `blockedDeferredToolResult`, telling the model to call `tool_search` first.
4. Otherwise → `executeTool(name, args, id)`.

`executeTool` also performs **loop detection**, keyed on `sha256(name + stably serialized args)`:

| Repeat count | Behaviour |
|---|---|
| ≥ `LOOP_DETECTION_WARN_COUNT` (10) | `REPEATED_TOOL_CALL` warning, `isError: false`; the call still proceeds in later turns |
| ≥ `LOOP_DETECTION_HARD_COUNT` (20) | `TOOL_LOOP_DETECTED`, `retryable: false`; the call is **not executed** |

A throwing tool becomes a structured JSON result rather than a crashed loop:

```json
{ "ok": false, "error": { "code": "...", "message": "(truncated to 1000 chars)", "attempts": N, "retryable": bool, "retryAfterMs": ms } }
```

`code` / `attempts` / `retryable` / `retryAfterMs` come from the error's `invocation` field when present (the MCP governance path supplies it), otherwise they fall back to `TOOL_EXECUTION_FAILED` / `1` / `false`. An unknown name returns `Unknown tool: <name>`.

**Remote-content sanitization** (`native-agent/sanitize.ts`): after a tool succeeds and before the result reaches history or the UI, text from `web_search` / `web_fetch` / `image_search` / `web_capture` passes through `neutralizeUntrustedTags` — framework authority tags are HTML-escaped (`<system-reminder>` → `&lt;system-reminder&gt;`) and `--- BEGIN/END USER INPUT ---` becomes the inert `[BEGIN/END USER INPUT]`. Local tool output (shell, file reads) is left byte-exact so real code and logs are never mangled.

The denylist covers every authority block this product injects (`available-deferred-tools`, `available_skills`, `durable_context_data`, `mcp_routing_hints`, `run_contract`, `skill_system`, `subagent_system`, `system-reminder` / `system_reminder`) plus generic injection patterns. A **drift test** in `sanitize.test.ts` scans the prompt sources: any newly emitted tag must either join the denylist or be justified in the test's `NON_AUTHORITY_TAGS` map, or the test fails. That guard exists because `<run_contract>` was once introduced without updating the list.

### 4.5 How events become SSE

`NativeAgent` only emits `AgentEvent` (defined in `packages/orchestration/src/agent.ts`). The observer in `services/api/src/runs/index.ts` translates them:

| AgentEvent | Emitted when | SSE event |
|---|---|---|
| `turn_start` | before each model turn | `agent.phase` (`phase: "thinking"`, incrementing `turn`) |
| `message_update` / `thinking_delta` | reasoning delta | `assistant.thinking.delta` |
| `message_update` / `text_delta` | content delta | `assistant.delta` |
| `tool_execution_start` | each tool call dispatched | `tool.started` with a `running` `ToolTrace` |
| `tool_execution_end` | each tool result ready | `tool.output` + `tool.completed` (`completed` / `failed`) |
| `model_usage` | loop end | recorded as the run's usage, not forwarded directly |
| `usage` | loop end with usage present | subagent usage roll-up |

## 5. `native-agent/model-client.ts` — streaming model transport

**Responsibility.** One model turn: two dialects in, one normalized result out.

```ts
streamModelTurn(endpoint, systemPrompt, history, tools, policy, signal, callbacks): Promise<ModelTurn>
```

`ModelTurn = { assistantMessage, toolCalls, usage? }`. The dialect is chosen by `isAnthropicEndpoint(baseUrl)` — **the test is whether the base URL contains `/api/plan`** (the internal plan endpoint). Everything else uses the OpenAI-compatible path.

### 5.1 Policy and networking

`resolveModelClientPolicy(env)`:

| Environment variable | Default | Validation |
|---|---|---|
| `SCIENCE_AGENT_LLM_TIMEOUT_SECONDS` | 600 | must be positive, otherwise it throws at construction |
| `SCIENCE_AGENT_LLM_MAX_RETRIES` | 2 | must be a non-negative integer |

`maxTokens` is fixed at `DEFAULT_MODEL_MAX_TOKENS = 16_384`.

`requestWithRetry` retries only **pre-stream** failures: connect errors, `429`, `5xx`. Once bytes are flowing, errors surface to the caller so half a turn is never replayed. Backoff is `min(4000, 500 * 2^attempt)` ms, overridden by `Retry-After` when the response carries it. `headersTimeout` is the request timeout while `bodyTimeout` is `0` — **a long stream must not be cut off for being slow**.

Proxying: `proxyDispatcher(proxy)` branches on `ResolvedProxy.mode` — `environment` keeps the process default dispatcher, `url` pins one `ProxyAgent`, and `direct` pins a clean `UndiciAgent` (ignoring ambient proxy variables).

### 5.2 OpenAI-compatible dialect

- `POST {baseUrl}/chat/completions` with `stream: true` and `stream_options: { include_usage: true }`.
- Messages are `[{role:"system", content: systemPrompt}, ...history]`.
- Tools are sent as `{ type:"function", function:{ name, description, parameters } }`.
- SSE parsing in `sseData()` splits `data:` lines and skips `[DONE]`; **malformed keepalive frames are tolerated** (a failed `JSON.parse` skips that line instead of breaking the stream).
- `delta.reasoning_content` → `onThinkingDelta`; `delta.content` accumulates and fires `onTextDelta`.
- **Tool-call fragments merge by `index`**: `function.name` is taken once seen, `function.arguments` strings are **concatenated**, and any other unknown field (such as `thought_signature`) is merged verbatim into the fragment and written back into the assistant message's `tool_calls`. That is what makes provider quirks replay automatically.
- A missing `id` becomes `call_<uuid>` and a missing `type` becomes `function`; a fragment **without `function.name` never enters `toolCalls`** (though it stays on the wire message).

### 5.3 Anthropic Messages dialect

- `POST {baseUrl}/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`.
- `toAnthropicMessages(history)` translates OpenAI-format history: `system` is skipped (it goes in the top-level `system` field), `assistant.tool_calls` become `tool_use` blocks, and `role:"tool"` becomes a **user-role** `tool_result` block. **Adjacent same-role messages are merged** to satisfy Anthropic's alternation rule.
- Stream events: `content_block_start` (opens a `tool_use` slot), `content_block_delta` (`text_delta` / `thinking_delta` / `input_json_delta` accumulating the argument JSON), and `message_start` / `message_delta` for usage.
- The result is rebuilt into **the same OpenAI wire shape** (`tool_calls[].function.arguments` as a string, empty arguments becoming `{}`), so history stays uniform everywhere upstream.

### 5.4 Usage normalization

`normalizeUsage(raw)` accepts both spellings and derives missing fields:

| Normalized field | Accepted source keys |
|---|---|
| `inputTokens` | `input_tokens`, `prompt_tokens` |
| `outputTokens` | `output_tokens`, `completion_tokens` |
| `totalTokens` | `total_tokens` (derived from input+output when absent) |
| `cacheReadTokens` | `cache_read_input_tokens`, `cache_read_tokens`, `cached_tokens`, `prompt_cache_hit_tokens`, `prompt_tokens_details.cached_tokens` |
| `cacheWriteTokens` | `cache_creation_input_tokens`, `cache_write_tokens`, `prompt_cache_miss_tokens` |

If any of the three token counts still cannot be derived, the whole result is `undefined` — reporting nothing beats reporting wrong numbers.

## 6. `native-agent/deferred-tools.ts` — deferred tool discovery

**Problem.** MCP tool schemas are large; binding all of them crowds the context window.

**Approach.** Tools flagged `deferred` (currently every MCP tool, see `packages/workspace/src/workspace.ts`) are **not bound** to the model. Their names appear in `<available-deferred-tools>` in the system prompt; the model fetches full schemas through the synthetic `tool_search` tool, which **promotes** them for the rest of the run.

| Symbol | Role |
|---|---|
| `DeferredToolCatalog` | The catalog; `hash` is the first 16 hex chars of a sha256 over name-sorted schemas, used to detect catalog drift |
| `DeferredToolState` | `{ catalog, promoted: Set<string> }`, run-scoped |
| `hiddenDeferredNames(state)` | Catalog names not yet promoted; `visibleToolSpecs()` filters the wire tool table with it |
| `runToolSearch(state, query)` | Search, promote, and return OpenAI function schemas as JSON |
| `blockedDeferredToolResult(name)` | Retryable error text when an unpromoted tool is called |
| `autoPromoteFromRouting(...)` | Pre-promotion driven by operator routing hints |

Three query forms:

| Form | Semantics | Cap |
|---|---|---|
| `select:a,b` | exact names | **uncapped** — an explicit selection must not silently drop schemas |
| `+slack send` | name must contain `slack`; remaining terms rank the results | `MAX_RESULTS = 5` |
| `notebook jupyter` | treated as a regex over `name + description`; a name hit scores 2, a description-only hit scores 1 | `MAX_RESULTS = 5` |

**Failure behaviour.** When the model supplies an invalid regex, `compileQueryRegex` / `countMatches` **degrade to literal matching** instead of throwing. No match returns `No tools found matching: <query>`.

**Auto-promotion.** At the start of `execute()`, `autoPromoteFromRouting` lowercases the **current user input** and substring-matches it against tools whose `routing.mode === "prefer"` and that carry keywords, sorting by `priority` descending (ties by name) and promoting the top `AUTO_PROMOTE_TOP_K = 3`.

**Prompt sections.** `deferredToolsPromptSection` emits the sorted name list; `routingHintsPromptSection` emits `<mcp_routing_hints>`, telling the model to call `tool_search` first for still-deferred tools and to simply prefer already-visible ones. Both HTML-escape names and keywords so a tool name cannot forge prompt structure.

## 7. `native-agent/compaction.ts` — history compaction

**Trigger.** `planCompaction(history)` produces a plan once `history.length >= COMPACTION_TRIGGER_MESSAGES (50)`, keeping the last `COMPACTION_KEEP_MESSAGES (20)`.

**Cut-point correction.** The preserved window **must not start with a tool result**: `cutoff` advances while `history[cutoff].role === "tool"`, so an assistant message and its tool results are always compacted together and no orphan tool result survives.

**Summarization.** One separate request to the same model endpoint (system prompt `You are compacting…`, no tools). `buildSummaryPrompt` renders the segment as a transcript (assistant lines carry `[tool calls: name(first 300 chars of args)]`, tool results are bounded to 600 chars), bounds the whole thing to `SUMMARY_INPUT_CHAR_BUDGET = 16_000`, HTML-escapes it, and wraps it in `<new_messages>`; a previous summary is wrapped in `<existing_summary>` with half that budget. **Escaping is a security requirement** — summarized content must not be able to close those tags and forge structure.

**Checkpoint.** `summaryCheckpointMessage` builds a `role:"user"`, `name:"summary"` message whose body starts with `[ScienceDiscovery summary checkpoint]` inside `<durable_context_data>`, with `additional_kwargs` carrying `hide_from_ui: true` and `sciencediscovery_summary_checkpoint: true`. The render budget is `SUMMARY_RENDER_CHAR_BUDGET = 6_000`; `boundText` keeps head and tail (two-thirds head, then `\n...\n`, then tail).

**Chaining.** The next compaction reads the previous summary back through `extractCheckpointSummary` and merges it, so the summary **rolls forward** rather than stacking. The format matches the previous engine, so **older histories still parse**.

**Failure behaviour.** A failed summary request **skips compaction and lets the run continue** (unless the signal was aborted, which propagates). An empty summary produces no checkpoint.

## 8. MCP: `mcp/node-client.ts` and `mcp/extensions-config.ts`

**Responsibility.** Connect MCP servers in-process with the official `@modelcontextprotocol/sdk`, replacing the "Node → gateway HTTP → Python MCP client" hop while **keeping the governance contract identical** (`McpInvokeRequest` / `McpInvokeResponse`).

### 8.1 Configuration

`extensions-config.ts` reads `extensions_config.json`. The path comes from `SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH` (set but missing → it throws), otherwise `cwd/extensions_config.json`, otherwise the config is empty. `${ENV_VAR}` placeholders are resolved. The `signature` is a sha256 over path + mtime + size + content, so **any content change rebuilds every session**.

### 8.2 Transports and sessions

| transport | Construction |
|---|---|
| `stdio` | `StdioClientTransport` spawns a subprocess with `stderr: "ignore"` |
| `sse` | `SSEClientTransport(new URL(url), { requestInit: { headers } })` |
| `http` / `streamable_http` | `StreamableHTTPClientTransport(...)` |

**Interpreter resolution.** For stdio servers whose `command` is a bare `python` / `python3`, `resolveMcpPython()` tries `SCIENCE_AGENT_GATEWAY_PYTHON_PATH`, `$SCIENCE_AGENT_DATA_DIR/envs/gateway/bin/python`, `.sciencediscovery-data/envs/gateway/bin/python`, and `services/gateway/.venv/bin/python` before falling back to `python`. **This is why the bundled biomed / UniProt MCP servers still depend on the gateway venv.**

**Environment projection.** The child environment starts from `getDefaultEnvironment()`, adds the configured `env` (**proxy variables are filtered out**), then applies `proxyEnvOverlay(proxy)`: `direct` injects nothing, `environment` copies the current process's proxy variables, and `url` pins `HTTP_PROXY` and friends to that URL while preserving `NO_PROXY`.

**Session cache and invalidation.** Sessions are cached per server id along with a `proxySignature`. A changed proxy signature closes and reconnects that server; a changed config signature triggers `closeAll()`; and `invoke` self-heals when the request's proxy differs from the cached one.

### 8.3 Catalog

`catalog()` walks enabled servers, pages `listTools()` (following `nextCursor`), sorts by name, computes a `schemaHash` per tool (sha256 of `inputSchema`), and attaches the routing annotation from `effectiveRouting(server, toolName)`. The catalog `revision` is a sha256 over all server structures.

**Failure isolation.** **One broken server does not block the others** — its error is swallowed, it appears with an empty tool list, and its session is closed so the next catalog reconnects.

**Tool naming.** The name the model finally sees is `mcp__<sourceId>__<toolId>` (illegal characters replaced with `_`), assembled in `services/api/src/mcp/workspace-tools.ts`.

### 8.4 Invocation

`invoke(request, signal)` implements the full retry / timeout / limit semantics:

- **Overall deadline**: `started + request.execution.timeoutMs`; each attempt checks the remainder first and records `timeout` when it is exhausted.
- **Per-call timeout**: `min(remaining, server.toolCallTimeoutSeconds * 1000)`.
- **Response cap**: `request.execution.maxResponseBytes`, default `5_000_000`; exceeding it raises `RESPONSE_TOO_LARGE`.
- **Error classification**: `classifyError` maps the message to `timeout` / `rate-limited` / `transport-error` / `server-error` / `semantic-error` and best-effort parses a retry-after value. A `transport-error` **closes the session first** so the next attempt reconnects — the typical dead-stdio-subprocess case.
- **Backoff**: exponential `initialDelayMs * multiplier^(n-1)` capped at `maxDelayMs`, with `jitterRatio` jitter; `respectRetryAfter` prefers a parsed retry-after. **If the delay would cross the deadline the loop gives up instead.**
- **Response shape**: success and failure both return `McpInvokeResponse` with a per-attempt `attempts[]` (status, duration, error code). Failures set `isError: true` with the error text truncated to 1000 chars. An unknown or disabled server throws with `statusCode: 404`.

## 9. Capability packages and the loop boundary

The former `packages/agent-runtime` aggregate has been split by ownership. `packages/runtime-core` drives the generic loop; capability packages provide its typed context, model, and tool ports without importing service code.

| Export | Owner | Relationship to the loop |
|---|---|---|
| `buildWorkspaceSystemPrompt(...)` | `packages/context` | Builds the workspace/system-prompt contribution consumed by the context assembler |
| `createWorkspaceTools(root, options)` | `packages/workspace` | Produces `AgentTool[]`; concrete ports are supplied by the API composition root |
| `AgentTool`, `ToolRegistry` | `packages/tools` | Define tool execution and own deferred discovery, sanitization, and loop policy |
| `AgentEvent`, `Agent` | `packages/orchestration` | Define run-facing lifecycle contracts; `runs/index.ts` maps events to SSE (§4.5) |
| `AgentHistoryMessage` | `packages/orchestration` | One provider-neutral runtime history entry |
| `normalizeLegacyEnvironmentToolName` | `packages/workspace` | Tool-rename compatibility during history replay |

**Boundary principle.** The loop does **not** decide tool semantics, permissions, or provenance; the tool layer does **not** know which loop drives it. That boundary is what let the engine be replaced while governance stayed put.

## 10. What `services/gateway` is now

**Not a service.** It has no HTTP port, no FastAPI application, and `start-stack.sh` no longer launches it. What remains is the two bundled stdio MCP servers (biomed, UniProt) and the external-URL registry they share; Node locates that venv's interpreter through `resolveMcpPython()` and spawns them as subprocesses (§8.2).

So **the gateway venv still needs provisioning, but the gateway service is gone.** The `deerflow-harness` dependency was removed from `pyproject.toml`, `import deerflow` now raises `ModuleNotFoundError` in that environment, and `services/gateway/tests/test_architecture_boundaries.py` pins the boundary with a whole-package assertion.

Web-provider execution moved to `services/api/src/web-providers/native/`: `NativeWebProviderClient` keeps the call contract and response shape `WebBroker` already consumed, so permission, credentials, caching, CAS, auditing, and the fallback policy are untouched — only the execution body changed.

## 11. Retired

The following are **no longer the current architecture** and are listed only for historical comparison:

| Retired | Former location | Status |
|---|---|---|
| `GatewayAgent` | `services/api/src/gateway-agent.ts` | File deleted |
| `POST {gateway}/run` driving conversations | Node → gateway | The route and all of its assembly code (`tools.py`, `callback.py`, `model.py`, and the `_engine` agent/deferred/state/summarize/model_patch/skills/sanitize modules) are deleted |
| `POST /internal/tool-exec` callback | gateway → Node | The native loop `await`s handlers directly; the route, the `callback_token` mechanism, and `SCIENCE_AGENT_TOOL_CALLBACK_URL` are all deleted |
| LangChain `create_agent` / LangGraph driving the loop | gateway `_engine/` | Replaced by `native-agent/index.ts` |
| deer-flow dependency and submodule | gateway `pyproject.toml`, `third_party/deer-flow` | Removed entirely: with native web providers there is no vendor caller left, so the dependency, the submodule, the first-launch download, and the packaging pin are all gone |
| Model-patch layer (thought_signature replay) | gateway `_engine/model_patch.py` | The native loop stores assistant messages verbatim, so replay is inherent |

## 12. Verification entry points

```bash
./test/api/run_m1_smoke.sh        # hermetic: scripted SSE model endpoint + real Node tools, full native loop
./test/api/run_real_smoke.sh      # live model + real tools
```

Unit tests (`services/api`, `pnpm test` runs `node --test dist/**`):

| File | Coverage |
|---|---|
| `src/native-agent/native-agent.test.ts` | loop state machine, timeouts, cancellation, loop detection, compaction trigger |
| `src/native-agent/model-client.test.ts` | both dialects' stream parsing, tool-call fragment merging, usage normalization |
| `src/mcp/node-client.test.ts` | transport selection, interpreter resolution, proxy projection, retry and error classification |
| `src/agent-run/create-agent-run.test.ts` | default factory and run-handle semantics |
| `src/native-agent/sanitize.test.ts` | tag escaping, boundary replacement, scope, drift guard |
| `src/run-failure.test.ts` | run-failure classification with the original error preserved |

## 13. Related documents

- [architecture.md](architecture.md) — processes and the global module map
- [control-plane.md](control-plane.md) — control-plane responsibilities and interfaces
- [mcp-tool-protocol.md](mcp-tool-protocol.md) — MCP governance contract and result normalization
- [science-connectors.md](science-connectors.md) — scientific MCP, governance, and file lifecycle
- [subagent-orchestration.md](subagent-orchestration.md) — main/sub agent orchestration and the result contract
- [skill-progressive-disclosure.md](skill-progressive-disclosure.md) — progressive skill disclosure
- [builtin-tools.md](../reference/builtin-tools.md) — tool list, parameters, and exposure conditions
