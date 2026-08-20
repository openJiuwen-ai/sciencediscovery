# Runtime Core boundaries

`@sciencediscovery/runtime-core` is the stable, domain-neutral execution kernel.
It owns the Agent Loop state machine and only the invariants common to every
agent execution:

- assemble context, invoke a model, execute requested tools, and repeat;
- execute tool calls from one model turn concurrently while committing their
  results in the original call order;
- maintain canonical history and assistant/tool-call pairing;
- observe cancellation, represent independent external waits, enforce a
  caller-supplied model-turn bound, and emit one terminal result.

The runtime depends on four ports and has no product package dependencies.
`RuntimeBuilder` is its typed registration surface; it rejects incomplete
composition and freezes a run's port registry before execution:

- `ContextAssembler` produces the authoritative history and opaque model input;
- `ModelClient` performs one normalized model turn;
- `ToolDispatcher` applies tool policy and returns a canonical history message;
- `RunEventSink` projects neutral lifecycle events to logs, SSE, or metrics.

`services/api/src/bootstrap/runtime.ts` is the composition root. Its
native-agent adapter wires the ports to prompt construction, history
compaction, model transport, the tool registry, permission gates, provenance
hooks, and SSE events. These policies deliberately remain outside Runtime
Core. A
subagent is dispatched through the existing `task` tool, so the core does not
define a separate agent-dispatch path.

The dependency direction is:

```text
apps -> services/api -> capability adapters -> packages/runtime-core
```

Capability code may implement Runtime Core ports. Runtime Core must never
import HTTP/SSE, provider clients, tools, MCP, permissions, artifacts,
provenance, specialists, or other ScienceDiscovery domain packages.

Current capability ownership:

- `packages/context`: `DefaultContextAssembler`, prompt/context construction,
  and history compaction;
- `packages/model`: `ProviderModelClient`, provider-neutral model types,
  normalized streaming transport, proxy, timeout, and retry policy;
- `packages/tools`: frozen tool registry, deferred discovery, remote-content
  sanitization, error normalization, and loop policy;
- `packages/workspace`: workspace paths and workspace tool implementations;
- `packages/orchestration`: AgentRun profiles, lifecycle contracts, and
  subagent configuration;

The former private `packages/agent-runtime` aggregate has been removed after
all repository imports were migrated to their owning capability package; no
compatibility service locator or duplicate runtime remains.

Permissions, provenance, artifacts, data sources, and specialists remain
domain services/adapters and enter execution only through registered tools or
events. They are not allowed to add control branches to Runtime Core.

`pnpm architecture:check` enforces the direction: packages cannot import
`services`/`apps`, production services cannot use the compatibility facade,
and Runtime Core cannot use non-relative imports.
