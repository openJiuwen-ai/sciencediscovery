# Transport recovery boundaries

- Approval HTTP delivery uses the same question ID and decision for at most
  three attempts (10-second request timeout; 250/500 ms backoff). Cancellation
  aborts the request. Transport errors and HTTP 503/504 can retry; authentication,
  missing questions, conflicting decisions and downstream delivery errors cannot.
- The adapter shares one delivery task across duplicate requests, shields it from
  HTTP caller cancellation, and retains up to 1024 completed decision receipts
  (in-flight decisions are not evicted). Conflicting decisions return 409. Receipts
  are process-local: this does not provide restart recovery or end-to-end Swarm
  execution acknowledgements. An uncertain WebSocket send is never blindly replayed.
- E2E terminal-state polling tolerates three consecutive transient read failures
  (502/503/504, selected connection errors, and Playwright read-request
  timeouts). A successful read resets this
  allowance; the original overall polling timeout still applies. Writes are not
  retried. Authentication, missing-resource and parsing errors still fail promptly.
- Recovery is observable via `approval transport retry` and `[run-poll]` logs.
  Retrying does not imply bypassing approval or marking an unfinished run complete.

Fixture cleanup is a narrow exception to the no-write-retry rule: after a
Project DELETE returns 502/503/504, read the authoritative Project list. An
absent owned fixture needs no further DELETE; a surviving fixture permits one
more DELETE with the same confirmation ID. A failed or malformed read grants no
write. Other writes, authentication errors, conflicts and uncertain transport
failures are not replayed. Research failures and cleanup failures are both
retained when a finally block also fails.

DRB source reads permit at most two GETs per URL within a 120-second source
ceiling and the original overall evaluator budget. Only transport timeouts,
connection errors and 429/502/503/504 can recover. Successful source content is
cached within that evaluation, never scores or verdicts across evaluations.
Exhausted reads still produce unknown citations with the original denominator.

Focused tests: `jiuwenswarm-agent.test.ts` (approval cases), adapter
`test_agent_runs.py` (approval cases), `run-poll-recovery.unit.ts` (read-error
classification), and `journey-deliver-result.spec.ts` (Playwright polling retry).
