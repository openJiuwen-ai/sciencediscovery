# Content-addressed storage (CAS)

ScienceDiscovery stores immutable audit and artifact payloads in the `@sciencediscovery/cas` package. Business modules use the package API instead of implementing their own storage layout. CAS references use the shared `CasObjectRef { hash, size }` schema.

## Addressing and layout

`CasStore` hashes the exact content bytes with SHA-256. A lowercase 64-character digest is both the object identity and its address:

```text
<data-dir>/versioning/data/blobs/sha256/<full-digest>
<data-dir>/versioning/agent-state/blobs/sha256/<full-digest>
```

Both pools use OCI image layout (`oci-layout`, `index.json`, `blobs/sha256`). Only local sandbox workspace file bytes belong to the Data Pool. All other bytes and records, including stdin/stdout/stderr, read observations, prompts, responses and tree metadata, belong to the Agent State Pool. `CasStore` defaults to State Pool writes; workspace file writers explicitly select `data`. Its legacy bare-hash read interface searches both pools and the previous `cas/sha256/<first-two>/<hash>` layout. Old objects and references remain untouched. New `DataRef` and `AgentStateRef` APIs enforce the pool at compile time and runtime.

The package exposes:

- `hash(content)` and `sha256(content)` for in-memory bytes or strings;
- `sha256File(path)` for streaming file hashing;
- `put(content)` and `putFile(path)` to persist content and return its reference;
- `has(hash)` for an existence check;
- `read(hash)` to retrieve bytes;
- `verify(hash)` to retrieve and re-hash an object.

`put` and `putFile` fsync temporary bytes and publish by an atomic, non-replacing hard link, then sync the containing directory. Existing objects are integrity-checked, never repaired in place. `putFile` streams the source. Reads verify the hash; typed reads additionally verify size and pool.

## CAS and workspace change detection

Runner and API UI change projections still compare `size:mtimeMs`. Versioned `WorkspaceTree` snapshots do not trust that cache: they hash every regular file after writers settle. Linux names and symlink targets are preserved as base64url raw bytes; names are byte-sorted, case-sensitive and not Unicode-normalized. Trees preserve executable bits and empty directories, exclude mtime/uid/gid/xattr from identity, and reject FIFO/socket/device entries. Symlinks are recorded without dereferencing. Obvious changes during scanning fail the snapshot; unmanaged background writers are outside the barrier contract.

The layers therefore have separate responsibilities:

- workspace snapshots detect path-level changes for execution audit and UI events;
- CAS archives immutable bytes and deduplicates identical content;
- the artifact catalog decides which archived values are user-visible artifacts.

A timestamp-only workspace change can produce a new derivation while reusing an existing CAS object. Conversely, CAS does not make an undeclared execution output a user-visible artifact.

## Writers and consumers

| Writer | Stored content |
|---|---|
| `ProvenanceRecorder` | executed code, stdout, stderr, environment snapshots, and changed-file derivations |
| Artifact registration | uploaded, downloaded, or explicitly declared artifact bytes and versions |
| Prompt manifest | model inputs, system prompt, response, and error text |
| MCP governance broker | normalized request, raw response, and normalized result snapshots |
| Governed web broker | search and fetch snapshots |
| Paper service | PDF bytes plus vision inputs, requests, responses, and manifests |
| API environment mirror | Runner environment snapshots copied into the control-plane CAS |

Integrity checks and Reviewer Specialist use `verify`; artifact content, diffs, previews, dashboards, and governed candidate parsing use `read`. Records retain only `CasObjectRef` values rather than duplicating payload bytes.

Runner's environment store has a different revision-keyed lifecycle. It may validate values with SHA-256, but it is not a `CasStore` consumer and is intentionally not merged into this package.

## Agent state versions

`VersionStore.putRecord` hashes strict RFC 8785 JCS records with schema version and strong dependencies. `validateClosure` checks every reachable blob. Unknown record schema versions are rejected; there is no implicit in-place upgrade.

Production `createAgentRun` creates an AgentManifest (behavior plus content-derived harness build descriptor), an AgentRevision (lineage) and an initial state. Each model turn uses an awaited Runtime lifecycle: before state, actual context/model input, all settled tool results, after state, actions/event segments, then TrajectoryStep. State preserves full per-run transcript separately from compacted model history, raw observations, tool visibility/loop state, authoritative plans, artifacts, permissions, environments and child records. DurableContextStore is retained only as a context projection. ModelContextSnapshot records the exact `ProviderModelClient.invoke` input; transport authentication is excluded.

`RefStore` keeps live and append-only history roots in `versioning/refs.sqlite` (WAL, FULL). `StepCommitCoordinator` verifies record kinds, ownership and closure before a compare-and-swap transaction updates head plus history. Ref conflicts or persistence errors fail the run; UI observers remain best-effort. A crash exposes the old or new complete head, never a partially committed head. Reads and `RefStore.roots()` provide developer inspection without adding a Web endpoint. The version store must be outside the Agent workspace.

Kernel heaps, remote side effects and Memory Graph are not snapshotted; their fidelity is explicitly reference-only or non-reversible. Deferred promotion changes state/context without redefining the Manifest. This phase does not implement Fork, cross-instance recovery, GC, OCI export/import, Evaluation, or a version browser.

## Retention

CAS is append-only: there is no object mutation, delete, prune, or listing API. Deleting a Session may remove its physical workspace and execution records, but retained project artifacts continue to resolve through CAS. Deleting a Project can leave unreferenced CAS objects.

Garbage collection is outside the current implementation. A future collector must first mark every live `CasObjectRef` in artifact versions, derivations, execution and prompt manifests, MCP/web audit records, paper records, and environment mirrors, then sweep only unmarked objects. Age-only deletion is unsafe because long-lived project artifacts can outlive their originating Session workspace.

An interrupted write can leave a `.tmp` file, but never a partial final-address object. Operators may remove stale temporary files only when no writer is active. A failed `verify` means the stored bytes do not match their address; callers should report corruption rather than overwrite the immutable address in place.
