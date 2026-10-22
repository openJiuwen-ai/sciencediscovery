# Managed Runner execution recovery

Issue #398 covers the current `run_shell` → API `ShellExecutions` → Runner `ExecutionManager` path, including NPU-backed shell workloads. It does not modify the legacy Host NPU Broker or implement checkpoint continuation (#401).

## Observe the original execution

Keep the returned execution ID. `execution_status` refreshes that original execution and `execution_logs` continues its retained cursor-based logs. A browser disconnect, wait deadline or API observation error does not authorize another submission or cancel the process.

The API records execution context before dispatch, without transport objects, tokens or proxy credentials. It records the original Runner ledger identity before submission when supported. `dispatchPhase` distinguishes prepared, dispatching and accepted intent. A lost acknowledgement is queried by the original ID, never submitted again.

The original five-attempt foreground observation policy remains. After exhaustion, durable observation state and exponential backoff remain available to the background reconciler. API startup and explicit Runner reconnection also schedule reconciliation. Scans have one shared flight, batches of at most four reads, and a maximum of 100 candidates per scan. Reconnection wake requests are coalesced, not dropped during an existing scan.

Inspect these independent facts:

- `state`: the control plane's current execution state; `unknown` is not a confirmed failure.
- `observation`: freshness, last Runner state/time, failure code, retryability and next retry time.
- `receipt`: stable Runner instance, acceptance boot, request digest and monotonically increasing revision.
- `evidence`: whether the process actually terminated, why, and immutable result/workspace digests.
- `finalization` / `provenance`: whether existing results and audit metadata have been committed.

401/403, missing IDs, changed Runner identity, mismatched owner/digest and unverifiable process state block automatic recovery. They never trigger a POST. A manual status inspection or authorized reconnection may recheck a blocked record. Authorization is rechecked before and after remote reads.

## Idempotency and result publication

Retries of the same owner/turn/tool-call identity reuse the original API execution ID. A changed command, target or effective permission scope conflicts; incidental epoch timestamps do not create a new run. New work in a workspace with an unresolved unknown execution is blocked until the original is reconciled.

The Runner persistently accepts an execution ID once. The same owner and canonical request digest return its existing receipt (HTTP 200); a new acceptance returns 202. Payload or owner conflicts return the same generic 409. A different owner cannot read the record (404). The ledger keeps IDs for its full retained lifetime; no tombstone deletion is introduced.

The Runner owns one SQLite OS-released writer lock per data directory. An additional Runner cannot adopt or mutate a live owner's ledger. Corrupt, missing or incompatible ledger state fails closed rather than replacing the ledger with empty storage.

The API uses SQLite observer leases and catalog compare-and-set revisions. Before running a finalizer it pins the immutable result bytes, since later clock-offset conversion may differ. Finalization performs no computation dispatch. Execution audits, generated-file derivations and workspace revisions use stable keys and reject conflicting content. Environment snapshots are checked against the original revision before successful provenance publication. Remote CAS references remain in the Runner namespace.

Only committed terminal records publish completion notifications. An old `unknown` notice is retained as history and a recovered terminal result gets one new completion notice. Unknown observations do not consume final notifications or cancel reminders.

## Restart and safety limits

- API restart or observation-network interruption can recover the original running/completed job without invoking its command again.
- Runner process loss does **not** provide a durable process supervisor. An execution without authoritative completion remains `unknown`; its workspace and selected devices stay quarantined, including synchronous execution routes.
- A durable publication journal repairs completed CAS publication/index interruptions without executing the workload. If journal evidence or the expected head cannot be verified, recovery remains blocked. A generic stale workspace mutation fence is not removed automatically without trustworthy ownership evidence.
- Legacy records missing immutable context or stable Runner identity remain inspectable, but are not automatically finalized or replayed.
- An intent interrupted before dispatch, or during its dispatch marker/network gap, is deliberately not automatically submitted. This availability trade-off prevents side effects from being replayed without proof.
- Recovery does not change the original Runner, workspace, environment, device selection or permissions. A new run/checkpoint continuation is a separate explicit operation, not observation recovery.

## Verification

CPU-only automated coverage includes lost acknowledgement, fifth failure then reconnection, API recreation, 100 concurrent inspections, two API observers, authorization/identity/digest negatives, stale clock conversion, finalizer retry, concurrent Runner submissions, process crash/restart quarantine, SQLite corruption and HTTP 202/200/409/404 contracts.

These tests are not NPU acceptance. Real Ascend acceptance must additionally verify one physical process/job, unchanged device allocation, matching result digests and retained logs through a controlled network interruption. Supervisor-based attach after Runner process death is not implemented or claimed.
