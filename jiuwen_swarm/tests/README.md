# MCP cross-framework boundary audit

The transport contract is larger than a successful tool call: a run must retain
its identity and tool policy, requests must remain correlated, one failure must
not unnecessarily stop other runs, cancellation must propagate, and failures
must be visible. Reconnecting must never replay an unknown-outcome action.

The Python boundary tests use the pinned Swarm/OpenJiuwen/MCP SDK, loopback HTTP
and the real adapter MCP router. Tool callbacks are controlled fixtures; no LLM
or external sources are used. Simulated parent/child waits test the transport
topology, not a complete Agent Loop. The separate browser cases below use actual
Swarm main/child loops with a local scripted model, not a paid model API.

## Execution

From the repository root, after installing the pinned Swarm environment:

```bash
PYTHONPATH=services/adapter/src:.sciencediscovery-data/jiuwenswarm/src \
  .sciencediscovery-data/jiuwenswarm/src/.venv/bin/python \
  -m pytest -q --tb=short jiuwen_swarm/tests

PYTHONPATH=services/adapter/src services/adapter/.venv/bin/python \
  -m pytest -q services/adapter/tests

pnpm --filter @sciencediscovery/api exec tsx --test \
  src/agent-run/jiuwenswarm-agent.test.ts
```

For the browser cases, start an isolated Swarm stack configured for platform
`task` delegation. Set `E2E_BASE_URL` to its API/UI and `E2E_API_TOKEN` to its
local access token, then run:

```bash
node test/sync-e2e.mjs --write
E2E_SWARM_TASK=1 npm --prefix .e2e run test:mocked -- \
  swarm-research-mocked.spec.ts swarm-specialist-mcp-mocked.spec.ts \
  swarm-tool-failure-mocked.spec.ts --workers=1 --retries=0
```

`E2E_SWARM_TASK` describes the actual backend; it does not switch a native stack
to Swarm. These cases intentionally skip without that backend prerequisite.
The September 23 audit supplied it, and executed all three cases. Paid API
credentials are not needed. Do not run fault injection against a shared user
installation.

The fault tests remain ordinary assertions. Do not mark them
`xfail`, skip them, or assert that all callers permanently fail just to turn
the suite green. The previous test that blessed permanent transport failure
has been replaced with diagnostic-log coverage and explicit recovery contracts.

## Coverage matrix

The status below records the September 23 local audit, before behavioral fixes
for the newly discovered faults.

| Boundary / fault | Assertions | Location | Status |
| --- | --- | --- | --- |
| Seven parents waiting while seven children return | Correlated results, reverse completion, exactly one execution | `test_mcp_boundary.py` | Pass |
| 100 concurrent requests | Correct result per request, no duplicate execution | `test_mcp_boundary.py` | Pass |
| Tool business exception | Error result; sibling and next call succeed | `test_mcp_boundary.py` | Pass |
| Independent run deadlines | Only expired callback cancelled; sibling and next call succeed | `test_mcp_boundary.py` | Pass |
| Caller cancellation and late response | No misrouting or poisoning of later calls | `test_mcp_boundary.py` | Pass |
| Retired run tag | No execution; active run remains usable | `test_mcp_boundary.py` | Pass |
| Tool discovery during a long call | Catalog refresh does not close the transport | `test_mcp_boundary.py` | Pass |
| HTTP 404 | Failed request remains local; no replay | `test_mcp_boundary.py` | Pass |
| HTTP 429 / 503 | Failed request must not kill healthy sibling | `test_mcp_boundary.py` | Fail |
| ConnectError / ReadError / PoolTimeout / WriteTimeout | Failed request must not kill healthy sibling | `test_mcp_boundary.py` | Fail |
| Invalid JSON response | Prompt protocol error, not waiting for execution timeout | `test_mcp_boundary.py` | Fail |
| New call after owner failure | New call can recover without replaying old calls | `test_mcp_boundary.py` | Fail |
| Explicit concurrent reconnect | Eight callers cause one initialization | `test_mcp_boundary.py` | Pass |
| Lost response after side effect | Explicit reconnect never repeats the action | `test_mcp_boundary.py` | Pass |
| MCP HTTP disconnect | Adapter callback receives cancellation promptly | `test_mcp_boundary.py` | Fail |
| Failed initialization | Explicit retry reconnects successfully | `test_mcp_boundary.py` | Pass |
| Approval continuation | Preserve MCP/workspace/model; independent decisions | Adapter `test_gateway.py`, `test_agent_runs.py` | Pass |
| Run registration and cleanup | No timeout-driven reconnect; reject policy conflicts; clean only own routes | Adapter `test_agent_runs.py` | Pass |
| Transport failure before Node bridge | Emit a failed tool event exactly once | API `jiuwenswarm-agent.test.ts` | Fail |
| Bridge result plus Swarm completion | One start/end, both success and business error | API `jiuwenswarm-agent.test.ts` | Pass |
| Diagnostic exception chain | Types/status/code locations survive; credentials do not | `test_sci_http_client.py` | Pass |
| Patch installation | Clean pinned source; apply twice; installed client equals shipped patch | `test_patch_installation.py` | Pass |
| Research browser workflow | Child tool error, recovery, artifacts, parent receipt, new run in same session | `test/swarm-research-mocked.spec.ts` | Pass |
| Custom Specialist browser workflow | Instructions/tool injection, dedicated MCP call, parent receipt, child UI | `test/swarm-specialist-mcp-mocked.spec.ts` | Pass |
| Pre-bridge failure browser workflow | Model receives validation failure and recovers; persisted trace and UI must retain the failure | `test/swarm-tool-failure-mocked.spec.ts` | Fail |

### Audit results

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Adapter (whole test directory) | 205 | 0 | 9 |
| Pinned Swarm patch / SDK boundary tests | 38 | 9 | 0 |
| Node Swarm agent adapter (whole test file) | 74 | 1 | 0 |
| Selected browser workflows (actual Swarm, scripted model) | 2 | 1 | 0 |

The nine adapter skips are existing opt-in live cases, not newly suppressed
failures. This table preserves the original red baseline, not the repaired
results below. A browser test initially
had fixture/authentication setup errors; those were corrected before attributing
the remaining missing-trace failure to the product.

## Repair implementation

### Repaired regression results (September 23)

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Adapter | 206 | 0 | 9 existing opt-in cases |
| Pinned Swarm patch / SDK boundary tests | 51 | 0 | 0 |
| Node Swarm agent adapter | 76 | 0 | 0 |
| Browser workflows (actual Swarm, scripted model) | 4 | 0 | 0 |

The browser cases include research artifacts, custom Specialist/MCP, validation
failure visibility, and injected HTTP 503 recovery while an unrelated child
continues running on the same shared connection. The concurrent fixture uses an
explicit foreground `wait_ms`; a default short foreground wait would return a
background execution handle and would not test the intended pending request.
API compilation and Markdown checks also pass. No paid LLM was called in this
repair verification; these results are not a DeepResearchBench quality score.

### Scope

The repair keeps shared MCP registration and the existing delegation design.
It changes only the platform `sci` client's transport, the adapter endpoint, and
the Node event/abort bridge:

- The platform transport retains SDK `ClientSession` and JSON-RPC types. Each
  HTTP response is checked against its request id; HTTP/network/JSON failures
  become correlated errors. The adapter's endpoint is JSON-only and stateless;
  this is not a replacement for arbitrary third-party SSE MCP transports.
- New calls may reconnect a failed owner under the lifecycle lock. Cancelling
  one connection waiter does not cancel shared initialization. An explicit
  disconnect does not automatically reopen, and old calls are never replayed.
- The pinned SDK does not send cancellation on abandoned request waiters. The
  platform session supplies it; the transport closes only that request. The
  adapter waits for ASGI disconnect, cancels its outbound bridge request, and
  Node aborts the corresponding tool. Explicit cancellation ids are scoped by
  connection so two clients using the same JSON-RPC id cannot cancel each other.
- Node reports an unclaimed platform call's Swarm failure once. Bridge-owned
  results remain authoritative; successful/failed duplicate completions do not
  create another tool event. Cancelled queued calls never start execution.
- A cancellation or response loss does not imply rollback. Unknown execution
  outcomes instruct the model to inspect state rather than blindly retry.

The browser HTTP-fault case requires an additional **test-only** proxy. Before
starting the isolated stack, run this fixture in a separate terminal:

```bash
node test/fixtures/swarm-mcp-fault-proxy.mjs
```

Set `SCIENCE_AGENT_ADAPTER_PUBLIC_URL=http://127.0.0.1:4685` on that stack and
`E2E_MCP_FAULT_PROXY=1` on the browser test. Defaults forward to port 4680;
`E2E_MCP_PROXY_PORT` and `E2E_MCP_PROXY_TARGET` configure other loopback ports.
The proxy rejects one specially marked shell call with HTTP 503 before dispatch,
and passes everything else unchanged. It must never be used in a user deployment.
No fault-injection switch was added to production code.

## Original root-cause boundaries (before repair)

### Request failure becomes shared failure

The SDK's `StreamableHTTPTransport.post_writer` schedules HTTP requests in a
shared task group. Unhandled HTTP/transport exceptions escape a request and tear
down that group. The platform client's `_serve` then exits and its `_request`
waiters fail together. Local injection reproduces this across multiple exception
classes; increasing a timeout cannot repair this fault domain.

`SciHttpClient._request` rejects all later calls while the owner remains failed.
Explicit `connect()` can recover, but ordinary calls do not invoke it. Recovery
must be serialized and must distinguish a **new invocation** from a replay of
an action whose response was lost.

### Cancellation stops at the adapter HTTP endpoint

An SDK transport disconnect closes HTTP requests, but a normal FastAPI handler
awaiting `handle_rpc` does not automatically cancel its tool callback. The Node
bridge has an abort-on-disconnect hook, yet the adapter's outbound HTTP request
can remain alive, so that hook is not necessarily reached. Test both links;
local cancellation of an adapter stream alone is insufficient coverage.

### Failure can disappear before the UI

The Node event forwarder reports Swarm-native tools from the event stream and
normally reports platform tools from their execution bridge to avoid duplicates.
It discards platform `tool.completed` events. When failure occurs before the
bridge is reached, there is no fallback reporter. The model can receive a tool
failure while the platform trajectory has no corresponding failed-tool event.
The new API test feeds that exact event ordering through the actual Agent
factory; it currently fails. A fix must preserve exactly-once reporting for
ordinary successful bridge calls as well.

The browser regression independently exercises a malformed `run_shell` call in
a real Swarm child. The scripted model receives the error, a subsequent valid
shell call succeeds, the child completes, and the parent receives its result.
Nevertheless, the failed invocation is absent from the persisted child steps
and the expanded child tool cards do not show its actual validation error.
This reproduces the reporting gap without relying on a transport outage or a
model making a particular choice. It does not prove recovery from HTTP 503.

### Earlier repairs and what they did not cover

Approval continuation and per-run tool deadlines fixed loss of run context and
deadline-driven shared transport reconfiguration. Their regression tests still
pass. They did not isolate network exceptions raised inside the SDK task group,
add new-call reconnection, or bridge pre-dispatch failures into Node events.
Previously testing each side independently also missed the cancellation gap
between inbound MCP HTTP and the adapter's outbound execution request.

## Evidence and remaining uncertainty

The stopped real DRB-59 run first reported the shared transport failure around
08:37:12 (Asia/Shanghai), September 23. Parent and child sessions failed on the
same shared client. No second `mcp.disconnect` / `mcp.delete_custom` occurred
after startup. Platform histories recorded failures that were absent from the
platform's failed-tool events. Native web fetching continued on its separate
path; continued activity was not evidence that the platform MCP was healthy.

The initiating transport exception was not logged. `ClientDisconnect` in the
adapter log is evidence of a disconnected request, not proof of the initiator.
**A simulated HTTP 503 is not evidence that the historical run received 503.**
The original exception cannot be reconstructed from the generic wrapper alone.
The diagnostic patch now logs nested exception types, HTTP status and stack
locations without exception messages, URLs, headers, payloads or frame locals.

## Acceptance and remaining limits

Required regression contracts:

- Pass the red request-isolation, recovery, cancellation and visibility tests.
- Translate request-level HTTP/protocol errors into correlated failures rather
  than letting one request tear down unrelated requests. Invalid JSON must fail
  promptly, not wait for the full execution timeout.
- Serialize connection recovery for new calls. Never automatically replay a
  call with an unknown execution outcome, especially writes or child dispatch.
- Propagate MCP disconnect through the adapter's outbound HTTP request to the
  Node tool abort signal, without cancelling unrelated requests.
- Report pre-bridge failures exactly once, retaining the successful bridge
  deduplication checks and the failed-tool browser regression.
- Exercise business/validation and HTTP failures through actual Agent Loops and
  browser UI, including an unrelated active child on the shared connection.

Remaining limits, not claimed as covered by a passing local test suite:

- Concurrent human approvals combined with transport loss still need a full
  browser journey; the existing approval/context tests exercise adapter behavior.
- Complete socket/owner loss and lost-response side effects are covered at the
  real HTTP/SDK boundary, not yet as full browser workflows.
- Capture the first original exception if the historical trigger recurs. Only
  then attribute that initiating fault to a specific network/server/SDK cause.
- Rerun paid research only after deterministic checks pass. Preserve failed
  reports and unknown-outcome actions; never silently retry side effects.

## Output limit recovery

Platform runs install a per-instance model-boundary wrapper. The gateway holds
all tool arguments until the response finishes; `length` withholds every call,
including syntactically valid ones. SSE comments maintain transport activity
while arguments are buffered. Text/thinking can still stream for observability.
The original response and usage remain in the private trajectory.

The wrapper never returns a truncated response to the ReAct execution loop. It
adds bounded recovery guidance and allows at most two additional model calls.
Retries use the same context, model, turn admission, cancellation and deadline;
there is no automatic token-budget increase. No incomplete tool-call messages
are replayed. Ordinary transport/provider errors do not enter this retry path.
Unrecovered partial answers fail rather than appear completed. Existing
artifacts remain available to the parent; failure diagnostics identify the
truncation kind, attempts and that current-turn tools were not executed.

`test_output_recovery.py` covers this boundary and drives the real ReAct loop
with controlled model responses to verify that only the recovered tool call
executes. Gateway tests separately cover streaming/unary withholding and usage.
Look for `[output-recovery]` in the Swarm log and `output_recovery_exhausted` in
the task error. This is a bounded recovery attempt, not a completion guarantee.
