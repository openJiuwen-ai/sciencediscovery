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
  (502/503/504 and selected connection errors). A successful read resets this
  allowance; the original overall polling timeout still applies. Writes are not
  retried. Authentication, missing-resource and parsing errors still fail promptly.
- Recovery is observable via `approval transport retry` and `[run-poll]` logs.
  Retrying does not imply bypassing approval or marking an unfinished run complete.

Focused tests: `jiuwenswarm-agent.test.ts` (approval cases), adapter
`test_agent_runs.py` (approval cases), and `run-poll-recovery.unit.ts`.
