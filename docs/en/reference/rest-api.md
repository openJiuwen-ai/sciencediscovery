# REST API Reference

This page records the key HTTP interfaces used by the current Web UI, based on `services/api/src/http/index.ts` and types under `packages/schema/src/`. The API has no version prefix or separate stability promise; repository routes and shared schemas are authoritative. External integrations should pin a ScienceDiscovery commit or release and re-check the contract when upgrading.

## Address, authentication, and common responses

- Local default base and bind address: `http://127.0.0.1:4310`.
- Docker default published address: `http://127.0.0.1:4310`.
- `GET /health` and `GET /api/health` do not require authentication.
- Other `/api/*` requests require `Authorization: Bearer <SCIENCE_AGENT_AUTH_TOKEN>`. There is no default token: when the variable is unset the server generates one on its first start, prints it, and stores it in `<data-dir>/secrets/auth-token`.
- JSON clients send `Content-Type: application/json`; generic JSON bodies are limited to 1,500,000 bytes. Workspace multipart uploads have separate quotas.
- JSON errors contain at least `{"error":"..."}` and may also contain `code` or `details`.

| Status | Current meaning |
|---|---|
| `200` | Successful query, update, delete, or cancel |
| `201` | Project, Session, Run, proxy, upload, or another resource created |
| `400` | Recognized input error, invalid JSON, or invalid query parameter |
| `401` | Missing or incorrect bearer token |
| `404` | Route or resource not found |
| `409` | Resource conflict, read-only Session, referenced or running resource |
| `413` | JSON/multipart body, file, or workspace exceeds its quota |
| `415` | Unsupported media type |
| `500` | Unclassified server error; internal exception details are not returned |

## Health

```bash
curl -fsS http://127.0.0.1:4310/health
```

A successful response is `200` and includes:

```json
{
  "memoryGraph": "disabled",
  "milestone": "M4",
  "runner": { "status": "ok" },
  "service": "science-agent-api",
  "status": "ok",
  "workspace": {
    "maxFileBytes": 1073741824,
    "maxRequestBytes": 10737418240,
    "maxWorkspaceBytes": 10737418240
  }
}
```

Runner fields come from its health response. If the runner is unavailable, the API still returns HTTP `200` with `status: "degraded"` and `runner.status: "unavailable"`. The three workspace values report API file, API request, and runner-workspace quotas, not output retention; see [Quota levels](configuration.md#quota-levels).

## Projects and Sessions

| Method and path | Request | Success |
|---|---|---|
| `GET /api/projects` | none | `200`, `Project[]` |
| `POST /api/projects` | `CreateProjectRequest` | `201`, root Project fields plus `project` and auto-created `firstSession` |
| `PATCH /api/projects/:projectId` | `{"name":"New name"}` | `200`, updated `Project` |
| `GET /api/projects/:projectId/sessions?state=active|archived|all` | none | `200`, `Session[]`; default `state=active` |
| `POST /api/projects/:projectId/sessions` | `CreateSessionRequest` | `201`, created `Session` |
| `GET /api/sessions/:sessionId/files` | none | `200`, workspace-file array |
| `POST /api/sessions/:sessionId/workspace/upload?conflict=reject|overwrite|rename` | multipart `file` field | `201`, `WorkspaceUploadResult` |

Minimal Project request:

```bash
curl -X POST http://127.0.0.1:4310/api/projects \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Research plan"}'
```

`CreateProjectRequest` has `name: string` and optional `settingsOverrides`. `CreateSessionRequest` may include `title`, `modelId`, `settingsOverrides`, `approvalMode`, `reviewMode`, `reviewCriteria`, and `specialistId`; see `packages/schema/src/session.ts` for exact types.

Project and Session deletion is not a bodyless DELETE. First request the corresponding `.../deletion-impact`, then submit the returned `targetId` as `confirmationId`. Active runs or a mismatched confirmation make deletion fail.

## Runs and events

| Method and path | Request/query | Success |
|---|---|---|
| `GET /api/sessions/:sessionId/runs` | none | `200`, `SessionRun[]` |
| `POST /api/sessions/:sessionId/runs` | `SendMessageRequest` | `201`, queued `SessionRun` |
| `GET /api/sessions/:sessionId/runs/:runId` | none | `200`, `SessionRun` |
| `GET /api/sessions/:sessionId/runs/:runId/events?after=0` | `Accept: application/json` or `text/event-stream` | `200`, event array or SSE; `after` is non-negative |
| `POST /api/sessions/:sessionId/runs/:runId/cancel` | none | `200`, cancellation result |
| `GET /api/sessions/:sessionId/artifacts` | none | `200`, Session Artifact array |

A minimal Run requires only `content`:

```json
{
  "content": "Summarize the current research objective and propose the next analysis steps"
}
```

`SendMessageRequest` may also contain `annotationIds`, `references`, and `webForceRefresh`. `SessionRun.status` can be `queued`, `running`, `blocked`, `completed`, `failed`, `cancelled`, or `interrupted`.

## Proxy configuration

All routes below require bearer authentication. See [Configure the network proxy](../how-to/configure-network-proxy.md).

| Method and path | Request | Success |
|---|---|---|
| `GET /api/proxy/settings` | none | `200`, `{defaultPolicy, servers}`; authenticated settings include usable full proxy URLs |
| `PUT /api/proxy/settings` | `{"defaultPolicy":"none"}` or `proxy:<id>` | `200`, updated settings |
| `POST /api/proxy/servers` | `{name, kind, url?}` | `201`, created proxy |
| `PUT /api/proxy/servers/:id` | `{name?, kind?, url?}` | `200`, updated proxy |
| `DELETE /api/proxy/servers/:id` | none | `200`, `{"deleted":"<id>"}`; `409` while referenced |
| `GET /api/mcp/proxy-policies` | none | `200`, `{"policies":{...}}` |
| `PUT /api/mcp/proxy-policies` | `{"policies":{"server-id":"inherit|none|proxy:<id>"}}` | `200`, normalized map |

`kind` is `custom_url`, `environment`, or `system`; `custom_url` requires `url`:

```bash
curl -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN}" \
  http://127.0.0.1:4310/api/proxy/settings

curl -X POST http://127.0.0.1:4310/api/proxy/servers \
  -H "Authorization: Bearer ${SCIENCE_AGENT_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Corporate proxy","kind":"custom_url","url":"http://proxy.company.example:8080"}'
```

Never place real proxy credentials in documentation, scripts, or shell history. The authenticated settings endpoint returns full URLs by current design, so protect the bearer token and browser session like a credential-management interface.
