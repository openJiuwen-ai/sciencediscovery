# Agent Backend: Native Executor

**Status: Current native executor implementation**

This page describes only the **native executor** under `services/api/src/native-agent/`. All launchers default to JiuwenSwarm; select native with `--no-jiuwenswarm` or `SCIENCE_AGENT_EXECUTOR=native`. See [Runtime architecture](architecture.md) for executor selection and the shared control plane.

For the JiuwenSwarm path, use these sources of truth:

- `services/api/src/agent-run/jiuwenswarm-agent.ts`
- `services/api/src/agent-run/jiuwenswarm-model-gateway.ts`
- `services/adapter/`
- `services/adapter/README.md`

## 1. Executor seam

All main/subagent runs reach:

```text
createAgentRun(profile, bindings, input)
```

in:

```text
services/api/src/agent-run/create-agent-run.ts
```

`defaultAgentFactory()` selects:

```text
native       → createNativeAgent
jiuwenswarm  → createJiuwenSwarmAgentFactory
```

Keep `createAgentRun` executor-neutral; native-only behavior belongs under `native-agent/`.

## 2. Native executor code

`services/api/src/native-agent/` currently contains:

| File | Responsibility |
| --- | --- |
| `index.ts` | `NativeAgent`, loop, tool dispatch, deadlines, context/model interaction |
| `versioning.ts` | run/versioning snapshots and authority records |
| `native-agent.test.ts` | core native-loop tests |
| `context-assembly.integration.test.ts` | context/native integration |
| `versioning.test.ts` | versioning behavior |

Much of the capability comes from packages rather than this directory itself:

- `@sciencediscovery/model`
- `@sciencediscovery/context`
- `@sciencediscovery/tools`
- `@sciencediscovery/workspace`
- plugin runtime contributions

## 3. Native run data flow

```text
API run orchestration
       │
       ▼
createAgentRun(...)
       │ native factory
       ▼
NativeAgent.execute(prompt)
       │
       ├─ assemble context
       ├─ stream model turn
       ├─ emit text/thinking/usage events
       ├─ parse tool calls
       ├─ execute tool handlers
       ├─ append tool results
       └─ repeat until no calls / abort / timeout
       │
       ▼
finalMessages
```

Real infrastructure is injected through API bindings. Native executor does not own Project/Session persistence, permission persistence, or Runner lifecycle.

## 4. Context and system prompt

Native execution composes:

- Workspace system prompt;
- run contract;
- context contributors;
- Skills / durable context;
- deferred-tool metadata;
- MCP routing hints;
- Agent history.

Dynamic context machinery is owned by `packages/context`; see [Dynamic context assembly](context-assembly.md).

When changing prompt/context behavior, also inspect `packages/context`, `packages/workspace`, capability-plugin contributors, native integration tests, and whether JiuwenSwarm model/tool proxy semantics need equivalent behavior.

## 5. Model transport

Native executor uses the ScienceDiscovery model layer to call the configured endpoint and maps streaming deltas to Agent events.

Product semantics include provider/protocol variants, thinking controls, proxy policy, usage accounting, provider-specific assistant history, abort, and timeout.

JiuwenSwarm does not intentionally bypass these product semantics: its model requests are routed through the ScienceDiscovery per-run model gateway/proxy path.

### Model wire diagnostics

Every streamed model request emits one `[model-sse-summary]` JSON line. The
record carries the local request ID, the provider request ID when the response
headers expose one, scheme-and-host endpoint identity, model alias, HTTP status,
retry count and per-attempt failure classes, dispatch/headers/first-byte/first-
SSE-record/completion timestamps, transport and SSE record counts, parse-error
count, `finish_reason`, truncation, whether any text or tool call was
assembled, and whether the provider streamed reasoning text (`hasReasoning`). It
never contains prompts, response text, tool arguments, request headers or
credentials. `onWireDiagnostics` carries the same record in-process;
the native loop and the JiuwenSwarm gateway log it, so the real-E2E
`stack.log` keeps per-request evidence.

A request that ends in an error carries its `error.classification` on that same
line, including an empty completion: the gateway holds the record until the
outcome is known, so a 502 never leaves an unclassified success line behind.

A completed task turn with no non-whitespace text and no tool call is an error,
not a final answer, even when the provider reports `finish_reason=stop`. The
runtime client and the gateway both enforce this rule, so an alternate streamer
cannot silently deliver an empty result. The two shapes that would otherwise
look identical are separate classifications as well as separate `hasReasoning`
values: a reasoning model that spent its whole budget thinking and answered
nothing is `reasoning_only` (`hasReasoning: true`), and a relay that returned an
empty `stop` is `empty_completion` (`hasReasoning: false`). Both still fail the
request; only the recorded class differs. A turn cut at the output limit
keeps the existing truncation recovery path. The error message preserves the
wire summary (request IDs, status, record counts, finish reason, reasoning
presence) and no payload.

For a controlled relay/direct comparison, use
`node scripts/model-endpoint-compare.mjs --model <alias> --a-base-url … --b-base-url … --prompt-file …`;
both endpoints receive one identical request body, requests are interleaved,
credentials come from token environment variables, and the report contains only
per-request latency, error and token aggregates.

## 6. Tool dispatch

Native executor executes the ScienceDiscovery tool table after model tool calls.

Important invariants:

- concurrency is allowed where the tool contract permits it;
- results enter history in call order;
- argument failures become structured tool errors rather than crashing the run;
- handler exceptions become structured failures;
- hidden deferred tools require discovery first;
- repeated calls have loop protection;
- abort signals reach model and tool execution.

Tool policy, permission, Runner, MCP, and Artifact/provenance persistence are not owned by the native loop.

## 7. Deadlines and external waits

Native executor distinguishes:

- total run deadline;
- no-progress idle timeout;
- explicit cancellation;
- external waits such as permission/subagent work.

`beginExternalWait()` pauses the run deadline so time spent waiting for a human or child Agent is not incorrectly counted as active main-Agent time.

Timeout wording participates in subagent failure classification; inspect tests before changing it.

## 8. History and version records

Native executor retains assistant/tool messages and returns `finalMessages` to the control plane.

Versioning freezes authorities that influenced a trajectory rather than duplicating Session persistence, including plan, resources, tool policy, budget, and external version refs.

Relevant code:

- `native-agent/versioning.ts`
- `agent-run/versioning-authorities.ts`
- Prompt Manifest / provenance code

## 9. Semantics shared with JiuwenSwarm

For product behavior rather than a native-only optimization, check both paths:

| Semantic | Native | JiuwenSwarm |
| --- | --- | --- |
| Project/Session authority | API | API |
| Tool implementations | ScienceDiscovery bindings | adapter MCP bridge → same bindings |
| Permission | ScienceDiscovery | ScienceDiscovery tool bridge |
| Artifact/provenance | ScienceDiscovery | ScienceDiscovery tool bridge |
| Model provider semantics | product model client | adapter/API model gateway |
| Run events | native AgentEvent mapping | adapter frame mapping |
| Cancel/timeout | native executor | JiuwenSwarm agent adapter |

Changing only `native-agent/index.ts` does not imply packaged-product behavior changed.

## 10. Tests

Start with:

```bash
pnpm --filter @sciencediscovery/api test
```

Important tests:

- `native-agent/native-agent.test.ts`
- `native-agent/context-assembly.integration.test.ts`
- `native-agent/versioning.test.ts`
- `agent-run/create-agent-run.test.ts`
- `agent-run/jiuwenswarm-agent.test.ts`
- `agent-run/jiuwenswarm-model-gateway.test.ts`

User-observable changes also require the relevant E2E/journey.

## 11. Retired architecture

Do not reintroduce:

- Python gateway as the main Agent loop;
- deer-flow as current Agent runtime;
- Node API handing an entire turn to gateway through the old `POST /run`;
- gateway using the old `/internal/tool-exec` as the universal tool callback;
- assumptions that every production deployment uses native.

Compatibility names may remain in fields or environment directories; they do not imply the retired service boundary still exists.

## Related documentation

- [Runtime architecture](architecture.md)
- [Control plane](control-plane.md)
- [Dynamic context assembly](context-assembly.md)
- [Plugin architecture](plugins.md)
- `services/adapter/README.md`
