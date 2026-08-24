# Repository Layout Reference

This page maps directories, modules, default ports, and data locations. See [Runtime architecture](../explanation/architecture.md) for the responsibility split.

## 1. Repository tree

The repository is a pnpm monorepo with several Python subprojects:

```text
sciencediscovery/
├── apps/web/                 # React/Vite browser UI
├── services/
│   ├── api/                  # Node control API
│   ├── gateway/              # bundled Python MCP servers + their venv
│   ├── runner/               # Bubblewrap executor
│   ├── paper/                # uv PDF worker
│   └── memory-graph/         # experimental Science Memory sidecar, off by default
├── packages/
│   ├── agent-runtime/        # prompts, tools, agent event types
│   ├── schema/               # shared TypeScript types and schemas
│   └── mcp-sources/          # scientific MCP manifests and trust boundary
├── skills/                   # built-in Agent Skills
├── scripts/                  # shared launcher and mode wrappers
├── test/                     # integration and browser E2E outside pnpm check
├── docs/                     # complete English and Chinese documentation
├── data/                     # gitignored runtime state
├── .e2e/                     # gitignored local Playwright environment
├── README.md / README_zh.md
└── LICENSE                   # Apache-2.0
```

### 1.1 Processes and default ports

`./scripts/start-stack.sh --mode local` (or compatibility wrapper `run-local.sh`) starts:

| Process | Default address | Purpose |
|---|---|---|
| `services/gateway` | no port | Not a service: interpreter environment for the bundled Python MCP servers |
| `services/runner` | `127.0.0.1:4311` | Sandbox execution, loopback only |
| `services/api` | `127.0.0.1:4310` | Control API and static UI, local-only by default |

First startup prepares uv environments under `.sciencediscovery-data/envs/gateway` and `.sciencediscovery-data/envs/paper`. The repository has no submodules.

## 2. Modules and responsibilities

### 2.1 `apps/web` — workbench

Project/Session navigation and lifecycle, chat/tool traces, workspace files, connector controls, settings, models, environments, skills, specialists, permissions, connection tokens, layered Project/Session overrides, approval cards, and review results.

### 2.2 `services/api` — control plane

| Area | Purpose |
|---|---|
| `server.ts`, `http/` | Process/barrel and HTTP shell: routes, auth, bodies, responses, static assets, tool callback |
| `runs/` | Run lifecycle, SSE, orchestration, concurrency, workspace-event filtering |
| `store.ts`, `store/` | `SessionStore` facade and SQLite domain storage |
| `subagents/`, `artifacts/` | Handoff/private workspaces and versioned Artifact behavior |
| `web-providers/`, `connectors/` | Web broker and scientific connector manifests/broker |
| `native-agent/` | **The Node-native agent loop**: `index.ts` (state machine), `model-client.ts` (streaming transport), `deferred-tools.ts`, `compaction.ts` |
| `mcp/` | MCP governance and the in-process client: `broker.ts`, `node-client.ts`, `extensions-config.ts`, `source-catalog.ts` |
| `papers.ts`, `runner-client.ts` | Paper download/extraction and runner calls |
| `provenance.ts`, `reviewer-specialist/` | Execution provenance and Artifact review |
| `skills.ts`, `prompt-manifest.ts` | Skill revisions/resources and frozen run metadata |
| `remote-compute.ts` | Experimental remote-job cards, not a supported primary workflow |

Its external capabilities cover Project management, agent runs, connectors/papers, managed environments, skills/specialists, permissions, and review.

### 2.3 `services/gateway` — web-provider sidecar

It **is no longer a service**. The agent loop moved into `services/api`'s `native-agent/` and the web providers into `web-providers/native/` (see [Agent backend](../explanation/agent-backend.md)), so the FastAPI app, the web router, and the `_engine/` adapter are all deleted, along with the vendor harness dependency and the submodule it came from. What remains is the bundled Python MCP servers (biomed, UniProt), which Node spawns as stdio subprocesses using this venv's interpreter.

### 2.4 `services/runner` — isolated execution

Bubblewrap namespaces and seccomp run Python, R, or shell with no network by default, with optional managed environments/persistent kernels. Guards include wall-clock timeout, workspace total, execution-output quota, and one global worker. There is no independent execution-file or CPU/memory cgroup quota.

### 2.5 `services/paper` — PDF extraction

An isolated bounded worker produces Markdown, tables, figures, and page previews. Limits include 50 MiB, 200 pages, and text/table/figure/preview caps; OCR is absent.

### 2.6 `packages/*`

- `schema`: shared Session, MCP, Artifact, execution, and permission types.
- `agent-runtime`: workspace prompts, tool list, deferred MCP/download/extraction tools, and events.
- `mcp-sources`: scientific manifests, input validation, and Node trust-boundary checks.

### 2.7 `skills/`

| Skill | Purpose |
|---|---|
| `life-science-evidence-brief` | Connector-backed life-science claim/citation briefs |
| `structure-pocket-inspection` | Local PDB structure/pocket inspection in workspace Python |

All skills are available by default and may be narrowed at Project/Session scope. Runs freeze revisions in Prompt Manifest.

### 2.8 `test/`

Root tests contain Playwright browser E2E plus gateway/API mock and real smoke suites. Playwright is not part of the default `pnpm check` path.

## 3. Data and configuration

| Location | Contents |
|---|---|
| `.sciencediscovery-data/catalog.sqlite`, `model-secrets.key` | Metadata/settings/permissions and token-encryption key |
| `.sciencediscovery-data/projects/.../workspace/` | Per-Session files and paper extraction |
| `.sciencediscovery-data/cas/`, claims/evidence/MCP paths | Immutable content and provenance/audit |
| `.sciencediscovery-data/artifact-jobs/`, `artifact-extraction-jobs/` | Download and extraction state |
| `.sciencediscovery-data/scientific-envs/` | Managed Python/R prefixes |
| `.sciencediscovery-data/envs/gateway`, `.sciencediscovery-data/envs/paper` | Rebuildable service environments |

See [Configuration reference](configuration.md) for the full layout.

## 4. Module count

| Category | Count | Members |
|---|---:|---|
| Frontend | 1 | `apps/web` |
| Backend services | 5 | API, gateway, runner, paper, experimental Science Memory |
| Shared TS packages | 3 | agent-runtime, schema, mcp-sources |
| Built-in skill packages | 2 | life-science and structure-pocket |

That is about 11 first-class deployable/buildable modules, excluding tests, scripts, and docs.

## 5. Related documentation

- [Control plane](../explanation/control-plane.md)
- [Agent backend](../explanation/agent-backend.md)
- [Built-in tools](builtin-tools.md)
- [Sandbox execution](../explanation/sandbox-execution.md)
- [Review and provenance](../explanation/review-provenance.md)
- [Science connectors](../explanation/science-connectors.md)
- [PDF worker](paper-worker.md)
- [Web frontend](web-frontend.md)
- [README](../../../README.md)
