# Swarm compatibility patches

`scripts/jiuwenswarm.sh` applies the versioned patches in `patches/<tag>/` to
the pinned checkout before starting it. These changes repair runtime binding
and transport bugs; research business logic remains in ScienceDiscovery.

For `workswarm0.2.6`:

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
  approval question ID. When an approval starts a replacement request, the
  adapter ignores late terminal events from the superseded stream
  before they can mark the logical run finished or release its model/MCP
  bindings. Late tool results and usage remain observable. Gateways without
  this metadata retain the older pause guard but
  cannot reliably distinguish interleaved stream completions; use the pinned
  patch when running this integration.
- `chat.error`, `execution.error`, `runtime.error` and `error` are terminal
  failures: the adapter reports them without waiting for a later completion
  marker or the platform idle timeout. Transport heartbeats are not progress.

Set `SCIENCE_AGENT_TRACE_TOOLS=1` on the adapter to log `[tool-contract]`
records containing expected, incoming Swarm, and outgoing LLM tool names.
Calls with no tools can be model capability probes, not agent reasoning
steps. This diagnostic does not log API keys, prompts or tool arguments.
Inspect the model-bearing agent call, not a probe, when checking missing tools.

Run focused patch checks with the patched Swarm environment:

```bash
PYTHONPATH=.sciencediscovery-data/jiuwenswarm/src \
  .sciencediscovery-data/jiuwenswarm/src/.venv/bin/python \
  jiuwen_swarm/tests/test_dynamic_bindings.py
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

Validation requires three observations: literature tools in the child's
actual LLM request, a successful literature MCP invocation, and leader
continuation after the child returns. A tool appearing in a registry or a
run being marked completed alone does not establish successful research.

## Regression tests

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
`CI_E2E_SPEC=swarm-research-mocked.spec.ts pnpm ci:e2e` selects only this spec.

The live test requires `E2E_REAL=1` and either a preconfigured live model ID in
`E2E_LLM_MODEL_ID`, or all three of `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL` and
`E2E_LLM_TOKEN`. Keys should come from the environment/secret store, never from
committed fixtures. It makes billable model calls and public-source requests.

```bash
E2E_REAL=1 npm --prefix .e2e run test:real -- deepresearchbench-swarm.spec.ts
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
- A bridge persistence/dispatch failure reports a non-retryable unknown
  outcome. The action may already have executed; inspect state before replay.
- External source failures (for example, an arXiv HTTP 406) are not repaired
  by these changes. They remain visible tool failures the model can handle.
