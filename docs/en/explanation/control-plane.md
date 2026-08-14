# Control Plane: `services/api`

The Node control API is the core process: browser requests, run orchestration, tool execution, permission, review, and storage all pass through it. Route registration in `services/api/src/http/index.ts` is authoritative.

## 1. Source structure

| File/directory | Responsibility |
|---|---|
| `server.ts`, `http/` | Entry barrel and HTTP shell: routes, auth, bodies, responses, static assets, tool callback |
| `runs/` | Lifecycle, SSE, serialization, workspace-event filtering |
| `store.ts`, `store/` | `SessionStore` facade and SQLite catalog/permission/secret/settings/subagent/stream domains |
| `gateway-agent.ts`, `agent-run/` | Gateway execution, callback tokens, main/subagent orchestration, permission state machine, bindings |
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
| `POST /internal/tool-exec` | Loopback per-run bearer callback from gateway |
| `/api/projects…`, `/api/sessions…` | CRUD, archive/restore, overrides, deletion preview |
| Session message/run SSE routes | Start or subscribe to a run and replay main/tool/subagent streams with cursors |
| Run cancel | Propagate abort to gateway and runner |
| Session plans/subagents/remote-jobs/papers/evidence | Run-associated records |
| Session MCP and `/api/mcp/sources…` | Invocation, Artifact jobs, Source catalog/status |
| `/api/{models,specialists,skills,remote-hosts,environments}` | Global resources |
| Settings/timeouts/runtime status | Global controls and live state |

SSE uses fetch-stream `data: <json>\n\n` frames; see [Web frontend](../reference/web-frontend.md).

## 3. Storage

- SQLite `data/catalog.sqlite` stores catalog entities: projects, sessions, runs, messages, Artifact versions, permission requests/grants/epochs/authorizations, plans, subagents, specialists, and model configuration.
- Files under `data/` store execution records, prompt manifests, claims/evidence, MCP/derivation/model-usage audit, and CAS blobs under `data/cas/sha256/…`.
- See [Storage layout](../reference/configuration.md#storage-layout).

## 4. Run lifecycle

The state machine is `queued → running ⇄ blocked → completed|failed|cancelled|interrupted`. `blocked` waits for permission; `interrupted` marks a historical run recovered after process failure.

A main run validates Session/model, resolves composer references and environments, builds the workspace prompt, creates an execution context with permission runtime and abort signal, calls gateway, records Prompt Manifest/provenance, optionally executes independent review checkpoints, emits a terminal event, and clears callbacks/pending permission. Subagents use private workspaces and restricted tools; handoff files are bounded and Brief v1 can validate structured output.

## 5. Permission system

Action types include `code`, `connector`, `artifact_download`, `directory`, `host`, and `remote_job`; grants can be once, Session, Project, or global. Resolution checks unrevoked grants, otherwise persists a pending request, emits `permission.required`, marks the run blocked, and pauses its timeout. `allow_once`, `allow_matching`, or `deny` produces a `PermissionAuthorization` audit row. Approval-mode change or environment reset rotates `permissionEpoch`; persistent kernels are recreated and ExecutionRun records the epoch.

## 6. Tool callback and runner channel

Each run registers a random callback bearer token; unknown tokens on `/internal/tool-exec` receive 401 and the token is removed at run end. Runner `/execute` and `/execute-shell` calls include an HMAC-SHA256 signature over token, timestamp, and body hash. Kernel/environment/setup endpoints are described in [Sandbox execution](sandbox-execution.md).

## 7. Model calls made directly by API

Paper vision analysis in `papers.ts` calls the OpenAI-compatible endpoint directly rather than through gateway. See [PDF worker](../reference/paper-worker.md).

## Related documentation

- [Runtime architecture](architecture.md)
- [Agent backend](agent-backend.md)
- [Sandbox execution](sandbox-execution.md)
- [Review and provenance](review-provenance.md)
