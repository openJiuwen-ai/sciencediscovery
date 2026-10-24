# Failed execution recovery evidence

Issue #401 adds an optional adapter contract to the current managed Runner
execution path. It does not reconnect unknown jobs (#398), roll back Agent
history, restore NPU/process memory, or implement computational checkpoints for
arbitrary models. The included Python fixture is CPU-only, deterministic, and
not evidence of production model or NPU continuation support.

## Contract and adapter responsibilities

The exported types and runtime parser live in
[`packages/schema/src/recovery.ts`](../../../packages/schema/src/recovery.ts).
An adapter writes a UTF-8 JSON sidecar selected by `run_shell`'s optional
`recovery_metadata_path`. The Runner provides `SCIENCEDISCOVERY_EXECUTION_ID` to
that shell; the sidecar must copy it into `executionId`. An old sidecar left in
the same workspace cannot become evidence for another execution.

`RecoveryMetadata` version 1 contains:

- `adapter`: adapter ID and version; these identify the source of semantic claims.
- `workUnits`: IDs and completed, failed, partial, unknown or not_started states.
- `failure`: optional failed unit and reason, treated as untrusted data.
- `objects`: workspace-relative path, exact SHA-256 and byte size, result/checkpoint/
  diagnostic role, completeness state, and adapter semantic validation status.
  A verified semantic claim must name its validator. File existence is not proof.
- `continuation`: supported, unsupported or unknown capability. Unsupported and
  unknown require a reason and no points. Supported requires at least one point.
- Each point declares an adapter entry ID, resume/reuse_results mode, exact shell
  command SHA-256 and cwd, required object IDs, fixed input/configuration/program
  file hashes, and any prerequisites that cannot be checked automatically.

A point ID is not executable code. The Agent supplies its command through the
ordinary shell tool and permission flow. The framework never evaluates a
command, URL, script, pickle, or validator named inside the sidecar. Adapter
validation asserts semantic completeness; the framework separately proves byte
integrity. Real adapters must include every checkpoint shard and all relevant
program, input and configuration dependencies. Missing domain-specific checks
cannot be inferred by the framework. A nonempty manual prerequisite list blocks
continuation; it is not waived by an LLM's assertion.

Limits are 1 MiB of sidecar JSON, 1,000 work units/objects, 100 continuation
points, 64 MiB per object/input, and 256 MiB per collection or admission check.
Malformed metadata, unknown schema versions, unsafe paths and stale execution
IDs yield explicit unknown capability without changing the process outcome.

## Publication and inspection

The Runner collects evidence only after an operation returned a nonzero exit
result and joined its child, while the workspace admission/lease is still held.
Cancellation, unknown outcomes, thrown admission/transport errors, direct host
execution, and explicit handoff do not establish a recoverable failure.

Complete, adapter-verified objects must also match declared size/hash and be
regular non-symlink files. Partial/invalid files remain diagnostic evidence and
are not accepted as required recovery inputs. Validated bytes are frozen in CAS;
an immutable `ExecutionRecovery` record declares those dependencies. The existing
`WorkspaceExecution` record references that manifest and roots the entire closure
with the workspace publication. Only after this commit does the Runner publish
its recovery field. Publication failure cannot expose a usable recovery pointer.

`ManagedExecution` and `AgentShellExecution` carry optional `recovery` evidence.
The API persists it alongside the execution record. Existing `execution_status`
and Session activity reads expose it after reconnect; reading never submits a
job. Old records/tools remain compatible and report unknown/NOT_REPORTED.
Capability describes adapter support, not current readiness.

Public recovery references use `storeId` and `objectId`, not a bare local CAS
`digest`. They identify the original Runner recovery store and cannot be mistaken
for objects in the API's CAS. Original workspace version, failure, and manifest
are never overwritten when a child attempt starts. Existing CAS history retains
these roots; this change adds no cleanup policy or promise of indefinite
retention after user deletion.

## Explicit continuation

The Agent uses the existing `run_shell` tool with `recovery_context`:

```json
{
  "parentExecutionId": "original-execution-id",
  "recoveryPointId": "continue-units",
  "manifestDigest": "sha256:<64 lowercase hex digits>",
  "attemptToken": "a-new-token-for-one-intentional-attempt"
}
```

The command and directory must match the selected point. Normal code permission,
network consent, Runner allowlist, NPU selection and environment admission still
apply. No previous permission or one-use direct-host grant is inherited.

The API requires the same owner, Runner and workspace and a failed, committed
original. A durable owner/token ledger reserves a new execution ID before
submission. Same token and request returns that child, including when its outcome
is unknown; changed request conflicts. A deliberate later attempt uses a new
token. There is no automatic resubmission after a lost response.

At actual Runner admission, under the workspace lease, validation re-reads the
original rooted `WorkspaceExecution` and immutable manifest, verifies ownership,
workspace identity, nonzero joined-process exit evidence and the manifest digest,
and rechecks every required fixed CAS object against its current workspace file.
Input/configuration/program changes, missing/corrupt objects, partial outputs,
and unverified prerequisites fail closed before process launch. The effective
environment revision is checked inside the managed environment's runtime lease,
not only when the request is prepared. Rejection keeps the original unchanged.
The new execution records `recoveryContext` lineage even if admission fails.

Current-main execution records do not reliably bind every interrupted historical
job to a workspace. Controlled continuation therefore conservatively blocks when
this Runner contains any unresolved unknown execution, even an unrelated one.
It never guesses that an orphan process ended. Resolving these observations and
scoping restart isolation to the exact workspace belongs to #398; this patch
does not import its reconciliation code or clear unknown records automatically.

This first version does not automatically restore deleted or changed files from
CAS, migrate to another Runner/workspace, permit environment compatibility
exceptions, or create a dedicated UI recovery panel. Required files must still
match their frozen bytes. Out-of-band host writers are outside the workspace
lease; this is not a promise of arbitrary hostile-host filesystem isolation.

## Deterministic acceptance fixture

[`services/runner/workloads/recovery-fixture.py`](../../../services/runner/workloads/recovery-fixture.py)
prepares input, computes two of four units, atomically writes a checkpoint and
fails with a partial diagnostic. Its resume entry validates the checkpoint and
computes only remaining units; a clean run produces the same final bytes.
Runner tests delete logs and restart the manager before inspecting/resuming,
so support is not inferred from log strings. API tests cover persisted readback,
remote-reference closure, owner scoping, duplicate intents and unknown outcomes.

Focused development checks (after building dependencies):

```bash
node --import tsx --test packages/schema/src/recovery.test.ts \
  services/runner/src/execution-recovery.test.ts \
  services/api/src/shell-recovery.test.ts \
  packages/workspace/src/recovery-tools.test.ts
```

These are hermetic unit/integration checks, not a complete browser/Agent/NPU
acceptance suite. Repository CI layer commands remain those in CONTRIBUTING.md.

For a production Runner-only HTTP/sandbox journey, commit and build the checkout,
then run `node test/recovery-runner-journey.mjs`. It starts and restarts only its
own isolated `pnpm runner` process, uploads the fixture through authenticated
HTTP, verifies persisted evidence, continues and compares clean output, then
checks changed-input rejection. It writes a numbered report in a new temporary
directory and exits nonzero for failures or missing sandbox prerequisites.
This manual driver does not claim API Agent, browser or NPU coverage and is not
implicitly part of `pnpm ci:e2e`.
