# Content-addressed storage (CAS)

ScienceDiscovery stores immutable audit and artifact payloads in the `@sciencediscovery/cas` package. Business modules use the package API instead of implementing their own storage layout. CAS references use the shared `CasObjectRef { hash, size }` schema.

## Addressing and layout

`CasStore` hashes the exact content bytes with SHA-256. A lowercase 64-character digest is both the object identity and its address:

```text
<data-dir>/cas/sha256/<first-two-hex-digits>/<full-digest>
```

The algorithm segment leaves room for a future address format, while the two-character fan-out avoids a single large directory. Hashes are validated before resolving a path, so caller-controlled values cannot escape the CAS root.

The package exposes:

- `hash(content)` and `sha256(content)` for in-memory bytes or strings;
- `sha256File(path)` for streaming file hashing;
- `put(content)` and `putFile(path)` to persist content and return its reference;
- `has(hash)` for an existence check;
- `read(hash)` to retrieve bytes;
- `verify(hash)` to retrieve and re-hash an object.

`put` and `putFile` reuse an existing address. New objects are written to a temporary file and atomically renamed within the CAS filesystem; callers never observe a partial final object. `putFile` streams the source, avoiding a full-file memory copy. Integrity-sensitive consumers must call `verify`: the normal write path uses existence for deduplication and does not re-read every existing object.

## CAS and workspace change detection

CAS does not watch workspace paths and does not decide whether a file changed. Runner and API workspace snapshots compare `size:mtimeMs` fingerprints before and after execution. Those diffs produce `createdFiles` and `modifiedFiles`; provenance code then reads the reported files and stores their bytes in CAS.

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

## Lifecycle and recovery

CAS is append-only: there is no object mutation, delete, prune, or listing API. Deleting a Session may remove its physical workspace and execution records, but retained project artifacts continue to resolve through CAS. Deleting a Project can leave unreferenced CAS objects.

Garbage collection is outside the current implementation. A future collector must first mark every live `CasObjectRef` in artifact versions, derivations, execution and prompt manifests, MCP/web audit records, paper records, and environment mirrors, then sweep only unmarked objects. Age-only deletion is unsafe because long-lived project artifacts can outlive their originating Session workspace.

An interrupted write can leave a `.tmp` file, but never a partial final-address object. Operators may remove stale temporary files only when no writer is active. A failed `verify` means the stored bytes do not match their address; callers should report corruption rather than overwrite the immutable address in place.
