# Review and Provenance

Reviewer Specialist, claims/evidence, content-addressable storage (CAS), and Prompt Manifest make Artifacts traceable to recorded executions, outputs, or external records. User behavior is in [Runtime behavior](../reference/runtime-behavior.md#permissions-and-reviewer).

## 1. CAS

CAS stores verifiable content at its SHA-256 address, deduplicating identical bytes and allowing later re-hashing. `@sciencediscovery/cas` uses `.sciencediscovery-data/cas/sha256/<first-two>/<full-hash>` after validating 64 lowercase hex characters. `put`/`putFile` verify an existing object or atomically rename a pid/UUID temporary file and return `{hash,size}`. `read`, `verify`, and `has` retrieve, hash-check, or test presence. Objects are immutable and this iteration has no deletion/GC interface.

Writers include provenance (code/stdout/stderr/files), Prompt Manifest (prompt/messages/response), MCP broker (request/raw/normalized result), and paper vision (request/raw response). Environment revisions use the same hash convention on the runner side. Review/provenance verifies references; previews/diffs/audit read content. Lightweight usage records refer indirectly through manifests. See [CAS](cas.md) for the package contract.

## 2. Execution records and Artifact association

Each sandbox run appends an `ExecutionRun` under `.sciencediscovery-data/execution-runs/<sessionId>.json`: tool/language, CAS references, exit code/times, environment revision, kernel mode/id, permission epoch, `networkPolicy` (the sandbox network mode the run actually used, `"none"` by default) and `networkAccessRevision` (the policy revision when an allowlist applied), `sandbox: "bubblewrap"`, changed files, status, plus:

- `workingDirectory`: actual sandbox cwd, legacy placeholder `workspace`, or `unavailable` before execution.
- `envSnapshot`: CAS reference to canonical sorted JSON of the effective environment, `null` when unavailable, absent in legacy records.

Ephemeral execution records the exact `--clearenv` injection; persistent kernel/shell records the worker environment after evaluation. Provenance UI shows cwd and a collapsed **Process environment**, separate from **Managed package environment**, and labels missing legacy snapshots instead of failing.

Each generated file appends an `ArtifactDerivation` with path, CAS reference, and execution IDs. This audit does not automatically make every diff a visible Artifact. Upload, MCP download, collected job output, or `declare_artifact` creates/appends a Project Artifact. Identity is `(projectId,name)` with stable `artifact_id`, origin, and creation-Session snapshot. Session deletion may remove its workspace but preserves Artifact versions and CAS, and provenance explains that the source Session was deleted.

Text-version diffs are calculated on demand from CAS with common prefix/suffix and added/removed/context lines, capped at 5000 lines per version, and are not persisted.

## 3. Prompt Manifest

Each model turn records model and endpoint host, CAS references for system/input/response, skill ID/hash/version/revision, optional specialist, token/cost, runtime settings, and `redactionStatus` (`not-applied` or `not-required`). There is no automatic secret redaction. `ModelInvocationUsage` stores only usage/time and manifest reference, not original content. Current call kinds primarily distinguish `task` and `paper-vision`; legacy kinds remain readable.

## 4. Reviewer Specialist

Review is disabled until explicitly enabled. **Run review**, explicit conversation request, or `review_checkpoint` runs independently and does not determine main-run success. Quick review checks Markdown citations and computation provenance/Evidence links, persists normalized findings, renders a Reviewer card, and injects a summary into later main-agent context. Findings are read-only and do not mutate an Artifact or force another run. Smart/Deep extend the same checkpoint and finding contract.

## 5. Claims and Evidence

- `Claim`: sentence-level assistant assertion with structured `[TYPE:ID]` references and review/turn IDs.
- `EvidenceItem`: deduplicated origin union: `mcp-record`, `paper`, `execution`, `artifact`, `remote-job`, or `user-input`.
- `EvidenceLink`: claim-to-evidence `supports`, `context`, or `contradicts` relation.
- `contentScope`: MCP content is `curated-record`, `abstract`, or `metadata`; `fullTextRetrieved` becomes true only after successful `paper_extract_pdf`, which is the condition for claiming the full text was read.

## Related documentation

- [Control plane](control-plane.md)
- [Science connectors](science-connectors.md)
- [Runtime behavior](../reference/runtime-behavior.md)
