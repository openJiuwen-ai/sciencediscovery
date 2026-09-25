# Repository Layout Reference

This is code navigation for deep developers and code agents. Directory presence does not imply capability ownership; **ownership is defined by packages, public contracts, and enforced architecture rules**.

## 1. Top-level structure

```text
sciencediscovery/
├── apps/
│   └── web/                  # React/Vite workbench
├── services/
│   ├── api/                  # Node control plane and composition root
│   ├── adapter/              # JiuwenSwarm front door / protocol adapter
│   ├── runner/               # sandbox execution daemon
│   ├── evolve/               # evolution-search sidecar
│   ├── memory-graph/         # ScienceMemory graph sidecar
│   ├── paper/                # PDF extraction worker
│   ├── gateway/              # Python MCP server code/interpreter environment
│   └── launcher/             # single-file release launcher
├── packages/                 # primary owners of shared/domain capabilities
├── skills/                   # bundled Skill packages
├── scripts/                  # startup, packaging, architecture checks, CI helpers
├── test/                     # integration, ST, E2E, real-environment tests
├── docs/
└── package.json
```

`pnpm-workspace.yaml` registers `apps/*`, `services/*`, and `packages/*`. Python sidecars are managed by their own uv/pyproject projects.

## 2. Services: processes and protocol composition

### `services/api`

The Node control plane composes capability packages into the product:

- HTTP / SSE / static Web;
- Project / Session / Run lifecycle;
- executor selection;
- permission and execution context;
- product-level Artifact/provenance/store orchestration;
- sidecar and Runner clients;
- plugin runtime composition.

Important entry points:

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | process entry |
| `src/http/index.ts` | HTTP composition root / main route assembly |
| `src/agent-run/create-agent-run.ts` | native / JiuwenSwarm executor seam |
| `src/agent-run/orchestrators.ts` | main/subagent run orchestration |
| `src/native-agent/` | native executor |
| `src/plugins/` | plugin/host composition |
| `src/store.ts`, `src/store/` | product catalog and authoritative state |

Do not move capability policy back into `services/api/src` merely because the API consumes it; the architecture checker explicitly prevents several removed service-domain sources from reappearing.

### `services/adapter`

Python front door for JiuwenSwarm mode:

- owns public `:4310`;
- proxies unmigrated routes to API `:4410`;
- maps ScienceDiscovery runs to JiuwenSwarm;
- provides per-run MCP tool bridge and LLM proxy;
- maps JiuwenSwarm frames back to ScienceDiscovery run events.

See:

- `agent_runs.py`
- `gateway.py`
- `mcp_server.py`
- `llm_proxy.py`
- `events.py`
- `services/adapter/README.md`

### `services/runner`

Isolation daemon owning:

- Linux Bubblewrap / macOS Seatbelt;
- Python/R/Shell execution;
- managed scientific environments;
- background/shell execution lifecycle;
- sandbox network gateway;
- optional Ascend NPU broker;
- local HTTP or remote Unix-socket Runner mode.

Entry: `src/server.ts`. Product semantics should not move into Runner.

### Python sidecars / workers

| Service | Lifetime | Responsibility |
| --- | --- | --- |
| `services/evolve` | stack sidecar | search/candidate execution |
| `services/memory-graph` | configurable sidecar | graph-storage API |
| `services/paper` | on-demand worker | PDF extraction |
| `services/gateway` | not an HTTP daemon | bundled Python MCP servers and interpreter environment |

## 3. Packages: capability ownership

The architecture intentionally moved reusable behavior out of `services/api` into packages.

### Lowest-level contracts

| Package | Responsibility |
| --- | --- |
| `runtime-core` | domain-neutral runtime message/tool/context contracts; relative imports only |
| `schema` | cross-module/process product schemas |
| `model` | model endpoints, transport, provider behavior |
| `tools` | Tool types, registry, execution contracts |
| `context` | context contributors; may depend only on model/runtime-core |
| `plugin-sdk` | plugin manifest/runtime/web contracts |

### Agent and execution

| Package | Responsibility |
| --- | --- |
| `orchestration` | AgentProfile and main/subagent run contracts |
| `workspace` | workspace prompt, tools, runtime bindings |
| `executor` | local/remote Runner clients and SSH provisioning |
| `governance` | permission/execution governance |
| `plan` | plan state |
| `trajectory` | trajectory/run-context records |

### Scientific/product capabilities

Other owning packages include `skill`, `specialist`, `mcp`, `mcp-sources`, `data-source`, `artifact-manager`, `artifact-json`, `provenance`, `memory`, `idea-tree`, `evolve`, `cas`, and `scheduler`.

Before adding behavior, look for an existing owning package instead of defaulting to API code.

## 4. Enforced dependency rules

`scripts/check-architecture.mjs` is the executable definition of repository boundaries:

1. `packages/` may not import `services/` or `apps/`.
2. package/service/test code must not depend on the old `@sciencediscovery/agent-runtime` compatibility facade.
3. `runtime-core` uses relative imports only.
4. `context` may depend only on `model` and `runtime-core`.
5. service-domain source files already moved into packages may not reappear.
6. executor → runner is a frozen legacy coupling, not a general exemption.
7. the API HTTP entry must use the platform composition root.

Run:

```bash
pnpm architecture:check
```

## 5. Runtime entry points

| Scenario | Entry |
| --- | --- |
| local native | `scripts/start-stack.sh --mode local` |
| local JiuwenSwarm | `scripts/start-stack.sh --mode local --jiuwenswarm` |
| Docker | `scripts/start-stack.sh --mode docker` |
| API dev | `pnpm dev` |
| repository build | `pnpm build` |
| architecture check | `pnpm architecture:check` |
| default checks | `pnpm check` |
| E2E | `pnpm ci:e2e` / tagged test runners |

## 6. Data and runtime state

The default runtime root is `.sciencediscovery-data/`. Important groups:

- `catalog.sqlite`: Project, Session, Run, settings, model, permission catalog;
- `projects/.../workspace/`: Session Workspace;
- `versioning/` / CAS / artifact records: versioned/content-addressed objects;
- `execution-runs/`, `run-events/`, `prompt-manifests/`: run audit/events;
- `scientific-envs/`: managed scientific environments;
- `envs/`: service Python environments;
- `skill-libraries/`: library catalog, versions, content-addressed packages;
- `logs/`: service logs.

See [Configuration reference](../reference/configuration.md#storage-layout) for exact layout.

## 7. Recommended code-navigation workflow

When modifying behavior:

1. Start from the user-visible HTTP/tool/plugin manifest.
2. Identify the owning package.
3. Find API composition/bindings instead of changing policy in API first.
4. If executor-related, inspect both native and JiuwenSwarm adapter paths.
5. Locate tests beside the package/service.
6. Run architecture check and target package tests.
7. Add E2E for user-observable behavior.

## Related documentation

- [Runtime architecture](architecture.md)
- [Deep developer guide](developer-guide.md)
- [Control plane](control-plane.md)
- [Plugin architecture](plugins.md)
- [Agent backend](agent-backend.md)
