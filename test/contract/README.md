# L1 contract scenarios

Replay a scripted list of HTTP requests against a backend, record what comes back
(normalised), and compare a run against a stored baseline. It checks the **interface**,
not the agent: no browser and no model. Its purpose is issue 84's L1 layer, so that a
route can move from the legacy API to the adapter and any change in what a client sees
is caught.

    node test/contract/run.mjs --coverage                       which of the 259 interface rows have a case
    node test/contract/run.mjs --record out.json                record against $E2E_BASE_URL with $E2E_API_TOKEN
    node test/contract/run.mjs --compare test/contract/baselines/legacy-linux.json
    node --test test/contract/*.test.mjs                        the tooling's own tests

## Files

| File | What |
|---|---|
| `routes.json` | The interface inventory, parsed from issue 84 (259 rows, handling per row). Not hand-edited: regenerate from the issue if it changes. |
| `cases/*.json` | Scenarios. A step lists `covers: ["GET /api/projects"]` (the row's method and path exactly as in `routes.json`), a `request`, optional `capture` (`{"id": "$.id"}`, used later as `{{id}}`), `expectStatus`, `stream` for SSE, and `always: true` for cleanup that must run after a failure. Every case deletes what it creates. |
| `baselines/legacy-linux.json` | What the legacy API answered, recorded with `--record`. **Read-only for agents**: changing it to make a comparison pass needs a human review. |
| `normalize.mjs` | Ids become `<uuid:N>` (numbered by first appearance), times, digests, workspace ids and the sandbox-specific environment name become placeholders. |

## Rules

- A row is covered when some step names it in `covers`, or its handling is `not-migrated`.
  `--coverage` exits non-zero if a case names a row that is not in the inventory (a typo).
- Recording twice on the same backend must produce identical files; if it does not, fix the
  normaliser, not the baseline.
- The baseline is recorded on the legacy API with no model configured. Cases that need a
  model, a runner or an external service are separate scenarios and say so.

## L2: run event streams

`cases/l2-runs.json` records what a client sees while an agent runs: the event stream of
`GET /api/sessions/:id/runs/:runId/events`, for a text turn, a tool call, approval allowed and
denied, cancel, a provider that rejects the key, a subagent, and resuming with `?after=N`. A case
with a `stub` starts its own scripted model (`stub-model.mjs`: text, a tool call, an HTTP failure,
a delay; one script for the main agent and one for a subagent) and registers it through the API, so
no external model is involved and every case starts from step one.

A stream step can react to an event while it is being read (`reactions`: decide a permission when
`permission.required` arrives, cancel when `run.started` arrives) and can wait for a run to reach a
terminal state (`poll`) so that cleanup does not race the run.

The recording is **profiled** (`profileRunEvents` in `lib.mjs`) so that it does not depend on timing:

- fragments of one response (`assistant.delta`, `assistant.thinking.delta`, `tool.output`) are joined;
- consecutive snapshots of one subagent step collapse to the last;
- the native agent's own evidence (`agent.record` events and each event's `evidence`) is left out,
  because it is internal to that executor and not something another executor has to reproduce.

### Comparing two executors

1. Start the legacy stack on a **fresh data directory** and `--record baselines/legacy-linux.json`.
2. Start the stack you want to check (for example `SCIENCE_AGENT_ADAPTER=1 SCIENCE_AGENT_EXECUTOR=jiuwenswarm`)
   the same way and `--compare` against that file.

`run.mjs` refuses a stack that already holds projects or models. Recording twice on the same stack
must give identical output, and every case removes what it created, so a second run passes the same
check; if it does not, a case leaks or the normaliser misses something.

Which differences matter is a judgement, so they are listed rather than hidden: see
"Known differences between executors" below.

## Known differences between executors

Measured by recording the legacy API's run event streams and comparing the JiuwenSwarm
executor against them (`baselines/legacy-linux.json`, recorded on Linux with bubblewrap).

**Fixed because a comparison showed them** (each has a test in the code that fixed it):

- The native agent announces a response (`assistant.response.started` + `settled`) for every model
  call, even one that only ends in a tool call or a provider error.
- It emits one summed `usage` event after the last model call; subagent usage is built from it.
- A tool runs under the id the model gave it, and after the response of the model call that made it.
- Tool results go through the native `ToolRegistry`: bounded output, neutralised untrusted content,
  redacted and size-bounded `details` (`__detailsBoundary`), the standard error shape.
- A tool receives the arguments the model sent; JiuwenSwarm had filled schema defaults in and dropped
  empty arrays.
- The run keeps the tool round in its final messages, so a session can move back to the native executor.

**Accepted** (`accepted-differences.json`, listed by `--compare`):

- the wording of a provider error (the `errorCode` is the same);
- **a gap, listed here so it is not forgotten**: the native agent attaches *evidence* (`agentRunId`,
  `contextRef`, `stateRef`) to each event and records `context.captured`, `state.committed` and
  `model.completed`. The JiuwenSwarm executor produces none of it, so the trajectory view of such a
  run has nothing to show. Reproducing it needs the executor to record its own context and state.

- **a gap seen through the full mocked E2E group** (`CI_E2E_BACKEND=jiuwenswarm`, not required to pass
  for #86): `issue-77-wake-notice` fails. The scripted model recognises the wake turn by a last user
  message starting `[Execution notifications]`; on JiuwenSwarm the wake prompt does not arrive that way
  (JiuwenSwarm keeps its own session history), so the stub runs out of script. Not yet diagnosed
  further. `issue-85-foreground-exec-inbox` passes.

**Not covered yet**: the native agent's `agent.record` evidence (left out of the profile on purpose),
parallel tool calls, reasoning/thinking streams, `tool_search` and deferred tools (the JiuwenSwarm
executor offers every tool up front), long-running tools, and errors other than a 401.

- `POST /api/model-catalog/refresh` has no case on purpose: it downloads the live model catalog
  (`origin: "downloaded"`), so its answer changes with the outside world.

## Checks that only make sense on JiuwenSwarm

`jw-only/live.mjs` runs against a stack started with `--jiuwenswarm` : `history` (the second turn reaches the model with the first in its
context), `history-restart` (still so after JiuwenSwarm itself was restarted; needs `LIVE_RESTART_CMD`) and `todo-plan` (JiuwenSwarm's todo tool drives the plan). There is nothing to compare them with on
the built-in loop, so they are not cases.

## Coverage left for the sub-issues that own the routes

150 of 254 rows have a recorded case (22 baseline cases). The rest belong to the
issue that migrates them, and each adds its cases there: skills and skill libraries (35 rows), artifacts,
review and provenance (38), MCP and data sources (21), and the remaining chat and model rows.

Two things learned while recording that the next cases need:

- Some routes leave state behind that has no delete route (skill libraries). Record and compare each on a
  **fresh data directory**; comparing on the stack that recorded shows the earlier run's leftovers.
- Give an SSE step `"stream": {"until": [], "timeoutMs": 2000}` with `accept: text/event-stream`, or the
  recording waits for a stream that never ends. Values that move on their own (exchange rates, a runner's
  host measurements) are scrubbed in `normalize.mjs`.

A skill / skill-library case was drafted and dropped before it had a baseline; it is in git history
(commit `5572e94`, reverted) as a starting point.
