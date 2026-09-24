# Moving the existing suites onto the shared plan

What `pnpm ci:ut`, `pnpm ci:st` and `pnpm ci:e2e` used to run as three
hand-maintained lists of commands is now one plan, selected from the tags each
test declares in its own source. This file records where every case went, and
why the ones that left the shared suite left it. It is the answer to "did the
migration quietly drop something"; the mechanics are in
[README.md](README.md), the entry points in
[../../../CONTRIBUTING.md](../../../CONTRIBUTING.md).

## The one selector

Defined once, in [profiles.mjs](profiles.mjs), as the `pr` profile's tag
dimensions; `pnpm test:policy` prints it and the selector derived from it:

```
(category:ut or category:st or category:e2e)
  and os:linux and arch:amd64
  and npu:none and (model:none or model:mock) and judge:none
  and status:reviewed
```

against the single target `os=linux, arch=amd64`.

`pnpm test:shared` runs all of it. CI runs the same plan as slices that
partition it — `category` is single-valued and required, so `ut`, `st` and
`e2e` cover it exactly once each.

Nothing in that selector can be satisfied or defeated by the machine a run
happens on. The plan is frozen from source before anything looks at the host,
and every planned identity must then report a pass: `selected == 0`, a missing
capability, a skip, or `executed != planned` are all failures of the run.

## What each old entry point became

| Before | Now |
| --- | --- |
| `ci:ut` → install, build, 9 pnpm workloads, then the sandbox package in a QEMU guest | `--slice ut` (`category:ut`) |
| `ci:st` → `bash test/api/run_m1_smoke.sh` | `--slice st` (`category:st`) |
| `ci:e2e` → `bash .ci/run-e2e.sh mocked` | `--slice e2e` (`category:e2e`), which still drives `run-e2e.sh` for the stack lifecycle |

The checks that are a command rather than a framework test —
`scripts/check-architecture.mjs`, `pnpm typecheck`, and the harness's own
regression suite — keep one command identity each in [checks.mjs](checks.mjs)
and are planned and counted like any other case. `pnpm ci:selftest`
(`node --test .ci/*.test.mjs`) and `pnpm binary:test`
(`scripts/binary-release/*.test.mjs`) needed no command entry: their files are
ordinary tagged Node tests and are collected as such.

UT used to be split into a host tier and a guest tier, because the CodeArts
pool could not create the user namespaces bubblewrap needs and those tests had
to run inside a QEMU guest. GitHub's runners create them natively, so with
CodeArts gone the split has no subject: UT is one slice, and the capability a
test actually needs is the `sandbox:bubblewrap` tag the plan turns into a
preflight.

## What stayed out of the shared suite, and why

These were collected, tagged, and then deselected by the selector. None was
deleted, and each still has a way to run.

| Source | Identities | Tag that excludes it | Why |
| --- | --- | --- | --- |
| `services/memory-graph/tests/test_smoke.py`, `test_upsert_tool_call.py`, `test_webpage_content.py`, `test_webpage_evidence.py` | 77 | `status:external` | Need a live Neo4j server (`SCIENCE_AGENT_MEMORY_GRAPH_TEST_NEO4J`). Previously a `pytest.mark.skipif` that reported green with nothing run. |
| `packages/executor/src/remote-runner-docker.test.ts` | 1 | `status:external` | Deploys to a real SSH machine. Previously `{ skip: !OPT_IN }`. |
| `scripts/binary-release/runner-sea.test.mjs` (SEA boot case) | 1 | `status:external` | Boots a packaged single-file binary; previously `skip: RUNNER_SEA_SMOKE !== "1"`. Its sibling static case stays in the plan. |
| `test/agent-run-componentization.spec.ts`, `e2e-auth.spec.ts`, `gateway-token-recovery.spec.ts`, `issue-143-proxy-settings.spec.ts`, `issue-37-composer-height.spec.ts`, `issue-44-background-timeline.spec.ts`, `issue-44-session-stop.spec.ts`, `session-run-api-queue-stop.spec.ts`, `session-run-queue-stop.spec.ts`, `subagent-rename-and-align.spec.ts`, `timeouts-runtime-status-user.spec.ts` | 42 | `status:legacy` | The `e2e.legacy` quarantine: journeys whose egress and model use are not audited. Unchanged group, still reachable with `CI_ALLOW_LEGACY=1 pnpm ci:e2e:legacy`. |
| `test/issue-67-34-inline-cards.spec.ts`, `test/journey-real-request.spec.ts`, `test/literature-review.spec.ts` (main journey) | 4 | `model:real` | Drive a live LLM. `CI_ALLOW_REAL=1 pnpm ci:e2e:real`. |
| `test/api/agent_loop_real_smoke.ts` | 1 | `model:real` | The `st.agent-loop-real` layer. `CI_ALLOW_REAL=1 pnpm ci:st:real`. |
| `services/runner/workloads/npu-smoke-test.py` | 1 | `npu:required` | Needs an Ascend device, driver and MindSpore runtime. `CI_ALLOW_NPU=1 pnpm ci:st:npu`. |
| `services/runner/src/macos-seatbelt.test.ts` | 5 | `os:macos` | Assert the macOS Seatbelt sandbox. They are planned on a macOS/arm64 target, never on this one. |
| `services/api/src/environment.test.ts` (macOS package spec case) | 1 | `os:macos` | Same: the case asserts macOS executable paths. |

The external memory-graph cases remain Neo4j-specific. The late-goal
provenance regression also has a separate `status:reviewed` local-backend
variant with a pytest-owned temporary data directory, so the PR UT plan
executes that behavior without requiring a Neo4j service.
| `services/adapter/tests/test_gateway_live.py` | 6 | `status:external` | Talks to a live JiuwenSwarm gateway whose model is the scripted stub, one scenario per stub start. Previously `skipif(not JIUWENSWARM_GATEWAY_URL)` and a `skipif` per scenario; a selected case now fails with what to set, and scenarios are chosen with `-k`. |
| `services/adapter/tests/test_real_llm.py` | 2 | `model:real`, `status:external` | A real model behind `/agent/runs` and a real gateway. Previously `skipif` on `REAL_LLM_*` and `JIUWENSWARM_*`. |
| `services/api/src/server.test.ts` (the subagent cases that delegate through the scripted `task` call) | 17 | `status:unreviewed` | On JiuwenSwarm, ScienceDiscovery's task-delegation bridge is off by default, and with it on, the nested run stalls the parent in the 0.2.6 gateway (gaps 1a and 10 of the JiuwenSwarm migration status). Previously `{ skip: onJiuwenSwarm && … }`, which the collector rejects as environment-dependent. They pass on the built-in loop (`SCIENCE_AGENT_EXECUTOR` unset), which no gated run on this branch uses, and return with the `executor` dimension. |

Deselection happens before execution, not at run time. A pytest item the
selector did not take is deselected by the plugin; a Playwright journey in the
same position is deselected by the `mocked` project's `grepInvert` while a plan
is being executed, so it never runs and never reports the skip the plan would
have to count. Collection still sees all of them, which is what makes the table
above checkable: `catalog.json` holds every identity, `plan.json` holds the
selected ones, and the difference is exactly this list.

Everything else that `ci:ut` + `ci:st` + `ci:e2e` reached is in the shared
plan. No assertion was weakened and no test was deleted to get there.

## On `feat/jiuwenswarm`

This branch runs agent turns on JiuwenSwarm, behind the adapter, and the plan
came to it with that as a fixed part of the layers rather than a choice of the
machine: `pnpm ci:ut` wraps the shared runner in `scripts/with-jiuwenswarm.sh`,
and the E2E slice drives `run-e2e.sh`, whose backend is JiuwenSwarm unless
`CI_E2E_BACKEND=legacy` asks for the built-in loop. The adapter's own suite,
which no CI step ran before, is collected as a fifth Python project.

Two things here still do what the plan exists to stop, and are left for the
change that adds the `executor` dimension from issue #126:

- `services/api/src/server.test.ts`, `run-cancel.test.ts`,
  `agent-run/jiuwenswarm-agent.test.ts` and `services/launcher`'s
  `cli-options.test.ts` and `serve.test.ts` branch their assertions on
  `SCIENCE_AGENT_EXECUTOR`. Selection does not read it, and the layer sets it
  the same way everywhere, so a gated run always takes the JiuwenSwarm branch;
  the built-in-loop branch of those assertions is exercised by nobody. With
  `executor:native|jiuwenswarm` as a planned dimension each would be an
  instance of its own, told its backend by the plan.
- `run-e2e.sh` runs the JiuwenSwarm checks (`test/contract/jw-only/live.mjs`)
  after the journeys. Their outcome is part of the layer's exit code, but they
  are a list in a script, not planned identities, and `CI_E2E_JIUWENSWARM_CHECKS`
  can change which of them run.

## Conditional declarations that became deterministic

The migration's other half was removing every way a case could decide at run
time not to run. Cases that stayed in the shared suite had their environment
branch replaced by an assertion; cases that genuinely need something the
shared target does not have were retagged and left the selector instead (the
table above).

- **Sandbox probes** — `services/runner/src/{server,sandbox-network,sandbox-launch,sandbox-process}.test.ts`,
  `services/api/src/evolution/sandbox.test.ts`, `services/launcher/src/preflight.test.ts`
  and the evolve suites no longer answer "no sandbox backend on this host" with
  a skip. They are `sandbox:bubblewrap`, and a run whose host
  cannot create user namespaces fails preflight with `BUBBLEWRAP_UNAVAILABLE`
  before a single test body runs.
- **Interpreter and toolchain probes** — `pytest.importorskip`, "no host
  Python 3 interpreter", "bash unavailable", "no system CA trust store" and the
  `uv sync --extra candidates` branch are gone. The shared runner installs the
  five service virtualenvs and the workspace build as its own preparation, so
  their absence is a preparation failure with a log, not a quiet skip.
- **Running as root** — `services/launcher/src/preflight.test.ts` skipped its
  "rejects a data directory it cannot write" case under uid 0, because mode
  bits do not restrain root. The case is unconditional now and the UT slice
  refuses to start as root (`NON_ROOT_REQUIRED` in preflight), which is the
  same fact stated where it can be fixed instead of where it is discovered.
- **Live-service probes** — the Neo4j `skipif` chain became the
  `status:external` tag above, so a run without Neo4j selects the same plan it
  always selects and simply does not contain those cases.
- **Playwright preconditions** — `requireFirstRunState` and the writable
  Skill-library precondition in `test/journey-compact-process.spec.ts` used to
  report BLOCKED when the stack held records from an earlier run. The E2E
  layer starts its own stack on a run-scoped data directory, so that state is
  now an isolation failure and asserted as one.
- **`SCIENTIFIC_ENVS`** — `test/journey-prepare-environment.spec.ts` (J3) was
  skipped in every default CI run, because the layer set `SCIENTIFIC_ENVS=0`
  and the journey reported its unmet precondition. The shared E2E slice sets
  `E2E_SCIENTIFIC_ENVS=1` and the journey asserts the managed Python base is
  ready. This is the one migration change that adds work to the merge gate:
  the layer now provisions a managed environment, which reaches the configured
  package channels. Keeping the old behaviour would have meant a planned
  journey that can only report a skip, which the plan counts as a failure.

## Reading a run back

Every run writes its plan and its accounting next to its results:
`.test-runs/<slice>/` locally, `<CI_RESULTS_DIR>/<layer>/tagged/` in CI.

- `catalog.json` — everything collected, before selection.
- `plan.json` — the frozen plan: identity, source hash, tags, target, digest, and the
  CI profile that froze it (every profile writes to the same `<slice>/`).
- `preflight.json` — what the host was asked for and what it had.
- `summary.json` — `planned`, `executed`, `passed`, `failed`, `skipped` and
  every problem, by identity.

`node .ci/tagged-summary.mjs` turns those into the CI run summary and fails
when they do not read `planned == executed == passed`, including when a layer
stopped before producing a plan at all.
