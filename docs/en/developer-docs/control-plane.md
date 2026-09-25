# Control Plane: services/api

`services/api` is ScienceDiscovery's **authoritative product control plane**. It owns Project / Session / Run lifecycle, effective configuration, permissions, tool bindings, Artifact/provenance orchestration, product persistence, and Agent-executor selection.

It is not synonymous with the native Agent loop. Native and JiuwenSwarm both attach through the same Run seam.

## 1. Process entry and composition root

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | Node process entry; starts/closes the HTTP server |
| `src/http/index.ts` | HTTP composition root: routes, platform services, static Web, run entry |
| `src/store.ts`, `src/store/` | authoritative Project / Session / Run / settings / secret catalog state |
| `src/runs/` | Session Run state, SSE streams, event persistence/recovery |
| `src/agent-run/` | executor seam, main/subagent orchestration, workspace bindings, deadlines |
| `src/native-agent/` | native executor, only one of two executors |
| `src/plugins/` | host composition/control for capability plugins |
| `src/evolution/` | control-plane routes and model proxy for evolve |
| `src/reviewer-specialist/` | API-level Reviewer orchestration and evidence gateways |
| `src/artifacts/`, `src/subagents/`, `src/permissions/` | product-level orchestration; lower capability ownership still prefers packages |

Use `src/http/index.ts` and its route handlers as the route authority.

## 2. Executor seam

Shared path:

```text
runMainRequestExecution / runSubagentTask
             │
             ▼
createAgentRun(profile, bindings, input)
             │
      defaultAgentFactory()
        ┌────┴──────────────┐
        ▼                   ▼
createNativeAgent   createJiuwenSwarmAgentFactory
```

`create-agent-run.ts` selects the executor from `jiuwenSwarmConfigFromEnv()`.

- local source defaults to native;
- local `--jiuwenswarm` selects JiuwenSwarm;
- Docker/release defaults to JiuwenSwarm;
- tests may inject a double with `bindings.createAgent`.

`createAgentRun` should remain executor-neutral. It maps `AgentProfile`, Workspace bindings, tool policy, budgets, context contributors, versioning authority, and abort lifecycle into one `AgentRunHandle`.

## 3. Authoritative Run lifecycle

Product state machine:

```text
queued → running ⇄ blocked → completed | failed | cancelled | interrupted
```

Typical main run:

1. HTTP validates Session/model/request.
2. Resolve effective Project/Session settings and resources.
3. Create RequestExecutionContext with execution id, permission runtime, abort signal, versioning authorities.
4. Build Workspace/plugin/tool bindings.
5. Call `createAgentRun()`.
6. Executor emits Agent events and tool calls.
7. Tools execute through ScienceDiscovery bindings, preserving permission, Runner, MCP, Artifact, and provenance behavior.
8. Persist Run events and expose them through SSE.
9. Persist terminal state and clean pending permissions/resources.

`blocked` waits for external approval. `interrupted` marks historical runs recovered after abnormal process termination.

## 4. Control plane remains authoritative in JiuwenSwarm mode

The adapter is not a replacement backend:

- adapter is public front door and protocol adapter;
- API still owns Project / Session / Run / permission / Artifact state;
- API builds the run tool table and runtime bindings;
- `createJiuwenSwarmAgentFactory` sends the run to adapter;
- adapter exposes tools through a per-run MCP server;
- JiuwenSwarm tool calls return through adapter to the API loopback tool bridge;
- model calls pass through adapter/API model proxy so ScienceDiscovery provider semantics remain;
- adapter frames map back to ScienceDiscovery Run events.

When adding behavior, decide whether it belongs to:
- executor-independent control plane;
- native executor;
- JiuwenSwarm adapter;
- capability package.

Do not duplicate Session/Artifact/permission persistence in the adapter.

## 5. HTTP and events

The HTTP surface covers Project/Session/settings, Session messages and Runs, SSE and replay, cancel, models/specialists/skills/libraries/environments, MCP/Connectors/Artifact jobs, permission/quota/timeout/sandbox network, Reviewer/evidence/papers, evolution/Idea Tree/memory and related resources.

Run events are a stable observable product interface. Event-shape changes must align schema, API producers, adapter mapping when applicable, Web consumers, and tests/E2E.

## 6. Capability composition

API should not become the implementation home for every capability.

Current direction:

```text
packages/* capability
       │ public contracts / plugins / ports
       ▼
services/api composition
       │
       ├─ native executor
       └─ JiuwenSwarm bridge
```

Typical owners include `tools`, `workspace`, `governance`, `executor`, `skill`, `specialist`, `mcp`, `mcp-sources`, `data-source`, `artifact-manager`, `artifact-json`, `provenance`, `memory`, `evolve`, and `idea-tree`.

`scripts/check-architecture.mjs` explicitly prevents several migrated service-domain sources from reappearing.

## 7. Runner channel

Runner is a separate execution boundary. API/executors use Runner clients from `packages/executor` for shell/language execution, managed environments, status/log/cancel, remote Runner/SSH provisioning, and optional NPU workloads.

See [Sandbox execution](sandbox-execution.md) for protocol/auth/sandbox details.

## 8. Storage

Authority spans several stores:

- SQLite catalog: Project, Session, Run, messages, settings, models, permissions;
- Workspace files;
- CAS/versioning;
- append-only/file audit: run events, execution runs, Prompt Manifest, usage, connector/MCP/provenance records;
- sidecars for specialized/derived state such as the memory graph.

See [Storage layout](../reference/configuration.md#storage-layout).

## 9. Change checklist

Check:

- Is capability policy being put back into API incorrectly?
- Do native and JiuwenSwarm executors preserve the same semantics?
- Are Run-event and Artifact semantics stable?
- Does permission external-wait / timeout behavior change?
- Are recovery, cancel, or serialization affected?
- Is a new package dependency edge introduced?
- Are adapter contract tests or E2E required?

Run:

```bash
pnpm architecture:check
pnpm --filter @sciencediscovery/api test
```

## Related documentation

- [Runtime architecture](architecture.md)
- [Native Agent backend](agent-backend.md)
- [Repository layout](repository-layout.md)
- [Plugin architecture](plugins.md)
- [Sandbox execution](sandbox-execution.md)
