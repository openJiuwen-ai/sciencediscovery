# Control Plane: `services/api`

The Node control API is the core process: browser requests, run orchestration, tool execution, permission, review, and storage all pass through it. Route registration in `services/api/src/http/index.ts` is authoritative.

## 1. Source structure

| File/directory | Responsibility |
|---|---|
| `server.ts`, `http/` | Entry barrel and HTTP shell: routes, auth, bodies, responses, static assets, tool callback |
| `runs/` | Lifecycle, SSE, serialization, workspace-event filtering |
| `store.ts`, `store/` | `SessionStore` facade and SQLite catalog/permission/secret/settings/subagent/stream domains |
| `native-agent/`, `agent-run/` | **The Node-native agent loop** (`index.ts` state machine, `model-client.ts` streaming transport, `deferred-tools.ts`, `compaction.ts`) plus main/subagent orchestration, permission state machine, bindings. See [agent-backend.md](agent-backend.md) |
| `mcp/` | Broker, Source catalog, Artifact jobs, rate limiter, and result cache |
| `runner-client.ts` | Bearer plus HMAC-signed runner client |
| `provenance.ts`, `prompt-manifest.ts`, `reviewer-specialist/` | Provenance and Artifact review |
| `papers.ts`, `skills.ts`, `remote-compute.ts`, `environment.ts` | Domain logic |
| `memory-graph.ts` | Experimental sidecar client |

## 2. HTTP surface

Representative groups, not an exhaustive route list:

| Prefix | Content |
|---|---|
| `GET /health`, `/api/health` | Aggregated runner/memory-graph health |
| `/api/projects…`, `/api/sessions…` | CRUD, archive/restore, overrides, deletion preview |
| Session message/run SSE routes | Start or subscribe to a run and replay main/tool/subagent streams with cursors |
| Run cancel | Propagate abort to the native loop and runner |
| Session plans/subagents/remote-jobs/papers/evidence | Run-associated records |
| Session MCP and `/api/mcp/sources…` | Invocation, Artifact jobs, Source catalog/status |
| `/api/{models,specialists,skills,remote-hosts,environments}` | Global resources |
| `/api/settings`, `/api/timeout-settings`, `/api/quota-settings`, `/api/sandbox-network-settings`, `/api/runtime-status` | Global controls, timeouts, quotas, sandbox network access, and live state |

SSE uses fetch-stream `data: <json>\n\n` frames; see [Web frontend](../reference/web-frontend.md).

## 3. Storage

- SQLite `.sciencediscovery-data/catalog.sqlite` stores catalog entities: projects, sessions, runs, messages, Artifact versions, permission requests/grants/epochs/authorizations, plans, subagents, specialists, and model configuration.
- Files under `.sciencediscovery-data/` store execution records, prompt manifests, claims/evidence, MCP/derivation/model-usage audit, and CAS blobs under `.sciencediscovery-data/cas/sha256/…`.
- See [Storage layout](../reference/configuration.md#storage-layout).

## 4. Run lifecycle

The state machine is `queued → running ⇄ blocked → completed|failed|cancelled|interrupted`. `blocked` waits for permission; `interrupted` marks a historical run recovered after process failure.

A main run validates Session/model, resolves composer references and environments, builds the workspace prompt, creates an execution context with permission runtime and abort signal, runs the native agent loop in-process, records Prompt Manifest/provenance, optionally executes independent review checkpoints, emits a terminal event, and clears callbacks/pending permission. Subagents use private workspaces and restricted tools; handoff files are bounded and Brief v1 can validate structured output.

## 5. Permission system

Action types include `code`, `connector`, `artifact_download`, `directory`, `host`, and `remote_job`; grants can be once, Session, Project, or global. Resolution checks unrevoked grants, otherwise persists a pending request, emits `permission.required`, marks the run blocked, and pauses its timeout. `allow_once`, `allow_matching`, or `deny` produces a `PermissionAuthorization` audit row. Approval-mode change or environment reset rotates `permissionEpoch`; persistent kernels are recreated and ExecutionRun records the epoch.

## 6. Tool callback and runner channel

Tools are invoked in-process by the loop through `AgentTool.execute`; there is no cross-process callback and no per-run callback token. The permission gate, provenance, and rate limiting still apply inside the handlers. Runner `/execute` and `/execute-shell` calls include an HMAC-SHA256 signature over token, timestamp, and body hash. Kernel/environment/setup endpoints are described in [Sandbox execution](sandbox-execution.md).

## 7. Model calls made directly by API

The agent loop itself (`native-agent/model-client.ts`) streams directly to the configured model endpoint in either the OpenAI-compatible or Anthropic Messages dialect. Paper vision analysis in `papers.ts` calls an OpenAI-compatible endpoint directly. See [PDF worker](../reference/paper-worker.md).

## Related documentation

- [Runtime architecture](architecture.md)
- [Agent backend](agent-backend.md)
- [Sandbox execution](sandbox-execution.md)
- [Review and provenance](review-provenance.md)
