# MCP Backend Design

## 1. Design objective

ScienceDiscovery uses one governed MCP data path. Scientific queries, download candidates, permission, cache, rate limits, retry, CAS, and audit cannot bypass the Node control plane.

```text
Agent → mcp__<source>__<tool> → Node McpGovernanceBroker
      → DeerFlow MCP Gateway → Python MCP Server → McpResult
```

Legacy `invoke_connector`, `ConnectorBroker`, `science-sources`, and direct transport are no longer runtime architecture.

## 2. Responsibility boundary

Python MCP validates provider parameters/scientific identifiers, performs and parses upstream requests, creates records/citations/candidates, and classifies provider errors. Node owns Session enablement/tool permission, input and envelope schemas, identity consistency, domains/response size/download path/checksum, cache/rate/concurrency/retry, and CAS/Invocation/Artifact audit. Node does not duplicate provider-domain parsing but treats Python MCP as an external trust boundary.

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

## 4. Source Manifest

The initial manifest retains source identity/display/version/type, MCP server ID, tool/schema/description/routing, license/attribution/classification/allowed domains, response/rate/concurrency limits, TTL cache, and retry. It deliberately omits direct transport, credential-cache scope, stale-if-error, generic version policy, remote Artifact destinations, adapter cache/version hooks, Artifact export, request DAG/`dependsOn`, unimplemented public idempotency keys, and arbitrary server metadata containers.

## 5. Agent tools

### 5.1 MCP query

`mcp__<sourceId>__<toolId>` returns the standard result with a Node-added `invocationId`. A returned candidate is not downloaded automatically.

### 5.2 Artifact download

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

### 5.3 PDF extraction

`paper_extract_pdf({artifactJobId})` accepts only a completed PDF download. It creates a separate ExtractionJob, invokes Paper Worker, and returns extraction/acquisition IDs, text/manifest paths, page count, and warnings. Download does not auto-extract, and extraction failure does not change completed download state.

## 6. Agent loop

Calls in one model turn must be independent and can run concurrently; the loop waits for all before the next model turn. Downloads A/B belong in one turn and their dependent extractions in a later turn. There is no initial tool DAG.

Failure is a structured Tool Result with code, bounded message, retryability, attempts, and optional retry delay. One failure does not cancel other independent calls.

## 7. Permission and audit

Session approval mode is `always_allow` or default `ask_for_dangerous`. Dangerous actions create independent requests:

- `allow_once` authorizes only that action and creates no Grant.
- `allow_matching` creates a Session Grant for normalized action/resource and atomically releases matching pending actions; later matches reuse it.
- `deny` rejects only that action.

`always_allow` authorizes directly without wildcard/once Grants. Every allow, deny, or existing-grant hit appends a single-use `PermissionAuthorization`; reusable/revocable capability belongs to `PermissionGrant`. ArtifactPlan/Job and McpInvocation reference the authorization. Legacy `permissionGrantId` is read-only compatibility.

Human wait pauses the corresponding main/child gateway deadline. Decisions are independent. Disconnect/run end cancels remaining pending requests. Switching to always-allow rotates the permission epoch and wakes each current pending action. Plans are only recorded progress; there is no plan approval API/gate.

## 8. Lifecycle

```text
ArtifactPlan: awaiting_approval → approved | expired
DownloadJob: queued → running | retrying → verifying → completed | failed | cancelled
ExtractionJob: queued → running → completed | failed | cancelled
PaperAcquisition: created only after successful extraction
```

Completed downloaded files are immutable. PDF extraction is a new tool call and derived result, not a DownloadJob post-processing field.

## 9. Data sources

The initial 12 Sources are PubMed, arXiv, Europe PMC, bioRxiv, medRxiv, UniProt, PDB, Ensembl, Reactome, ClinVar, ChEMBL, and GEO. Catalog discovery and schema checks degrade and hide absent/incompatible tools.

## 10. Control-plane interfaces

Source Catalog exposes list/reload/detail/status/tools. Session invocation routes list/detail calls. Artifact candidate/plan/job routes list, create, approve, cancel, and retry; extraction-job routes list/detail. Permission routes list/decide requests, list/delete Grants, list Session authorizations, and PATCH Session approval mode.

Decision values are `allow_once|allow_matching|deny`; mode values are `ask_for_dangerous|always_allow`. A short-lived historical `never_ask` value migrates to `always_allow`. Agent tools create/wait for jobs; HTTP is for audit, human authorization, and UI, not a one-step bypass of download/extract semantics.

## 11. Test requirements

Each Source has registration/schema contract and a normal or empty-result fixture validating Source/Record/Citation identity and URLs; candidate-producing Sources also validate candidate identity/domain. Shared parameterized broker tests cover invalid/changing input, limit/empty/page boundaries, 429/Retry-After/5xx/timeout, response size, retry, and structured errors.

Node integration tests cover cache, permission, concurrency/retry, forged identity/URL rejection, traversal/redirect/checksum protection, no automatic download/extraction, parallel downloads before the next turn, completed-PDF gating, isolated failure, authorization/Grant cardinality, independent concurrent decisions and epochs, wait-time pause, orphan cleanup, and waking pending actions on always-allow. Real-provider smoke tests remain outside default offline unit tests.

## 12. Current implementation scope

Included: one Registry/Catalog replacing legacy brokers/direct providers; 12 public Sources with actual discovery/schema compatibility; Node permission/rate/cache/retry/CAS/audit/envelope checks; explicit download and separate extraction with persistent state; independent same-turn concurrency; governed Evidence consumption; per-action/default approval and Session matching Grants; Authorization/epoch/disconnect audit; plan/permission separation.

Excluded: private mirrors, institutional credentials, commercial databases, bulk export, patent/reference-manager synchronization, and complete Source/Invocation UI. This is the first governed public-source delivery, not completion of every future source request.

## 13. UI

The UI currently provides basic candidates, job state, cancel/retry, and invocation count. Query/download is Agent-driven and legacy search/import is removed. Complete Source/Tool/Invocation/ExtractionJob UI is not yet implemented. Permission cards expose Allow once, Allow same type, and Deny; Sessions expose Always allow.
