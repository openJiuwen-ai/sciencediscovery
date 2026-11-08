# Async requests and CI contracts

Apply these rules when changing browser polling, async tool output, or CI journey scheduling.

## Browser requests

- Bound each polling and background-preview request. Cancel requests when their session or evidence revision becomes obsolete; removing a Promise from a cache does not cancel its fetch.
- Deduplicate concurrent preview consumers. Release pending entries and timers on success, failure, and cancellation so a later refresh can retry.
- Account for the browser's per-origin connection limit: stale previews and live streams can prevent repair controls from reaching the server even when the endpoint itself is fast.
- Retry only known-idempotent reads, with a deadline and a finite attempt budget. Preserve HTTP and business failures; never replay writes automatically.

## Async UI assertions and timers

- A terminal run or an expanded disclosure does not imply its lazy tool output has rendered. Wait for the expected visible content, retaining the original content assertions.
- Timer doubles must implement cancellation. Count active timers rather than every callback ever scheduled with the same delay.
- Cover a hung first request followed by a successful refresh, obsolete-request cancellation, and retry after a request deadline.

## CI journey isolation and evidence

- Run fresh journeys first on a pristine stack and global journeys on a separate stack. Do not rely on test-file collection order or bypass isolation guards.
- Keep batch keys consistent across execution, result directories, reconciliation, summaries, and fixtures. Reject missing, duplicate, failed, or incorrectly attributed evidence.
- Trace environment values from the caller through the execution entry point. Scientific-environment readiness belongs to journeys that need it, with both per-request and overall deadlines.
- Read logs and traces for the failing head. Separate scheduling/evidence failures, transport failures, and product assertion failures before choosing a fix.
- Report validation against its exact head and execution backend. Collection, unit regressions, native browser journeys, Swarm journeys, and remote gates establish different facts. Never describe an unexecuted suite as passing.

## PR #931 regression evidence

At head `1605eedd`, [CI run 42399903846](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/42399903846) failed UT, research, and standard-config:

- The Stop test double counted canceled repair-card request deadlines as live grace timers.
- Research output contained the expected recovery text, but the test read the DOM once before async loading finished.
- The MCP repair-card journey reproduced locally while stale preview requests accumulated. Canceling obsolete previews and bounding requests made that native browser journey pass. The underlying preview-service stall remains unconfirmed; native validation does not establish Swarm CI success.

Regression coverage lives in `apps/web/tests/QueuedStopTarget.test.tsx`, `apps/web/tests/research-background-tasks.test.ts`, and `test/swarm-research-mocked.spec.ts`. The repair flow is exercised by `test/journey-custom-mcp.spec.ts`.
