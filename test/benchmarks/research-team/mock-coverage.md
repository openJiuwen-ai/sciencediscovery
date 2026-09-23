# Literature research Mock LLM coverage

These cases use actual Swarm loops, platform task/tool dispatch, storage and UI.
Only model responses are scripted. They do not measure scientific quality or
the model's ability to choose an effective research strategy.

## First batch

| ID | File | Contract |
| --- | --- | --- |
| LR-01 | `test/literature-review-lifecycle-mocked.spec.ts` | Invalid JSON produces a visible terminal error and no shell execution. Recovery is not implemented or claimed. |
| LR-02 | Same | Interrupted argument stream cannot create a shell execution or silently complete. |
| LR-03 | Same | Five children, two permits, real queued admission, all results returned, peak active lifecycle count at most two. |
| LR-04 | Same | One child exhausts its turn budget; a sibling completes and both outcomes reach the parent. |
| LR-05 | Same | A child waiting on its model expires; a queued healthy child starts afterward and returns. |
| LR-06 | Same | Cancelling a parent cancels the active child and prevents pending children from starting. |
| LR-13 | `test/literature-review-artifacts-mocked.spec.ts` | Independent child workspaces contain the same physical filename; logical artifacts and explicit versions retain distinct contents in parent LLM inputs. |
| LR-15 | Same | Final report content/version and UI preview survive a browser reload. |

The concurrent fixture is `test/helpers/research-model.ts`. Children are routed by
markers in their delegated prompt. Each response step is derived from actual
assistant tool-call IDs, so independent children and request retries do not share
a mutable step counter. Gates hold actual model responses until the test releases
them; missing tools or unexpected requests fail the fixture, not silently succeed.
Model-input tool results and fixture errors are attached for diagnosis.

## Execute

### Model progress / idle deadline boundary regressions

`services/api/src/agent-run/jiuwenswarm-agent.test.ts` additionally covers the
Node run → HTTP model gateway → upstream progress boundary. Unlike the browser
cases above, these tests fake the Swarm adapter and model; they do not start Python
Swarm or exercise the task scheduler/UI.

| Scenario | Assertion |
| --- | --- |
| Continuous transport, thinking, or text progress (three variants) | A quiet adapter must not cause idle cancellation while its model is progressing for longer than the idle deadline. |
| Model stops producing progress | The idle deadline is measured from the last progress signal, and expiration cancels the upstream request. |
| Two independent child runs | Healthy model traffic cannot refresh a silent sibling's deadline; the healthy run completes while the silent one times out. |

Status (2026-09-23): executed against unchanged production timeout wiring;
**0 passed, 5 failed** in approximately 4.3 seconds. Continuous progress was
misclassified as idle, the silence deadline was not reset by model progress,
and the healthy sibling was also cancelled. These are ordinary enabled
regression tests, not skipped or expected failures. They use a shortened 500 ms idle deadline and 1,500 ms active
stream, without credentials or real API calls. LR-05 alone does not cover this
boundary: it checks child timeout and queue release, not false idle cancellation.

### Browser cases

Use a dedicated stack, not one executing paid research. The lifecycle cases change
the global quota temporarily and restore it in `finally`. Explicit opt-in prevents
accidental interference. Run one worker; do not add real API credentials.

```bash
E2E_SWARM_TASK=1 E2E_SWARM_EXCLUSIVE=1 \
  npm --prefix .e2e run test:mocked -- \
  literature-review-lifecycle-mocked.spec.ts \
  literature-review-artifacts-mocked.spec.ts --workers=1
```

Supply the dedicated stack's `E2E_BASE_URL` and `E2E_API_TOKEN` as usual.
Fixture-only unit tests do not need an application server:

```bash
pnpm --filter @sciencediscovery/web exec tsx --test --test-concurrency=1 \
  ../../test/helpers/research-model.unit.ts
```

## Additional cases

| ID | File | Contract / prerequisites |
| --- | --- | --- |
| LR-07 | `test/swarm-tool-failure-mocked.spec.ts` | Disconnect one actual MCP HTTP request while an independent child is active; both loops recover. Requires the loopback fault proxy and `E2E_MCP_FAULT_PROXY=1`. |
| LR-08 | `test/literature-review-context-mocked.spec.ts` | Actual Swarm summary request, checkpoint reinjection and source-reference recovery. Requires isolated context-engine settings below. |
| LR-09 | `test/literature-review-sources-mocked.spec.ts` | Failed source, empty fallback result, then successful source data in actual model input. |
| LR-10 | Same | Real governed download, actual PDF extraction, reading extracted text, persisted download/audit records. |
| LR-11 | Same, three variants | HTML disguised as PDF, malformed PDF and HTTP 403 must not produce fabricated full-text evidence. |
| LR-12 | `test/literature-review-context-mocked.spec.ts` | Single-line 240 KB output; omitted interior fact recovered by query and character range; repeated range gets an advisory. |
| LR-14 | `test/literature-review-sources-mocked.spec.ts` | Two source IDs sharing a DOI retain conflicting estimates and independently correct citations in model input. This does not measure model reasoning quality. |

### Offline source stack (LR-09/10/11/14)

Build the Node API and dependencies first. On an **exclusive** Swarm test stack,
replace the Node control API entrypoint `node services/api/dist/server.js` with:

```bash
E2E_SWARM_EXCLUSIVE=1 node test/fixtures/literature-api.mjs
```

Keep the isolated stack's existing `SCIENCE_AGENT_EXECUTOR=jiuwenswarm`,
`SCIENCE_AGENT_ADAPTER_URL`, adapter token, Runner URL/token, API port/token and
dedicated `SCIENCE_DISCOVERY_DATA_DIR` environment. Do not run two control APIs on
the same port/data directory. Run the actual PaperService interpreter with its
normal PDF dependencies; no mocked extractor is injected. The fixture exposes
an authenticated, loopback-only `/e2e/literature-fixture` endpoint. It replaces
only external source transport and download HTTP responses through existing DI
seams. Unexpected download hosts fail closed. Nothing is added to production
HTTP routes, and no live literature source/API key is used.

Run `literature-review-sources-mocked.spec.ts` with `E2E_LITERATURE_FIXTURE=1`
and `E2E_SWARM_TASK=1`. Missing fixture opt-in is reported as BLOCKED; an enabled
fixture with incorrect responses fails assertions, never becomes a skip.

### Context stack (LR-08)

Use a separate Swarm instance, not the instance running real benchmarks. Enable
its existing `react.context_engine_config.enabled`, set
`context_window_tokens: 32768`, and configure
`current_round_compressor_config.trigger_context_ratio: 0.5` with
`keep_recent_messages: 4`. Turn on `enable_context_debug` for diagnosis. Point its
summary model at the same per-run local gateway, not an external paid provider.
Then opt in with `E2E_SWARM_COMPACTION=1` and run this case alone. The test does
not rewrite Swarm configuration or simulate a compression event: failure to
observe an actual summary call/checkpoint is a failed assertion. If a deployed
Swarm version uses a separately configured summary model, that routing must be
configured before this case can run. LR-12 does not need compression enabled.

The 15 scenario IDs correspond to 17 cases because LR-11 has three variants.
Existing HTTP 503/validation cases are additional regressions, not new LR IDs.

Adding files or listing Playwright cases does not certify end-to-end success.
Cancellation, raw argument failure and child budgets must not be marked expected
failures merely to make the suite green.

## Execution record — 2026-09-23

Executed against an isolated actual Swarm stack with the real Node API, Python
adapter, Runner, browser, download manager and PDF parser. Models and literature
HTTP/MCP responses were local fixtures; no paid LLM was used. One browser worker,
no automatic retries. Compression was run separately with the settings above.

The following is the **combined final result across batches and explicit reruns**,
not a claim that the initial suite passed: **15 passed / 2 failed / 0 skipped**
for the 17 tests representing 15 scenario IDs. The two additional existing
validation/HTTP-503 regressions passed; fixture unit tests passed 7/7.

| ID | Final result | Observation |
| --- | --- | --- |
| LR-01 | PASS | Invalid arguments fail visibly without a shell execution. |
| LR-02 | PASS | Interrupted argument stream does not execute a partial command. |
| LR-03 | PASS | Five children finish through two lifecycle permits. |
| LR-04 | FAIL | Child configured with `maxTurns=1` executes a tool and then produces the scripted second model answer; it is recorded `completed`, `turnCount=1`, instead of enforcing the model-turn budget. |
| LR-05 | PASS | Child timeout releases the queued child; parent receives outcomes. |
| LR-06 | PASS | Cancellation stops the active child and prevents queued starts. |
| LR-07 | PASS | MCP request disconnection is recoverable and the independent child survives. |
| LR-08 | PASS | Actual compression runs, reinjects the checkpoint and retains a reference recoverable through `read_tool_output`; final UI answer contains the recovered evidence. |
| LR-09 | PASS | Failed source, empty alternate response and successful fallback reach actual model inputs. |
| LR-10 | PASS | Actual PDF download, extraction, text read and audit/job assertions pass. |
| LR-11 HTML | FAIL | A PDF candidate served as `text/html` is marked download `completed`; the case expects rejection at download time. This does not prove HTML was accepted by the PDF extractor or used as evidence: that downstream branch was not reached. Download completion versus content validation needs an explicit contract decision. |
| LR-11 broken PDF | PASS | Corrupt PDF downloads but extraction fails without invented full-text evidence. |
| LR-11 HTTP 403 | PASS | Denied download fails without invented full-text evidence. |
| LR-12 | PASS | Single-line interior fact recovered through search and character pages; repeated page produces an advisory. |
| LR-13 | PASS | Child artifact names and versions remain isolated. |
| LR-14 | PASS | Conflicting source estimates retain separate source attribution. |
| LR-15 | PASS | Report content/version remains after browser reload. |

Test-only corrections made during execution:

- Scope navigation locators to project/session panels, and do not collapse an
  already-expanded child card before opening its conversation.
- Preserve model/approval overrides when PUT replaces session settings.
- Decode Swarm's Python-repr result wrapper before inspecting the enclosed JSON.
- Derive character offsets from actual search results, not presumed stdout offsets.
- Recognize forked compression by its final instruction even when tool schemas
  are retained, and return the requested `coverage_check` / `state_snapshot`
  blocks. A dedicated fixture unit test covers this routing.

Production behavior was not changed or assertions weakened to hide the remaining
failures. One earlier malformed Mock-response run was followed by Swarm management
timeouts; that environment was restarted before rerunning dependent cases. Those
interrupted attempts are not counted as final passes.

Local evidence root: `/root/.tmp/lr-mock-run-WVIKrJrQ/` (not committed). Relevant
logs: `tests.log` (initial batch), `sources.log` (LR-12 and HTTP-503 passes),
`envelopes.log` (final six source cases), `compaction-fixed.log` (LR-08).
Matching result directories contain failure traces and screenshots; `journey-reports/`
contains per-case reports. The final compression run passed in approximately
2.8 minutes; one recorded compression reduced context from 10,600 to 7,266 tokens.

### Follow-up fixes (2026-09-23)

The table above records the pre-fix baseline, not current expected behavior.

- Model gateway progress now renews the owning run's idle deadline, including
  text, thinking and tool-argument chunks. Silence still expires; sibling
  traffic and unowned default-route housekeeping cannot renew another run.
- Task model requests now emit admission events before going upstream.
  Subagent turn limits no longer depend on display events or tool-result count.
  Explicit housekeeping and the pinned forked-compaction prompt are excluded.
  LR-04 now requires exactly one upstream child request and no second-answer
  marker. Its expected terminal status is `timed_out`, with `maxTurns=1` in
  the error, matching the existing lifecycle contract and unit test. The
  earlier expectation of `failed` was incorrect; budget enforcement was still
  genuinely missing because the baseline child completed its second request.
- PDF download completion now requires a PDF header in a bounded prefix.
  HTML/empty responses fail validation before final-file publication; corrupt
  PDFs with a header still reach the separate extraction boundary.
- LR-16 explicitly injects upstream HTTP 503, cancels, then executes a healthy
  tool-backed request in the same session without restarting services. It
  checks the shared MCP path remains usable. This does not prove the cause of
  the earlier management timeout or cover prolonged memory/resource pressure.

No live provider calls or paid research evaluations are needed for these
regressions. The local stack is isolated and browser tests run with one worker.

Final verification on the follow-up code:

| Suite | Result |
| --- | --- |
| Node Swarm agent/model gateway, governed downloads, subagent lifecycle | 111 passed, 0 skipped |
| Python Adapter suite | 212 passed, 9 skipped (7 opt-in live gateway scenarios, 2 real-LLM cases) |
| Research model and literature source fixtures | 8 passed |
| All 15 LR scenarios and their variants, LR-16 recovery, existing validation/HTTP-503 cases | 20 passed, 0 skipped, 7.1 minutes |
| Artifact manager/API builds and whitespace check | Passed |

The browser run uses actual Swarm execution, Adapter, API, Runner and PDF
extraction, with scripted external model/source transports. It verifies
integration, not real-model research quality or prolonged resource stability.
Both previously failing scenarios now pass: LR-04 prevents the second child
model call, and LR-11 HTML rejects content before download completion.

Local browser evidence: `/root/.tmp/lr-mock-run-WVIKrJrQ/final-fix.log` and
`final-fix-results/`; Node/Python output: `/tmp/sd-boundary-final-ut.log` and
`/tmp/sd-adapter-regression.log`. These runtime files are not committed.
