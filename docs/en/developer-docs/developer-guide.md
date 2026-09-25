# Deep Developer Guide

This guide is for developers and code agents modifying ScienceDiscovery. Its goal is not product education; it is a fast map of the **current implementation**, so historical designs and compatibility directories do not become accidental architecture.

## 1. Recommended reading order

1. [Runtime architecture](architecture.md)
   - Understand native/JiuwenSwarm executors, adapter, API, Runner, and sidecars.

2. [Repository layout](repository-layout.md)
   - Understand capability ownership, service composition, and code entry points.

3. [Control plane](control-plane.md)
   - Understand Project / Session / Run lifecycle, permission, storage, and product orchestration.

4. [Agent backend](agent-backend.md)
   - Dive deeper only when changing the native executor or executor seam.

5. [Plugin architecture](plugins.md)
   - Check ownership and extension points before adding cross-product capability.

6. Target subsystem docs:
   - execution → [sandbox-execution.md](sandbox-execution.md)
   - MCP → [mcp-tool-protocol.md](mcp-tool-protocol.md)
   - context → [context-assembly.md](context-assembly.md)
   - subagent → [subagent-orchestration.md](subagent-orchestration.md)
   - provenance/review → [review-provenance.md](review-provenance.md)
   - memory → [science-memory.md](science-memory.md)
   - evolution → [evolve-standalone.md](evolve-standalone.md)

## 2. Five current architecture facts

### 2.1 API is the authoritative product control plane

`services/api` owns:

- Project / Session / Run lifecycle;
- permission;
- tool bindings;
- Artifact / provenance;
- model/resource configuration;
- executor selection;
- product persistence.

Using the JiuwenSwarm executor does not transfer this authority into the adapter or JiuwenSwarm.

### 2.2 Agent executor is replaceable

Current executors:

- **native**: `services/api/src/native-agent/`
- **JiuwenSwarm**: `services/api/src/agent-run/jiuwenswarm-agent.ts` + `services/adapter/`

The shared seam is `services/api/src/agent-run/create-agent-run.ts`.

Local source defaults to native; Docker/release defaults to JiuwenSwarm.

### 2.3 Runner only owns execution

`services/runner` owns sandbox execution, scientific environments, and the optional Host NPU Broker.

Do not move product decisions, Agent policy, Artifact semantics, or authoritative product state into Runner.

### 2.4 packages own capabilities

Reusable/domain behavior belongs in `packages/`. Services own:

- process entry;
- protocol adaptation;
- dependency injection;
- lifecycle;
- composition.

`scripts/check-architecture.mjs` enforces important parts of this boundary.

### 2.5 Web is not authoritative state

`apps/web` consumes API state and renders UX. Browser-local state must not define backend business facts.

## 3. Questions to answer before editing

1. **What is the user-visible entry?**
   - HTTP route, Tool, Plugin, UI action, CLI, sidecar protocol?

2. **Who owns the capability?**
   - existing package, or genuinely new package?

3. **Where is the composition seam?**
   - API binding, plugin port, executor factory, Runner client, sidecar client?

4. **Do both executors change?**
   - must native and JiuwenSwarm preserve the same tool/permission/Artifact semantics?

5. **Where is authoritative state?**
   - SQLite, file audit, CAS, sidecar, or derived state?

6. **Where should tests live?**
   - package unit, service contract, adapter live, or user-journey E2E?

## 4. Fast code navigation

| Change | Start here |
| --- | --- |
| HTTP/API behavior | `services/api/src/http/index.ts` |
| Run lifecycle | `services/api/src/agent-run/orchestrators.ts` |
| executor selection | `services/api/src/agent-run/create-agent-run.ts` |
| native Agent loop | `services/api/src/native-agent/` |
| JiuwenSwarm integration | `services/adapter/` + `jiuwenswarm-agent.ts` |
| Tool contracts | `packages/tools` |
| Workspace tools/prompt | `packages/workspace` |
| Context | `packages/context` |
| Plugins | `packages/plugin-sdk` + owning capability plugin |
| Governance | `packages/governance` |
| local/remote execution | `packages/executor` + `services/runner` |
| Skills | `packages/skill`, `packages/specialist`, `services/api/src/skill-library-catalog.ts` |
| Artifact/download | `packages/artifact-manager`, `packages/artifact-json`, API artifact composition |
| Memory | `packages/memory` + `services/memory-graph` |
| Evolution | `packages/evolve` + `services/evolve` + API evolution routes |

## 5. Required checks

For architecture/capability changes, start with:

```bash
pnpm architecture:check
pnpm typecheck
```

Then run target package/service tests.

For user-observable changes, add or run the matching user journey; unit tests alone are not completion.

Repository-wide and documentation checks:

```bash
pnpm check
pnpm docs:check
```

`docs:check` runs Markdown lint and repository documentation-link validation.

## 6. Documentation authority

Developer-document priority:

1. current implementation architecture/module docs;
2. current source and tests;
3. service-local README files such as adapter README;
4. historical design records.

When docs conflict with code, verify code first and update the docs.

This cleanup removes explicit MVP/M1/M2 phase-delivery documents so code agents do not mistake old milestones for current implementation.

## 7. Avoid these mistakes

- Do not infer ownership from directory names.
- Do not recreate capability policy in `services/api` after it moved to a package.
- Do not treat `services/gateway` as the current Agent HTTP gateway.
- Do not assume production always uses the native Agent loop.
- Do not change only the native executor when JiuwenSwarm semantics also need adaptation.
- Do not widen the executor → runner legacy dependency exemption.
- Do not bypass `pnpm architecture:check` with new reverse dependencies.

## Related documentation

- [Runtime architecture](architecture.md)
- [Repository layout](repository-layout.md)
- [Control plane](control-plane.md)
- [Plugin architecture](plugins.md)
