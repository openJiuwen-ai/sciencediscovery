# MCP Backend Design

[简体中文](../../zh/explanation/mcp-tool-protocol.md) | [Configuration guide](../how-to/configure-custom-mcp.md) | [REST API](../reference/rest-api.md)

## 1. Design objective

ScienceDiscovery uses one governed MCP data path. Scientific queries, download candidates, permission, cache, rate limits, retry, CAS, and audit cannot bypass the Node control plane.

```text
Agent → mcp__<source>__<tool> → Node McpGovernanceBroker
      → in-process Node MCP client (mcp/node-client.ts)
      → MCP Server (stdio / SSE / streamable HTTP) → McpResult
```

Legacy `invoke_connector`, `ConnectorBroker`, `science-sources`, and direct transport are no longer runtime architecture.

## 2. Responsibility boundary

For built-in scientific sources, Python MCP validates provider parameters/scientific identifiers, performs and parses upstream requests, creates records/citations/candidates, and classifies provider errors. Node owns Session enablement/tool permission, input and envelope schemas, identity consistency, domains/response size/download path/checksum, cache/rate/concurrency/retry, and CAS/Invocation/Artifact audit. Node does not duplicate provider-domain parsing and treats all MCP servers as external trust boundaries. Custom servers need not use Python or implement the scientific result envelope; Node's `customMcpAdapter` adapts generic tool results into the governed path described in section 5.

## 3. Core result

```ts
interface McpToolResult {
  records: McpRecord[];
  artifacts?: ArtifactCandidate[];
  warnings: string[];
  data?: JsonValue;
  attribution: string;
  license: string;
  retrievedAt: string;
  sourceId: string;
  sourceVersion?: string;
  toolId: string;
  untrusted: true;
}
```

MCP returns records, citations, candidates, warnings, and structured data. Claims and Evidence are produced later by Agent reading/reasoning, not directly by query MCP.

The interface above is Node's normalized result, not a wire format required from arbitrary custom servers. The generic adapter places MCP `content` and optional `structuredContent` in `data`, returns empty `records` and `warnings`, and marks the result `untrusted: true`. It does not automatically interpret text or links as scientific evidence or download candidates.

## 4. Source Manifest

The initial manifest retains source identity/display/version/type, MCP server ID, tool/schema/description/routing, license/attribution/classification/allowed domains, response/rate/concurrency limits, TTL cache, and retry. It deliberately omits direct transport, credential-cache scope, stale-if-error, generic version policy, remote Artifact destinations, adapter cache/version hooks, Artifact export, request DAG/`dependsOn`, unimplemented public idempotency keys, and arbitrary server metadata containers.

## 5. Custom MCP

### 5.1 Components and invocation boundaries

Custom access reuses the Registry, Catalog, Broker, and Node MCP client. It does not introduce an Agent tool executor that bypasses governance.

| Component | Responsibility |
|---|---|
| `McpServerSettings.tsx` / `McpAuthorization.tsx` | Configuration, import, enablement, connection state, and authorization interaction |
| `McpInspector.tsx` | Manual tool calls in a selected Session, with raw and normalized results |
| `http/custom-mcp.ts` | Management, test, Inspector, and OAuth HTTP entry points |
| `mcp/custom-servers.ts` | Validation, encrypted persistence, serialized mutations, and dynamic Source registration |
| `mcp/custom-adapter.ts` | Tool identity, input schemas, generic result adaptation, and governance policies |
| `mcp/oauth.ts` | OAuth discovery, authorization, credential storage, refresh, and invalidation |
| `mcp/node-client.ts` | STDIO / HTTP / SSE connections, discovery, and protocol calls |

Frontend files are under `apps/web/src/`; HTTP and MCP backend files are under `services/api/src/`. Shared configuration and result types live in `packages/schema/src/custom-mcp.ts`.

```text
Save -> CustomMcpServers -> encrypted file + Registry -> Catalog discovery

Connection test -> separate McpNodeClient -> connect / tools/list / schema checks

Agent -> effective Session connector selection -> mcp__<sourceId>__<toolId> --+
                                                                          +-> McpGovernanceBroker
Inspector -> selected Session + explicit single-server selection ----------+    -> McpNodeClient
                                                                               -> MCP Server
                                                                               -> CAS / Invocation / normalized result
```

A connection test does not invoke business tools and cannot establish that all parameters, permissions, and results work. STDIO testing does start the configured program. Inspector makes real tool calls, without an LLM generating parameters; it is not a simulated preview.

### 5.2 Configuration and lifecycle

- Each server has a stable `custom-<12 hex digits>` ID, also used as its Source ID. Display names are not identities. Names are case-insensitively unique, with at most 50 saved servers.
- `stdio` uses `command`, `args`, optional `cwd`, and `env`; `http` / `sse` use an MCP `url`, `headers`, and authentication configuration. A webpage or model API URL is not an MCP endpoint.
- Tool timeout defaults to 60 seconds and must be an integer from 1 to 600; it cannot be disabled. Separate initialization, tool-call, and reconnect timeout settings are not currently exposed.
- New forms default to disabled. JSON import accepts `mcpServers`, validates the entire batch before saving it together, and forces imported entries to disabled. Import neither executes tools nor grants Agent access.
- Saving invalidates old checks and refreshes the Catalog. Failed discovery or incompatible input schemas keep corresponding tools out of Agent exposure. Testing uses a separate client, can probe disabled servers, closes the probe afterwards, and does not change enablement.
- Startup loads persisted configuration and registers dynamic Source IDs so the Store recognizes existing connector selections. Tool lists and check states are rediscovered at runtime, not persisted as permanent configuration.
- Deletion removes configuration, registration, check state, local OAuth credentials, and connector references in settings, then refreshes the Catalog. It does not uninstall STDIO programs or delete remote data.

Connection state (`untested / ready / error / disabled`) is separate from OAuth state. `ready` means connection/discovery checks passed, not that every business tool was executed successfully.

### 5.3 Secrets and persistence

Configuration is encrypted in `custom-mcp-servers.enc` in the data directory; OAuth credentials are encrypted in `mcp-oauth.enc`, using the existing `model-secrets.key`. Writes use queues, temporary files, and rename, with file creation mode `0600`. This protects stored data at rest, not against an administrator controlling the backend host.

List responses retain env/header keys but replace values with `null`. Saved OAuth Client Secrets are not returned in plaintext either, and access/refresh tokens are not sent to the frontend. The env/header update contract is:

| Submitted value | Persistence meaning |
|---|---|
| `null` for an existing same-name key | Preserve that key's old value |
| A string, including `""` | Replace the value; an empty string explicitly clears it |
| An old key omitted from the updated map | Delete the key |
| `null` for a new key | Reject: there is no same-name old value to preserve |

The frontend records `originalKey` only in the editing draft. Editing a key preserves `value: null` instead of converting it to an empty string. A renamed saved key requires a new nonempty value; otherwise an inline error blocks saving. Restoring the original name preserves the old value only when the value itself was not edited. The backend has no implicit secret migration between names, and swapping two saved key names does not bypass re-entry.

Env/header values starting with `$` resolve against backend environment variables, not the browser. STDIO programs run on the API host or in its container, not automatically in the Session sandbox. Only trusted programs should be configured; deployment controls their system permissions and dependencies.

### 5.4 Tool adaptation, selection, and audit

After discovery, the adapter derives a local tool ID from a normalized name plus a hash, retaining the original name for protocol calls. Generated Agent tool names stay within the provider's 64-character limit. Ajv validates inputs, using the compatibility validator for explicit draft-07 schemas and Ajv2020 otherwise.

Generic tools may have side effects, so they are `idempotent: false`, have caching disabled and one automatic attempt, and do not use keyword routing. Current Source governance defaults are concurrency 1, queue depth 8, queue timeout 20 seconds, and response limit 5,000,000 bytes. These are client governance parameters, not a sandbox guarantee for external programs. Resending an authentication-rejected request after OAuth refresh is authentication handling, not a tool-failure retry policy.

Agent availability depends on global server enablement, discovered tools, and effective Session connector settings, which may inherit Project/global settings. Availability does not force an Agent call every turn. The Broker performs input checks, permission policy, and audit.

Inspector requires an existing Session, an enabled server, and a discovered tool. Explicit manual execution passes `allowedSourceIds: [id]` for that server without changing the Session's Agent connector selection, and still uses the same Broker. It returns success/failure, duration, `invocationId`, available raw response, and normalized result, associated with the Project/Session audit path. Cancelling passes an abort signal but cannot guarantee rollback of remote side effects.

### 5.5 OAuth lifecycle

OAuth applies only to HTTP/SSE and reuses MCP SDK authorization support. It accepts preregistered Client ID/Secret, and dynamic registration or a client metadata URL where supported by the provider; the product does not host metadata documents. A nonempty Client Secret requires a Client ID. OAuth mode rejects manually configured `Authorization` headers while allowing other application headers.

```text
Browser -> authenticated oauth/start -> backend discovery, state and PKCE
        <- authorizationUrl + expiresAt
Browser -> provider login / consent -> /api/mcp/oauth/callback
Backend -> validate and consume state -> exchange code with verifier -> encrypted storage
Later MCP requests -> check authorization / refresh as needed -> call with access token
```

- States are `required / authorizing / authorized / expired`. Pending login is in memory with a 10-minute lifetime; unfinished login must restart after a backend restart.
- Start requires local API authentication and a callback matching the browser application's origin and fixed callback path. Callback does not require a local API Bearer Token; it validates the authorization transaction through one-use state, expiry, and PKCE. State is consumed before token exchange.
- OAuth URLs require HTTPS except for loopback HTTP. MCP requests carrying access tokens are restricted to the configured origin and do not automatically follow redirects. Callback HTML never echoes authorization codes, tokens, or raw provider errors.
- Requests check token expiry and refresh near expiration. A 401 can trigger refresh and one resend; a 403 `insufficient_scope` requires renewed consent. Concurrent refreshes for one server share a single task.
- Changing URL, transport, authentication mode, or OAuth configuration clears old authorization. Configuration signatures, authorization generations, and pending-attempt checks prevent stale asynchronous work from restoring obsolete credentials.
- Cancel ends a pending login, not existing credentials. Clear deletes local credentials and invalidates pending attempts; it does not call a provider revocation endpoint.

Connection tests, Inspector, and Agent calls share the OAuth manager and client authentication logic. Provider registration policy, callback allowlists, scopes, and account permissions still determine compatibility; zero-configuration support for every OAuth provider is not guaranteed.

## 6. Agent tools

### 6.1 MCP query

`mcp__<sourceId>__<toolId>` returns the standard result with a Node-added `invocationId`. A returned candidate is not downloaded automatically.

### 6.2 Artifact download

```ts
artifact_download({
  mcpInvocationId: string,
  candidateId: string,
  destinationPath?: string
})
```

Node reads the candidate from a successful invocation CAS result, validates identity/domain/license/path, creates an ArtifactPlan, obtains permission, runs a DownloadJob with resume/retry/size/checksum, and returns only at terminal state.

```ts
interface ArtifactDownloadResult {
  candidateId: string;
  planId: string;
  jobId?: string;
  finalPath?: string;
  actualChecksum?: string;
  bytesDownloaded: number;
  sourceId: string;
  sourceRecordId: string;
  status: "completed" | "failed" | "cancelled" | "denied";
  error?: McpError;
}
```

### 6.3 PDF extraction

`paper_extract_pdf({artifactJobId})` accepts only a completed PDF download. It creates a separate ExtractionJob, invokes Paper Worker, and returns extraction/acquisition IDs, text/manifest paths, page count, and warnings. Download does not auto-extract, and extraction failure does not change completed download state.

## 7. Agent loop

Calls in one model turn must be independent and can run concurrently; the loop waits for all before the next model turn. Downloads A/B belong in one turn and their dependent extractions in a later turn. There is no initial tool DAG.

Failure is a structured Tool Result with code, bounded message, retryability, attempts, and optional retry delay. One failure does not cancel other independent calls.

## 8. Permission and audit

Session approval mode is `always_allow` or default `ask_for_dangerous`. Dangerous actions create independent requests:

- `allow_once` authorizes only that action and creates no Grant.
- `allow_matching` creates a Session Grant for normalized action/resource and atomically releases matching pending actions; later matches reuse it.
- `deny` rejects only that action.

`always_allow` authorizes directly without wildcard/once Grants. Every allow, deny, or existing-grant hit appends a single-use `PermissionAuthorization`; reusable/revocable capability belongs to `PermissionGrant`. ArtifactPlan/Job and McpInvocation reference the authorization. Legacy `permissionGrantId` is read-only compatibility.

Human wait pauses the corresponding main/child run deadline (`beginExternalWait`). Decisions are independent. Disconnect/run end cancels remaining pending requests. Switching to always-allow rotates the permission epoch and wakes each current pending action. Plans are only recorded progress; there is no plan approval API/gate.

## 9. Lifecycle

```text
ArtifactPlan: awaiting_approval → approved | expired
DownloadJob: queued → running | retrying → verifying → completed | failed | cancelled
ExtractionJob: queued → running → completed | failed | cancelled
PaperAcquisition: created only after successful extraction
```

Completed downloaded files are immutable. PDF extraction is a new tool call and derived result, not a DownloadJob post-processing field.

## 10. Data sources

The initial 12 Sources are PubMed, arXiv, Europe PMC, bioRxiv, medRxiv, UniProt, PDB, Ensembl, Reactome, ClinVar, ChEMBL, and GEO. Catalog discovery and schema checks degrade and hide absent/incompatible tools.

## 11. Control-plane interfaces

Custom server management: `/api/mcp/servers` lists/creates servers; `/:id` updates/deletes; `/import` imports a batch. `/:id/test` probes connections and `/:id/inspect` executes tools. `/:id/oauth/start|cancel|clear` and `/api/mcp/oauth/callback` manage authorization. See the [REST API](../reference/rest-api.md) for methods and request/response shapes, and section 5 for the integration design.

Custom server management endpoints require the local API access token except for OAuth callback. Tests can return HTTP 200 with a failed check, and Inspector can return HTTP 200 with `ok: false`; HTTP status alone does not indicate tool success.

Source Catalog exposes list/reload/detail/status/tools. Session invocation routes list/detail calls. Artifact candidate/plan/job routes list, create, approve, cancel, and retry; extraction-job routes list/detail. Permission routes list/decide requests, list/delete Grants, list Session authorizations, and PATCH Session approval mode.

Existing Session Invocation endpoints can query past Agent and Inspector calls.

Decision values are `allow_once|allow_matching|deny`; mode values are `ask_for_dangerous|always_allow`. A short-lived historical `never_ask` value migrates to `always_allow`. Agent tools create/wait for jobs; HTTP is for audit, human authorization, and UI, not a one-step bypass of download/extract semantics.

## 12. Test requirements

Each built-in scientific Source has registration/schema contract and a normal or empty-result fixture validating Source/Record/Citation identity and URLs; candidate-producing Sources also validate candidate identity/domain. Shared parameterized broker tests cover invalid/changing input, limit/empty/page boundaries, 429/Retry-After/5xx/timeout, response size, retry, and structured errors.

Node integration tests cover cache, permission, concurrency/retry, forged identity/URL rejection, traversal/redirect/checksum protection, no automatic download/extraction, parallel downloads before the next turn, completed-PDF gating, isolated failure, authorization/Grant cardinality, independent concurrent decisions and epochs, wait-time pause, orphan cleanup, and waking pending actions on always-allow.

Custom access additionally requires coverage of:

- Atomic import, redaction and restart recovery, dynamic registration and selection.
- Transport discovery, schema failures, real Inspector calls and audit.
- OAuth callback replay, expiry, cancellation, refresh, and configuration changes.
- Both env and header secret editing: unchanged preservation, blocked rename, successful re-entry, restoring the original name, and explicit clearing.

Existing custom MCP test entry points are `services/api/src/mcp/custom-servers.test.ts`, `oauth.test.ts`, `node-client.test.ts`, `apps/web/tests/McpSecretFields.test.tsx`, and `test/journey-custom-mcp.spec.ts`, `journey-mcp-oauth.spec.ts`, `journey-mcp-secret-edit.spec.ts`.

Local fixtures validate protocol and product behavior, not interoperability with every real third-party service. Real-provider smoke tests remain outside default offline unit tests.

## 13. Current implementation scope

Included: one Registry/Catalog replacing legacy brokers/direct providers; 12 public Sources with actual discovery/schema compatibility; Node permission/rate/cache/retry/CAS/audit/envelope checks; explicit download and separate extraction with persistent state; independent same-turn concurrency; governed Evidence consumption; per-action/default approval and Session matching Grants; Authorization/epoch/disconnect audit; plan/permission separation.

Also included: custom STDIO, Streamable HTTP, and SSE servers; encrypted configuration, dynamic discovery, connection tests and JSON import; HTTP/SSE OAuth login/refresh; and a governed tool Inspector (section 5).

Excluded: built-in private-mirror, institutional-authentication, and commercial-database adapters; bulk export; patent/reference-manager synchronization; and a complete Source/Invocation management UI. Custom MCP can connect to provider-supplied services, but does not supply those adapters or account permissions. Built-in scientific sources still focus on public data; extensible tool access is not completion of every future source request.

Complete resources/prompts browsing, per-tool enablement settings, and custom configuration export are also not implemented. Inspector focuses on individual manual tool calls, not a full embedded official Inspector.

## 14. UI

The built-in scientific UI provides basic candidates, job state, cancel/retry, and invocation count. Scientific query/download is Agent-driven and legacy Connector search/import is removed. Settings additionally provide custom server management, tool details, and Inspector, but not a complete Source/Invocation/ExtractionJob management UI. Permission cards expose Allow once, Allow same type, and Deny; Sessions expose Always allow.

Custom server details start collapsed and expose schemas, connection details, authorization status, and access to Inspector when expanded. Enablement applies to the entire server; timeout is always required. See section 5.3 for secret preservation and re-entry rules.

Inspector displays success/failure, duration, raw and normalized results, and a copyable invocation ID for each call. See section 5.4 for invocation and cancellation semantics.
