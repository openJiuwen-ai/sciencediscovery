# Swarm compatibility patches

`scripts/swarm-patches.py` applies the versioned patches in `patches/<tag>/`
during installation/build, not during service startup. These changes repair runtime binding
and transport bugs; research business logic remains in ScienceDiscovery.

## Installation and release packages

- Local `scripts/jiuwenswarm.sh setup` patches the pinned Git checkout before
  installing it. After updating patches, run `setup` again before `start`.
- Docker and binary builds retain the PyPI dependency provisioning layer, but
  replace the Swarm distribution with a wheel built by
  `scripts/build-swarm-wheel.sh` from the pinned Git tag plus our patches.
  The PyPI release and same-named Git tag are not byte-identical; applying the
  source patches directly to the PyPI wheel is not supported.
- All three paths use `scripts/swarm-patches.py`. An unsupported tag or patch
  mismatch fails installation/build. The helper records patch and modified-file
  SHA-256 hashes in `.sciencediscovery-patches.json` beside the installed package.
  Container/local startup only verifies that receipt; it does not patch code,
  clone repositories, or require Git for verification. Binary packaging verifies
  the receipt before bundling the payload.
- The Git tag is the source identity. The `workswarm0.2.6` tag currently contains
  package metadata `0.2.5.beta1`; do not infer source identity from that metadata.
  Release builds still need their normal boot/tool smoke checks: hash verification
  is not a substitute for exercising the installed runtime and its dependencies.

For `workswarm0.2.6`:

- Platform runs pass a private `run_model` connection to the session adapter.
  The real model name is unchanged. Run startup/cleanup no longer adds/removes
  temporary global model entries or triggers global model hot reloads.
- Unary startup errors retain `chat.error` through E2A stream conversion.
  Missing terminal events/results are failures, not successful empty answers.

- MCP calls honor their configured deadline without disconnecting a shared
  client when one call times out. Internally governed MCP cards do not receive
  a competing default 300-second wrapper timeout.
- Re-registering the dynamic `sci` server refreshes its tool cards on the
  existing connection. This permits a later specialist to add literature
  tools without leaving its model with the leader's cached tool list.
  Other MCP servers retain their normal registration behavior.
- A requested model absent from an adapter's cache is resolved against the
  currently published model configuration. ScienceDiscovery runs reject an
  unavailable explicit model instead of silently switching to the shared
  default route, which does not carry the run's tool contract.
- TUI event envelopes preserve `stream_request_id`, separately from the
  approval question ID. Platform runs opt into `sci_persistent_output`:
  the SDK output subscription stays open across permission interruptions.
  `runtime.output_owner` identifies the request actually consuming output;
  approval submissions are control requests, not replacement result streams.
  Their acknowledgements and completion markers cannot finish the logical run.
  Native Swarm UI requests do not opt into this lifecycle change.
- `chat.error`, `execution.error`, `runtime.error` and `error` are terminal
  failures: the adapter reports them without waiting for a later completion
  marker or the platform idle timeout. Transport heartbeats are not progress.

Set `SCIENCE_AGENT_TRACE_TOOLS=1` on the adapter to log `[tool-contract]`
records containing expected, incoming Swarm, and outgoing LLM tool names.
Calls with no tools can be model capability probes, not agent reasoning
steps. This diagnostic does not log API keys, prompts or tool arguments.
Inspect the model-bearing agent call, not a probe, when checking missing tools.

## Platform task execution contract

ScienceDiscovery still owns `task` scheduling, permissions, provenance and
Artifact handoff. Swarm owns the reasoning loop and conversation history of
each main/child session. This change does not switch delegation to native
`subagent_spawn`.

| Boundary | Contract |
| --- | --- |
| API → adapter | Task, system prompt, session key, run/agent identifiers, tool schemas, bridge and model connection |
| Adapter → Swarm | Real model name and private in-memory `run_model`; MCP selection and task |
| Swarm → adapter | Correlated tool, text, approval and terminal events; startup failures do not require an output lease |
| Adapter → API | Events followed by one `done` with `completed` / `failed` / `cancelled`; missing or duplicate terminal results fail closed |
| Child → parent | Existing platform task result and Artifact references; paths alone do not transfer files |

The session keeps its model binding across approval control requests. A later
run on an idle session may replace it; replacing an executing session's binding
is rejected. Global config reloads must not overwrite this private connection.
Route tokens are credentials, not model names or public correlation IDs; do not
publish raw request bodies or private diagnostic traces. Only ephemeral proxy
credentials cross this boundary, not the provider's API key.

Approval answers are continuations, not fresh tasks. The adapter snapshots each
run's configuration and resends its MCP selection, equipment, workspace and
private model route on every answer (manual approval, automatic approval or
denial). It never replays the original query or attachments. Explicit empty
equipment remains empty; omitted fields remain omitted. This prevents approval
recovery from depending on potentially stale session equipment metadata and
dropping `mcp_sci_run_shell` / artifact tools with `Ability not found`.
Regression coverage lives in `services/adapter/tests/test_gateway.py`; shared
MCP transport lifetime is managed separately from this continuation contract.

Tool execution deadlines are enforced by the adapter for each run's toolset
(`toolTimeoutSeconds`, or `SCIENCE_AGENT_ADAPTER_TOOL_TIMEOUT_S` by default).
Starting a child with a longer deadline does not replace the shared MCP client.
Compatibility patch `0004-platform-mcp-transport.patch` removes the shared
registration's default execution deadline only for the platform `sci` client;
explicit SDK call deadlines and discovery/connect deadlines remain effective.
Deploy the adapter and this patch together. Timeout errors warn that execution
may be incomplete: cancelling an HTTP wait does not prove an external side
effect was rolled back, so callers must inspect state before replaying it.

Swarm's permission policy is global by tool name. The adapter therefore requires
one consistent approval contract for each shared tool name during its lifetime.
Conflicting `allow` / `ask` registrations fail explicitly before changing the
catalog or permission policy; they never inherit the first value silently or
overwrite another run's policy. This is a fail-closed limitation, **not** support
for different per-run Swarm policies. Platform user approval modes continue to
be handled by the existing approval bridge. Permission RPC failures are retried
on the next registration attempt before publishing the tool.

### Cross-framework boundary regression checks

Run the deterministic adapter checks without a model or live Swarm service:

```bash
PYTHONPATH=services/adapter/src services/adapter/.venv/bin/python -m pytest -q services/adapter/tests/test_agent_runs.py -k boundary
```

These tests execute adapter code with a simulated gateway; they are not browser
E2E tests and do not prove parent-to-child cancellation propagation.

| Boundary | Current result |
| --- | --- |
| A longer child timeout must not disconnect an active shared MCP transport | Passes: no transport replacement |
| Conflicting policies must not silently inherit or overwrite one another | Passes: explicit rejection, checked in both directions |
| Independent approval answers can finish out of order | Passes |
| Cancelling one run preserves a sibling's routes and pending approval | Passes |
| Failed startup releases private model and tool routes | Passes |

Additional checks in `test_mcp_server.py` exercise independent per-run deadlines
and reuse after a timeout. `jiuwen_swarm/tests/test_sci_http_client.py` checks the
real SDK transport with a loopback MCP server, including long calls and explicit
timeouts. These checks do not assert a downstream authorization bypass existed.

The broader [MCP boundary audit](tests/README.md) tests request isolation,
new-call recovery, downstream cancellation and pre-bridge UI events. The
platform-only JSON transport retains the SDK's ClientSession but correlates
HTTP/protocol errors per request. It does not change third-party MCP clients,
implement SSE resumption, or automatically replay calls with unknown outcomes.
Explicit disconnect stays closed until explicitly connected again.

Request failures log `platform_mcp_request_failed`; shared lifecycle failures
log `platform_mcp_transport_failed`. Both retain exception types and stack
locations without credential-bearing URLs or exception messages. Cancellation
closes the corresponding HTTP request and propagates through the adapter to
the Node tool abort signal; it cannot roll back an already-completed side effect.

For cross-framework debugging, set `SCIENCE_AGENT_BOUNDARY_TRACE=1` on the
adapter. Optional `SCIENCE_AGENT_BOUNDARY_TRACE_FILE=/private/path/boundary.jsonl`
also writes a private rotating JSONL file (10 MiB plus three backups). Events
link run/agent/session ids, the MCP connection/request id, tool-call ids, status,
elapsed time and result character counts. No prompts, arguments, result bodies,
URLs, headers or exception messages are added to this diagnostic stream. Full
model input/output remains in the existing session trajectory store, separately
from these metadata-only logs. Diagnostic write failures do not abort a run.

Real research tests normally clean up their application records. On an isolated
debug stack, `E2E_KEEP_RESEARCH_RECORDS=1` retains projects, sessions and model
records for later trajectory inspection; it does not change any assertion or
enable quality judging. Treat retained model configurations and model inputs as
private data and remove them explicitly when the investigation is complete.

Adapter INFO logs named `run-binding start` / `run-binding release` correlate
platform run/agent identifiers with the Swarm session and show whether a terminal
event was received. They omit tokens, endpoint URLs, prompts and tool arguments.
Older adapter results without `status` remain readable by the Node client, but
an explicit terminal `done` is always required.

Startup still bootstraps the existing shared default and prunes obsolete aliases
from older adapter instances. Per-run model binding requires patch `0006` on the
pinned Swarm version. Shared MCP discovery and tool-call run-tag adaptation are
unchanged; this is not a complete redesign of the tool transport.

Run focused patch checks with the patched Swarm environment:

```bash
PYTHONPATH=services/adapter/src:.sciencediscovery-data/jiuwenswarm/src \
  .sciencediscovery-data/jiuwenswarm/src/.venv/bin/python \
  -m unittest discover -s jiuwen_swarm/tests -v
```

The platform `sci` HTTP MCP connection uses a dedicated lifetime owner task.
It opens and closes the MCP SDK contexts in that same task and wakes pending
calls if the transport dies. This avoids a prewarm task owning contexts later
closed by another task. Other external MCP clients are unchanged.

The platform bridge has no independent HTTP read timeout: the configured
per-tool deadline remains authoritative. The SDK's default 300-second read
timeout otherwise disconnects long `task` calls before children return. A
single tool timeout cancels only that request, not its siblings or the shared
connection. A transport failure fails pending calls without replaying actions;
inspect the child/tool state before retrying.

Run the loopback transport regressions (no LLM or credentials required):

```bash
PYTHONPATH=.sciencediscovery-data/jiuwenswarm/src \
  .sciencediscovery-data/jiuwenswarm/src/.venv/bin/python \
  jiuwen_swarm/tests/test_sci_http_client.py
```

They cover the effective HTTP read deadline, concurrent result correlation,
isolated tool timeouts, transport failure propagation and explicit disconnect.

For the bounded literature integration check, use Swarm's native web tools
(`SCIENCE_AGENT_JIUWENSWARM_TOOLS=jiuwenswarm`) and ScienceDiscovery's specialist
delegation (`SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task`). This is distinct from
Swarm's default `subagent_spawn`, whose built-in child does not automatically
inherit the ScienceDiscovery specialist MCP bindings. Web provider selection
continues to use the existing Swarm settings adapter; these patches do not
add new providers or change the proxy-settings contract.

With `SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task`, the model sees the platform
`task` tool, not Swarm's native spawn/wait/list/send-input/close/resume tools,
even when the rest of Swarm's native toolset is enabled. Runs without delegation
capability likewise hide these native tools. The run prompt explicitly overrides
generic Swarm delegation instructions. This selection does not change the
default native-delegation mode or implement native-child progress forwarding.

Validation requires three observations: literature tools in the child's
actual LLM request, a successful literature MCP invocation, and leader
continuation after the child returns. A tool appearing in a registry or a
run being marked completed alone does not establish successful research.

## Regression tests

### Model tool-argument streaming

The Node model gateway forwards tool-call identity and JSON argument fragments
while they are generated, including OpenAI Chat Completions, OpenAI Responses,
and Anthropic Messages. Parallel calls keep separate indices. The terminal
response does not replay arguments already sent; providers that only return
complete calls retain a final-result fallback. Cancellation aborts the upstream
request. Invalid streamed arguments fail the request rather than executing a
partially generated tool call.

The Python route adapter also treats arguments as a stream: tool names are
prefixed once, and the authoritative `_sd_run` field is appended before the
final object brace. Only that trailing boundary is withheld, not the report
body. Approval summaries are assembled from complete arguments. Parallel calls
and separate HTTP responses have independent state; a model-supplied run tag
cannot override the platform's tag.

The pinned Swarm SDK merges anonymous argument fragments into the last call,
ignoring their indices. The platform compatibility patch corrects this merge
by tool index (identity fallback for legacy streams), preserving the SDK's
content, reasoning and usage merge. This prevents parallel calls from sharing
JSON tails. Remove the shim when upgrading to an SDK with indexed merging;
the regression test in `tests/test_platform_interaction.py` covers interleaved
fragments and metadata preservation. No installed SDK files are modified.

### Subagent concurrency

In **System settings → Quotas**, set **Maximum concurrent subagents** to an
integer from 1 to 10 (default 10). On a small server, start with 1. Click **Save**
or **Save and close** to persist the setting; cancel discards the draft. It is
stored as `maxConcurrentSubagents` in `/api/quota-settings` and takes effect for
new parent runs without restarting the server.

Platform `task` children in both Native and Swarm backends share a FIFO pool per
parent run. A permit is held until the child finishes, fails, times out or is
cancelled. Surplus calls wait before creating a child execution, so waiting does
not consume `timeout_seconds`; parent cancellation removes waiting calls. Pending
calls remain unfinished tool calls until admitted, not independently running
subagent records. The existing per-run total task limit is unchanged. This is
not a server-wide concurrency or memory limit: separate sessions have separate
pools, and Swarm's own native spawn mechanism is outside the platform `task` pool.

### Invalid tool argument diagnostics

Invalid model tool arguments produce a `[model-arguments]` warning with the gateway
request ID, tool-call IDs, tool names, token usage and truncation flag. Ordinary logs
exclude raw arguments and parser messages (which may quote private input).
For reproduction, set `SCIENCE_AGENT_INVALID_TOOL_ARGUMENTS_FILE=/private/path/invalid-arguments.jsonl`
on the Node API process before startup. The parent directory must exist and should
be private. This opt-in file includes parser errors and assembled raw arguments,
not API credentials or request headers; arguments themselves can contain sensitive
task data. Files use mode `0600`, rotate at 5 MiB with one backup, and record at most
20 failed calls per response. Arguments over 16,384 characters retain their head and
tail with an explicit `clipped` flag. This is the model client's assembled response,
not a raw upstream SSE capture; it does not by itself prove whether a provider or
stream assembler caused malformed JSON. Logging failures do not change task behavior.

Set `SCIENCE_AGENT_TRACE_MODEL_STREAM=1` on the Node API process to enable
`[model-stream]` diagnostics (restart required). They record a request ID and
model alias, upstream transport-chunk count, downstream delta count, tool
argument character count, elapsed time, and upstream/downstream idle time.
Progress logs are limited to once per five seconds; completion/error/cancellation
always emits a summary. Prompt text, arguments, responses and API keys are not
logged. This records actual progress and does not send synthetic heartbeats or
raise Swarm's model-stream timeout. A genuinely silent upstream can still fail.

### Approval and artifact handoff

Approval delivery stays inside the platform's external-wait interval. Failed
delivery terminates the active run explicitly instead of silently waiting for
an idle timeout; an already-cancelled run remains a no-op. The task wall-clock
deadline is unchanged. No failed action is automatically replayed.

Declared child artifacts carry a platform-recorded `subagentId`. The `task`
result includes their IDs, names and versions, including partial deliverables
from a failed child. Parents use `read_artifact`, not `read_file` on a child's
private path. No workspace is copied implicitly. Undeclared files and historical
artifacts without this metadata are not inferred from model prose.

Swarm has retired the legacy `HEARTBEAT.md` context file. The compatibility
patch excludes it from automatic context-file loading without creating an
empty file or suppressing other file errors. It does not disable Swarm's new
heartbeat scheduler or change explicit file-tool calls.

Adapter-to-Node HTTP failures log `legacy_proxy_failure` with a generated
request ID, method, path, phase (`headers` or `body`), elapsed time, exception
types and stack locations. A 502 response includes `requestId` for correlation.
Streaming responses include `x-sciencediscovery-request-id` for the same purpose.
Queries, headers, bodies and exception messages are excluded. A body-stream
failure is logged and the stream closes; already-sent headers cannot become
a 502. These diagnostics do not assert a cause for previous `ReadError`s and
do not add automatic retries.

Test the approval lease and context-file integration against the pinned SDK:

```bash
PYTHONPATH=.sciencediscovery-data/jiuwenswarm/src \
  .sciencediscovery-data/jiuwenswarm/src/.venv/bin/python \
  jiuwen_swarm/tests/test_platform_interaction.py
```

The patches are intentionally scoped to the pinned Swarm version. When upgrading
Swarm, review and rebase or remove them; do not assume a different tag contains
the same fixes. Patch application fails on an unexpected source state rather
than silently starting with a partly applied fix. An already running instance
must be restarted to load patched Python code.

Focused unit/integration checks (from the repository root):

```bash
uv run --project services/adapter --extra test pytest \
  services/adapter/tests/test_agent_runs.py \
  services/adapter/tests/test_gateway.py services/adapter/tests/test_events.py \
  services/adapter/tests/test_llm_proxy.py \
  services/adapter/tests/test_mcp_server.py
pnpm exec tsx --test packages/tools/src/registry.test.ts \
  packages/orchestration/src/subagents.test.ts
pnpm exec tsx --test services/api/src/agent-run/jiuwenswarm-agent.test.ts
```

The browser regressions use an **isolated** stack and data directory. Set
`E2E_BASE_URL` to its public adapter URL, `E2E_API_TOKEN` to its local access
token, and `E2E_SWARM_TASK=1` to acknowledge that it runs Swarm with platform
`task` delegation. The flag does not configure the backend: start the stack
with `--jiuwenswarm` and the delegation settings above first.

```bash
node test/sync-e2e.mjs --write
npm --prefix .e2e run test:mocked -- swarm-research-mocked.spec.ts
```

This Mock E2E uses a local scripted model, real Swarm loops, the platform MCP
bridge, real sandbox execution, artifact persistence and the browser UI. A
child command deliberately fails; the next call recovers, declares source
notes, and the parent continues to declare the final report. Scientific source
content is synthetic: this does not test public literature services or measure
model recovery intelligence. The CI Swarm stack enables this test automatically;
for an explicit local run, `CI_E2E_SPEC=swarm-research-mocked.spec.ts pnpm ci:e2e`
selects only this spec. The mocked journey remains in the default PR gate;
only the real research journey requires `E2E_RESEARCH=1`. Do not set that
real-research switch in PR gates.

`test/swarm-specialist-mcp-mocked.spec.ts` also runs in the default mocked gate.
It registers a custom Specialist and a real local stdio MCP echo server, binds
the connector only through the Specialist, and delegates through platform `task`.
Assertions inspect the actual child LLM system prompt and tool list, the MCP
result in child history, the handoff in the parent's next LLM input, persisted
Specialist identity/completion, and parent/child browser output. The model is
scripted; no public literature service or paid API is called. Temporary server,
Specialist, model and project are cleaned up after the test.

```bash
E2E_SWARM_TASK=1 npm --prefix .e2e run test:mocked -- swarm-specialist-mcp-mocked.spec.ts
```

The live test requires `E2E_REAL=1` and either a preconfigured live model ID in
`E2E_LLM_MODEL_ID`, or all three of `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL` and
`E2E_LLM_TOKEN`. Keys should come from the environment/secret store, never from
committed fixtures. It makes billable model calls and public-source requests.

```bash
E2E_RESEARCH=1 E2E_REAL=1 npm --prefix .e2e run test:real -- deepresearchbench-swarm.spec.ts
```

The live case uses DeepResearchBench task 59 (bird migration navigation), with
two bounded literature-specialist tasks (20 turns / 600 seconds each). It
checks child completion, successful literature MCP use, parent continuation,
a declared report and a nonempty final handoff. The test allows up to 18
minutes for the run and 20 minutes overall, then cleans up its project and any
model it registered. Its attachment records the run identity and terminal
metadata, **not a research-quality score**. It does not run the official DRB
grader, prove citation correctness, or reproduce the official leaderboard
protocol. Do not report a passing integration check as a benchmark score.

On memory-constrained hosts, build **before** starting the live stack and run
browser tests serially, without concurrent builds or test suites. Node's
`--max-old-space-size` does not bound the native TypeScript 7 compiler launched
by `tsc`; use an OS-level resource-limited test environment when a hard limit
is required. A host interruption is an incomplete test, never a passing run.

Additional opt-in gateway tests are in
`services/adapter/tests/test_gateway_live.py`: `agent_run_slow` checks a call
lasting more than the former 30-second fallback, and `agent_run_recover`
checks that a timed-out request does not poison the next run. Their module
docstring lists the local stub scripts and gateway configuration needed.

## Known boundaries

- The current-release delegation path is platform `task`, not Swarm-native
  `subagent_spawn`. Long-term ownership and reuse are discussed in
  [RFC #141](https://github.com/openJiuwen-ai/sciencediscovery/issues/141).
- A subagent's `timeout_seconds` is a hard wall-clock cap, including tool,
  model and approval waits; `max_turns` and timeout values may be set below
  their defaults for bounded retrieval work.
- HTTP keepalives maintain transport liveness, not agent progress. They do
  not reset agent idle limits or demonstrate that a tool is making progress.
- Actual model transport/text/thinking/tool-argument progress renews only the
  owning run's idle deadline, including run-scoped compaction. It does not
  extend the wall-clock cap. Default-route housekeeping is not evidence of
  progress for the latest active run and does not renew that run's deadline.
- Task turns are counted at model-request admission, before contacting the
  provider; UI events and parallel tool results do not consume extra turns.
  Title/default-route housekeeping and the pinned Swarm forked-compaction
  prompt are excluded. The latter is recognised by its explicit final
  instruction, since it retains tool schemas; a changed/unrecognised prompt
  counts as a task turn rather than bypassing the limit. This is a compatibility
  rule, not a security boundary. Provider retries inside one admitted request
  do not consume additional turns; a fresh task request does.
- Governed PDF downloads check a bounded 1 KiB prefix for a PDF header before
  publishing completion. An HTML login/error page is a non-retryable content
  validation failure, even with HTTP 200 or a PDF Content-Type. This is not
  full PDF validation: corrupt files with a PDF header still fail at extraction.
  Other artifact formats retain their existing download behavior.
- A bridge persistence/dispatch failure reports a non-retryable unknown
  outcome. The action may already have executed; inspect state before replay.
- External source failures (for example, an arXiv HTTP 406) are not repaired
  by these changes. They remain visible tool failures the model can handle.
