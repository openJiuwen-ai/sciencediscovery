# Runtime Architecture

This page describes the **current code paths only**. Historical migration designs are not implementation authority; when documents disagree, prefer `scripts/start-stack.sh`, `services/api/src/agent-run/create-agent-run.ts`, `services/adapter/`, `services/runner/`, and the architecture checker.

## 1. Two Agent executors, one control plane

ScienceDiscovery keeps Project, Session, permission, tool implementation, Artifact, provenance, and run-event authority in the Node control plane `services/api`. The Agent executor has two implementations:

| Executor | Selection | Where the loop runs | Public entry |
| --- | --- | --- | --- |
| Native | default in local source mode; or `SCIENCE_AGENT_EXECUTOR=native` | `services/api/src/native-agent/` | API directly on `:4310` |
| JiuwenSwarm | default in Docker/release; local with `--jiuwenswarm` | JiuwenSwarm, bridged by the ScienceDiscovery adapter | adapter `:4310`, API moves to `:4410` |

The important invariant is that **changing executor does not move authoritative product state out of the API**. `createAgentRun()` selects between `createNativeAgent` and `createJiuwenSwarmAgentFactory` through `defaultAgentFactory()`.

## 2. Current process topology

### 2.1 Native mode

```text
Browser
   │ REST / SSE :4310
   ▼
services/api
   ├─ Agent run orchestration
   ├─ native-agent loop
   ├─ tools / permissions / provenance / artifacts
   ├─ MCP clients / data sources
   └──────────────▶ services/runner :4311 ──▶ sandbox processes

optional/managed sidecars:
services/memory-graph :17674
services/evolve        :4313
services/paper         on-demand worker
Python MCP servers     on-demand stdio children
```

### 2.2 JiuwenSwarm mode

```text
Browser
   │ REST / SSE :4310
   ▼
services/adapter
   ├─ migrated /agent/* routes
   ├─ per-run MCP bridge
   ├─ per-run model proxy
   └─ reverse proxy for remaining routes
            │
            ▼
services/api :4410
   ├─ authoritative Project / Session / Run state
   ├─ tool construction, permission, Artifact, provenance
   ├─ createAgentRun()
   └─ JiuwenSwarm agent factory
            │ POST /agent/runs
            ▼
services/adapter
            │ WebSocket
            ▼
JiuwenSwarm gateway
   ├─ model calls ──▶ adapter /llm/<token>/v1 ──▶ API model gateway ──▶ provider
   └─ tool calls  ──▶ adapter /mcp/<token> ──▶ API loopback tool bridge
                                              └─▶ Runner / MCP / workspace / etc.
```

The adapter protocol and measured JiuwenSwarm behavior are documented in `services/adapter/README.md`. HTTP routes not migrated into the adapter are reverse-proxied to the TypeScript API.

## 3. Startup-mode matrix

`scripts/start-stack.sh` is the authority for source/Docker composition:

| Mode | Default executor | Adapter | API port |
| --- | --- | --- | --- |
| `--mode local` | native | not started | 4310 |
| `--mode local --jiuwenswarm` | JiuwenSwarm | 4310 | 4410 |
| `--mode docker` | JiuwenSwarm | 4310 | 4410 |
| `--mode docker --no-jiuwenswarm` | native | not started | 4310 |

The packaged single-file launcher follows the Docker default: JiuwenSwarm is the default executor.

Runner remains loopback-only on `:4311` by default in either executor.

## 4. Service and sidecar responsibilities

| Component | Shape | Current responsibility |
| --- | --- | --- |
| `apps/web` | static Web / dev server | UI, SSE rendering, permission cards, settings |
| `services/api` | resident Node | control plane, run orchestration, authoritative state, tools/permission/Artifact/provenance |
| `services/adapter` | resident Python in JiuwenSwarm mode | public front door, JiuwenSwarm run bridge, LLM/MCP adaptation, legacy API proxy |
| `services/runner` | resident Node | Bubblewrap/Seatbelt execution, scientific environments, optional NPU broker |
| `services/memory-graph` | optional resident Python | ScienceMemory graph service with local or Neo4j storage |
| `services/evolve` | resident sidecar when stack starts it | evolution search; business events/state remain API-owned |
| `services/paper` | on-demand Python worker | bounded PDF extraction |
| `services/gateway` | **not an HTTP service** | bundled Python MCP server code and interpreter environment |
| JiuwenSwarm | external/bundled runtime | conversation/loop implementation for the JiuwenSwarm executor |

Do not treat `services/gateway` as the current Agent gateway service, and do not treat deer-flow as a current runtime dependency.

## 5. Shared control-plane path for a Run

Both executors share the same control plane before `createAgentRun()` and after tool calls:

1. HTTP receives a Session message.
2. API resolves effective settings, model, Skills, Specialists, Connectors, Workspace, and permission state.
3. `runMainRequestExecution` / `runSubagentTask` build the execution context.
4. `createAgentRun(profile, bindings, input)` selects the executor.
5. The executor produces model events and tool calls.
6. Tool calls return to ScienceDiscovery-owned handlers, preserving permission, Runner, Artifact, MCP, and audit semantics.
7. API persists RunStreamEvent, messages, Prompt Manifest, Artifacts, and provenance.

Do not duplicate Project/Session/permission/artifact persistence when changing executors.

## 6. Package and service ownership boundaries

The key architecture rules are enforced by `scripts/check-architecture.mjs`:

- **Capability implementation belongs in `packages/`.**
- `services/` owns process entry points, HTTP/protocol adapters, and composition; it should not duplicate capability policy.
- `apps/web` owns browser UX, not authoritative business state.
- `packages/` may not import `services/` or `apps/`.
- production services may not depend on the old `@sciencediscovery/agent-runtime` compatibility facade.
- `packages/runtime-core` may use relative imports only and forms the lowest-level runtime contract.
- `packages/context` may depend only on `model` and `runtime-core`, preventing contributor extensions from creating cycles.
- executor → runner is the one explicitly frozen legacy package coupling; do not widen that exception.

The checker also forbids a list of removed `services/api/src/*` domain sources from reappearing after their ownership moved into capability packages.

Run before architectural changes:

```bash
pnpm architecture:check
```

## 7. Important composition seams

| Purpose | Code entry |
| --- | --- |
| API process | `services/api/src/server.ts` → `http/index.ts` |
| Agent Run | `services/api/src/agent-run/create-agent-run.ts` |
| Native executor | `services/api/src/native-agent/` |
| JiuwenSwarm executor | `services/api/src/agent-run/jiuwenswarm-agent.ts` |
| JiuwenSwarm front door | `services/adapter/src/sciencediscovery_adapter/` |
| Tool/runtime capability | `packages/tools`, `packages/workspace`, capability packages |
| Sandbox execution | `services/runner/src/server.ts` + `packages/executor` |
| Plugin contracts | `packages/plugin-sdk` |
| Context contributors | `packages/context` |
| Stack lifecycle | `scripts/start-stack.sh` |
| Architecture enforcement | `scripts/check-architecture.mjs` |

## 8. Architecture-change checklist

- Is this capability policy or process/protocol composition?
- Is there already an owning package?
- Do both native and JiuwenSwarm executors need adaptation?
- Does it change public/internal ports or sidecar lifecycle?
- Does it change authoritative Run/Tool/Artifact/Permission ownership?
- Does it add a package dependency edge, and does `pnpm architecture:check` pass?
- Does user-observable behavior require an E2E rather than only a unit test?

## Related documentation

- [Deep developer guide](developer-guide.md)
- [Control plane](control-plane.md)
- [Agent backend](agent-backend.md)
- [Plugin architecture](plugins.md)
- [Sandbox execution](sandbox-execution.md)
- [Repository layout](repository-layout.md)
