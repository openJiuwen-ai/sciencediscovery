# ScienceDiscovery CI test image

This directory defines a source-free CI toolchain image and the repository
entry points for unit tests (UT), hermetic system tests (ST), and browser E2E.
Here the `e2e` layer is the mocked browser subset, not the definition of all
E2E: public API, CLI and local-stack user journeys also qualify when they use
the real product entry path and assert user outcomes. Their separate driver
commands are not automatically run by `pnpm ci:e2e`; see
[CONTRIBUTING](../CONTRIBUTING.md#user-perspective-e2e). The existing layer
names and pipeline entry points are unchanged.

The image contains Node.js 22.19, pnpm 11.1.2, Python 3.12, uv, bubblewrap,
build tools, and Playwright's Chromium system libraries. Product source and
test dependencies are supplied only by the checkout mounted at `/src`.

## Five cumulative tiers, one source catalog

`test/support/tagged/profiles.mjs` owns every policy. `tier:l1` through
`tier:l5` declare the first tier that needs a case; the default is `tier:l2`.
Category (UT/ST/E2E), model/judge cost and execution backend remain independent.
No workflow maintains its own list of case titles.

| Tier | Event / authorization | Cumulative content | Gate / job ceiling |
| --- | --- | --- | --- |
| L1 | Every PR opened, synchronized or reopened | Architecture, docs, test catalog and E2E metadata checks; no service or browser startup | Required before L2; 10 minutes |
| L2 (`pr`) | Every PR after L1; also default-branch push | L1 + reviewed hermetic UT, ST and mock E2E; no external model credentials | Required before enqueue; UT 60, ST 30, mock E2E 90 minutes |
| L3 (`merge`) | Maintainer reviews the current head and selects **Merge when ready**; `merge_group: checks_requested` | L2 rerun on the group SHA + nine short real API journeys (including Runner wait/finish decisions) + binary smoke and Docker distribution gates | Required before automatic merge; basic worker 60 minutes including setup, target 10–15 minutes of test time |
| L4 (`daily`) | Daily at 16:00 UTC, or explicit dispatch | L3 + twelve nightly cases: DRB-58/59/62/64/75, research team, PUCT compression, J5 statistics, two provenance/card journeys, Biomni DA-13-3/DA-14-1 | Daily failure signal; each research worker 240 minutes including setup |
| L5 (`release`) | Version tag push | Same current case set and evaluation modes as L4; separate profile retained for future release-only cases; no historical baseline gate | Blocks creating the draft Release and its assets, not the already-created tag; a person publishes the draft from the Releases page; each research worker 240 minutes |

`l1` through `l5` are also explicit local profile names. `pr`, `merge`, `daily`
and `release` alias L2, L3, L4 and L5. The release policy now includes paid
research; it is no longer equal to the hermetic PR policy. Release failures
must not be worked around by moving the tag.

Run only the desired slice, or the complete cumulative profile:

```bash
pnpm ci:l1
pnpm ci:ut
pnpm ci:st
pnpm ci:e2e -- --backend jiuwenswarm
CI_ALLOW_REAL=1 pnpm ci:e2e:real -- --profile merge --backend legacy
CI_ALLOW_REAL=1 pnpm test:run --profile daily --backend jiuwenswarm
pnpm test:list --profile release --slice e2e-real --backend jiuwenswarm
```

The disjoint slices are `l1`, `ut` (excluding L1 commands), `st`, `e2e`
(mocked), and `e2e-real`. Their union is the selected cumulative profile.
`ci:e2e:real` defaults to `daily`; it always needs `CI_ALLOW_REAL=1` and live
credentials. `ci:st:real` remains a separate native-agent compatibility smoke;
it does not add a native E2E run. Adapter live UT is also accounted separately.

### Backend selection and exact accounting

For a targeted reliability check, set `CI_E2E_SPEC` and optionally
`CI_E2E_GREP`, then run `.ci/run-e2e.sh real` with `CI_E2E_REPEAT_EACH=10`.
This repeats each selected case ten times (not ten retries); the browser
configuration uses one worker and zero retries. Real runs require
`CI_ALLOW_REAL=1` and the `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, and
`E2E_LLM_TOKEN` credentials, and every repetition incurs model usage.
Omitting `CI_E2E_REPEAT_EACH` leaves normal gate execution unchanged.

Use `--backend jiuwenswarm|legacy`, `CI_E2E_BACKEND`, or the workflow's `backend`
input. `legacy` means the native loop; JiuwenSwarm is the default. The backend
changes execution identity, not selection. Run each backend explicitly if both
must gate; one backend's pass never certifies another. An explicit CLI backend
wins over the environment. No automatic second backend or fallback is added.

A browser identity contains case ID, OS/architecture and backend. The plan also
records candidate SHA, model and judge names and an evaluator/input fingerprint.
Capabilities such as `swarm-task` are execution requirements, not selector tags.
An unsupported required capability fails preflight without dropping the case.
Mock fixtures (`standard`, `research`, `literature`) still own separate stacks;
no fake research fixture is injected into real tests.

The real matrix is generated from the frozen catalog: one serialized worker holds
all L3 cases; each research case gets a separate job, with at most two workers
running concurrently. The aggregate compares every shard to the parent plan's
SHA, configuration and exact identities, then requires
`planned == executed == passed`. Missing, cancelled, skipped, duplicate or
wrong-backend results fail. Existing quarantined cases are excluded by policy
before freezing the plan and are never counted as passed.

### Parallel UT processes inside one job

`pnpm ci:ut` runs a bounded pool of two child processes by default. Set
`CI_UT_WORKERS=1` for serial diagnosis, or `2` through `4` to compare concurrency
on the same machine. The standard public Linux runner has four vCPUs and
16 GB RAM; two workers leave capacity for the shared SDK/adapter and for
subprocesses started by a test. This does not create additional Actions jobs.

Node files remain separate processes, with serial tests inside each file.
All API files retain their order because they share the wrapper's JiuwenSwarm
instance. Python projects also retain their order, while their lane overlaps
Node execution. Other Node files can use free pool slots. Every group has its
own product-data directory and reports; the SDK instance remains shared.
Dependency preparation, collection, command checks and coverage aggregation
remain outside the pool. Other slices retain serial execution.

The frozen plan and exact result/coverage checks are unchanged. A failed
group does not discard remaining groups; cancellation stops queued groups and
terminates running worker process groups. `ut/tagged/timing.json` records the
worker limit, peak active groups, CPU/memory information and each group's
duration. Worker logs and timing records stay in their original group folders.
The recorded host memory is capacity, not measured peak usage.

### Parallel mocked browser workers

The mocked matrix is frozen from the same `e2e` slice, with four independent
jobs (`max-parallel: 4`, `fail-fast: false`). No case list lives in the workflow:

| Worker | Fixture | Existing browser cases | Supplemental checks |
| --- | --- | ---: | --- |
| `standard-config` | `standard` | 19 | 9 JiuwenSwarm checks, once |
| `standard-journeys` | `standard` | 25 | None |
| `research` | `research` | 20 | None |
| `literature` | `literature` | 6 | None |

Standard mocked specs declare `isolation:global` for shared configuration,
`isolation:session` for independent session journeys, or `isolation:fresh` for
a journey that requires a pristine Skill library. Missing classifications fail
planning. The fresh-library file stays first among global-state files; the
reporter rejects a different order or multiple Playwright workers. Every file
and its steps retain their serial execution order. Each CI job has its own
checkout, service ports, runtime data, JiuwenSwarm home and reports; both
standard workers still use the **standard fixture**, not a research fixture.
Backend selection is independent and does not change the 70 browser identities.

`pnpm ci:e2e -- --shard standard-config` runs one partition; without `--shard`,
the local entry point retains the full serial suite and one supplemental pass.
Concurrent local invocations must use prepared dependencies and distinct
`CI_RESULTS_DIR`, `CI_RUNTIME_DIR`, API/legacy/Runner/evolve/memory-graph ports.
On one host, let each JiuwenSwarm instance finish binding its automatically
allocated ports before starting the next stack; separate CI runners do not
share this port allocator. Browser runs can then overlap.
The driver writes HTML into the worker's results directory, so reports cannot
overwrite each other. Leave Playwright `workers: 1` and `retries: 0` unchanged.

The existing `merge-gate` reconciles all four artifacts against the parent
plan, requires exactly one PASS for every identity and verifies all nine
supplemental checks, including their order (`skills` before `skill-switch`).
Missing artifacts, changed identities/backends, skips or failed drivers fail
the gate. The reusable `real-e2e.yml` owns real planning, workers and accounting.
Its L3 (`merge`) caller waits for L1/L2 to succeed, then `real-plan` makes the
same mocked-artifact check before paid calls. Its L4/L5 (`daily`/`release`)
caller depends only on `policy`: real planning starts alongside L1, and real
workers start as soon as their own plan is ready, without waiting for UT, ST
or mocked E2E. They do not download or reconcile mocked results as a prerequisite.
The two callers are mutually exclusive, so each run executes the real suite once.
A separate credential-free `policy` job selects the profile/backend before L1,
so a failed L1 check cannot hide the requested real suite. Real workers still
require a successfully frozen real plan and respect workflow cancellation.
This changes execution eligibility, not the final verdict: `merge-gate` still
requires every selected job and complete mocked/real accounting; any failure
continues to block creating the draft Release and its assets, which become
public only after a person publishes the draft from the Releases page.
No extra accounting job or human approval is added. The combined `e2e-results`
artifact preserves worker HTML/image links and the suite-level plan/summary.

### Merge queue and credentials: repository setup

The workflow defines a stable **merge-gate** check. In the default branch
ruleset, enable **Require status checks to pass**, add **merge-gate** from
GitHub Actions, and enable **Require merge queue**. Enabling the queue alone
does not make CI required; without required checks, it need not wait for L3.
Require approval of the current PR head and dismiss stale approvals. Start
with queue build concurrency 1 and **Only merge non-failing pull requests**.
Allow enough queue status-check time for L1/L2 + real setup/testing and the
parallel distribution jobs. Do not require a queue-only check on the PR before
it can enqueue: the same aggregate requires L1/L2 on PR and full L3 on the group.
Even a one-PR merge group receives its own run and candidate-SHA results.

L3, L4 and L5 reuse the existing **nightly-ci-ds** Environment, with **no required
reviewers and no final approval job**, as agreed in
[issue #248](https://github.com/openJiuwen-ai/sciencediscovery/issues/248):

- Variables: `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_JUDGE_BASE_URL`,
  `E2E_JUDGE_MODEL`.
- Secrets: `E2E_LLM_TOKEN`, `E2E_JUDGE_TOKEN`, `JINA_API_KEY`, `HF_TOKEN`.
- If deployment branch restrictions are configured, allow the default branch,
  intended `gh-readonly-queue/main/*` refs, version tags and explicitly trusted
  dispatch refs. No production or publication credential belongs here.

Keep model credentials in this Environment, not repository secrets.
The credential-isolation regression checks every job that references a
model token: it must declare an Environment and exclude pull-request events.
The check intentionally does not pin Environment names. To change research
endpoints, configure an Environment with the same variable/secret names and
update the research Environment in both real-plan and real-e2e in `real-e2e.yml`.

Environment variables are also used by the credential-free real-plan job so
its frozen configuration matches its workers. API secrets are injected only
into real workers. Fork PR runs remain L1/L2 even if an input requests another
profile. There is no `pull_request_target` checkout of PR code. The maintainer's
review and enqueue action are the trust decision: queued code can read the
credentials injected into its job. Repository rules and Environment settings
are administrative configuration, not created by committing workflow YAML.
After L3 and the existing review requirements pass, the queue merges without
another button. Default-branch push does not repeat the paid suite.

GitHub's behavior is documented in
[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

### Isolated JiuwenSwarm state

Every test entry sets `JIUWENSWARM_HOME` under its own `CI_RUNTIME_DIR`:
browser E2E uses `<fixture-runtime>/jiuwenswarm`, UT's wrapper uses
`<runtime>/with-jiuwenswarm/home`, and the SDK contract uses
`<runtime>/swarm-contract`. Set an explicit `JIUWENSWARM_HOME` to choose another
test-owned root. Relative values resolve against the repository root.

That root contains `.jiuwenswarm/instances.yaml`,
`.jiuwenswarm-instances/<instance>/` (config, skills, sessions and process
state), and `jiuwenswarm-<instance>.log`. `setup`, `start`, `status`, `env` and
`stop`, including the research fixture, use the same root. The process-wide
`HOME` is unchanged. `JIUWENSWARM_ROOT` / `JIUWENSWARM_SRC` still select the
pinned installation and may be shared; they do not isolate runtime state.

Parallel runs need distinct runtime roots and API/Runner port blocks (and
separate worktrees for browser reports). Do not point two concurrent runs at
the same `JIUWENSWARM_HOME`. Reusing an instance name in different roots is
supported; choose the same root again when stopping or inspecting that run.

### Real cases, prerequisites and usage

`journey-basic-real-api.spec.ts` adapts seven short scenarios from
[DeepSeek Harness's real-provider tests](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-deepseek/tests)
and [agent journeys](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/cli/tests/profiles/headless/tests).
The implementation drives ScienceDiscovery's running product through the browser
and public APIs; it does not import either backend's agent internals.

| L3 case | User goal and independently checked result | External calls |
| --- | --- | --- |
| `response` | Receive a short answer; observe real content deltas, a provider stop marker and a completed Run | Real LLM |
| `tool` | Execute `cat command-input.txt`; a marker absent from the prompt must appear in an actual tool result and the final answer | Real LLM + local sandboxed shell |
| `files` | Read and edit a file; download the exact changed contents and verify a neighbouring file remains byte-identical | Real LLM + workspace tools |
| `memory` | Reopen the Session, inspect persisted history and ask the model to recall the previous code | Two real-model turns; client reconnection, not a server restart |
| `artifact` | Deliver an artifact, continue the conversation, reopen the Session and retrieve the same immutable version | Real LLM + workspace/artifact tools |
| `workspace` | Write a relative filename in one Session; another Session in the same Project keeps its same-named file unchanged | Real LLM + workspace tools |
| `cancel` | Cancel after actual streamed output begins; reach cancelled state, complete another request and leave no active Run | Real LLM, including a cancelled request |

Every completed Run must have nonzero product-reported input/output token usage and retains
the provider usage ledger, including on failure. These replace the former MCP
echo, ordered-addition and numeric-argument probes; there is no external MCP
server or AI judge. Each case owns its Project, Session, model and files. The
basic Project disables optional skill, planning and delegation plugins through
the public API. `--backend jiuwenswarm|legacy` changes execution only; the case
list and assertions remain identical. L4/L5 inherit these seven basic cases and
two Runner-recovery cases, then add twelve nightly cases.

`journey-runner-recovery-real.spec.ts` adds two real API cases: the Agent chooses
to wait after Runner execution is blocked, or explains the failure and finishes
without waiting, according to the user's request. The waiting case also checks
card recovery after a browser reload and cancellation returned to the model.

The basic worker has no suite request or token budget and does not override
per-request model token settings. Its ledger records forwarded requests,
payload bytes and provider-reported input/output tokens across worker restarts.
Cancelled calls or responses without usage stay in `unreportedCalls`; measured
totals are incomplete when that count is nonzero. No token count is inferred
from payload bytes. A fresh isolated run uses a fresh runtime root.
Transport buffer guards and request timeouts remain. The seven basic cases have
three-minute deadlines; the two Runner-recovery cases have four-minute deadlines.
These are failure bounds, not monetary limits.

Research cost is separate and has not yet been measured. DRB-58/62/75 allow 90
minutes generation; DRB-59/64 allow 120 minutes. Nightly judge timeout is 10
minutes. Biomni generation allows 80 minutes, with up to 65 minutes for rubric
evaluation. Team generation allows 55 minutes; PUCT generation 120 minutes.
Its optional AI audit allows up to 65 more minutes when explicitly enabled
locally; both daily and release leave that audit disabled. Job setup counts toward the four-hour worker
ceiling. `fail-fast: false` retains evidence from independent workers; there
are no automatic case retries. Rebuilding a merge group repeats its model calls.
Monthly usage is the sum of actual provider usage across queue attempts,
approximately 30 daily runs and version candidates; provider rates and actual
call counts, not timeout ceilings, determine money spent.

`prepare-real-research.sh` runs only for research workers. Daily and release
set `CI_PREPARE_BIOMNI=1` only in the two Biomni shards and use
`HF_TOKEN` to download their pinned inputs. The DRB evaluator is pinned to
`852f4022d1f98fb707222e395405136e8f0e8d52`; Biomni inputs have
committed blob checksums. Missing prerequisites for selected cases fail;
they do not filter selection.

### Initial release scope and future quality calibration

L5 runs the existing eligible cases and their current assertions, including AI
judging where declared, and preserves scores/usage for later comparison. It
requires every selected identity to pass, but does not require a historical
quality baseline or apply a newly calibrated regression threshold. A green run
certifies this selected suite, not measured capability non-regression or a
complete upstream benchmark leaderboard.

The real case counts are L3 **9**, L4 **21**, L5 **21**. L4 includes
twelve nightly cases and inherits the nine L3 cases. L5 currently uses the
same cases and evaluation modes as L4; its separate profile and `tier:l5`
extension row remain available for future additions. The two Biomni cases
return to daily and release; the seeded literature-review journey remains
quarantined pending its CI prerequisites.

Broader cases and measured quality regression thresholds are follow-up work.
Stored scores retain generator, backend, judge and evaluator/input fingerprints
so a future reference dataset can use comparable executions.

### Results and dashboard compatibility

Each worker always uploads score-only `real-e2e-results-<shard>` and complete
`real-e2e-evidence-<shard>` separately (seven-day retention). The score staging
allowlist remains exact `benchmark-metrics.json`, `team-metrics.json`,
`evolve-metrics.json` plus tagged plan/summary/preflight JSON. Raw prompts,
model text, traces and credentials never belong in a score artifact.

The aggregator retains the existing **real-e2e-results** artifact for dashboard
consumers, with a single suite-level plan/summary and namespaced per-case scores.
`real-e2e-verdict` carries the aggregate failure reasons. Mock `e2e-results`
continues to contain complete HTML, linked screenshots and results. Keep large
diagnostic traces separate if that artifact exceeds the dashboard limit.

## Coverage reporting

Coverage is recorded by the runs that gate, not by a second one. The `UT` and
`ST` jobs run their layer with `--coverage` — `pnpm ci:ut -- --profile <profile>
--coverage`, and the same for `ci:st` — which measures exactly that execution
and changes nothing about which cases are selected. Each job uploads what its
run wrote, `<CI_RESULTS_DIR>/<layer>/tagged/coverage/`, as `ut-coverage` or
`st-coverage`, including when the run failed.

What a run records:

- **Node.** Each worker keeps its one-file-per-process isolation and adds V8
  coverage, which the Node processes a test starts inherit — a Runner a test
  launches from `services/runner/dist/server.js` is measured too. Much of what
  a test executes arrives through built output, so a coverage run re-emits the
  build with source maps and records built code against the TypeScript it came
  from. Each test file leaves one lcov whose records name that test file and a
  repository-relative source.
- **Python.** Every interpreter the run starts imports
  `test/support/tagged/python/coverage-hook` and measures itself: the pytest
  worker, and any Python a test launches — `services/api`'s paper tests start
  `services/paper/paper_worker.py`, which is product code no pytest run
  reaches. The data is combined into one coverage.py report over the product
  roots (`services/*/src`, the paper worker, Runner workloads, bundled
  skills), so a product file nothing imported counts as 0% rather than
  disappearing. Every start is logged with whether it could be measured; an
  interpreter without `coverage`, or a sandbox that cannot write the data
  directory, is reported rather than silently missing. Today the only
  unmeasured starts are the Runner asking the system `python3` where its
  standard library lives, which runs no product code. Python the Runner
  executes inside bubblewrap starts from `--clearenv` and so never loads the
  hook — by design, since what runs there is a test's snippet, not the
  product.
- **`manifest.json`** records the plan digest, the run's planned, executed and
  passed counts, how many Node test files owed coverage, and the Python
  process census.

The `Coverage` job `needs` UT and ST, downloads both artifacts and runs
`node scripts/coverage-report.mjs` (`pnpm coverage:report`), which only reads
and merges files: it executes no test and starts no process. It credits a
source file with everything any layer executed in it — a unit test of its own
package, another package's test reaching it through a dependency, the system
test driving it end to end — and merges records for one file line by line.
Built output, installed dependencies, the test harness and the tests
themselves are not attributed. The run page shows the merged figure for Node.js
and Python, then what each layer contributed on its own, its job result and
counts, and any Python process that could not be measured. There is no
diff-based selection: pull requests, pushes and the nightly run all report on
the whole plan the gate ran. The mocked browser E2E is not measured. Release
calls skip both the recording and the job.

A case the plan leaves out is missing from coverage for one reason, the
selector: a `status:external` case — `services/memory-graph` has 77, all
needing a live Neo4j — is absent from coverage because it is absent from the
gate's run.

Reproduce CI locally with:

```bash
export CI_RESULTS_DIR=$PWD/.ci-results CI_RUNTIME_DIR=$PWD/.ci-runtime
pnpm ci:ut -- --profile pr --coverage
pnpm ci:st -- --profile pr --coverage
pnpm coverage:report -- --layer ut=.ci-results/ut/tagged/coverage \
  --layer st=.ci-results/st/tagged/coverage
```

If a layer's job passed, every test file it ran must have left coverage and
its measured Python must have a report; the merge step fails when one did not,
because that is a pipeline defect, not a partial result. If a layer's job
failed, its upload is summarised as far as it goes and labelled partial, and
the step succeeds: nothing is re-run to fill the gap, and the job's own
failure stays the signal. Coverage percentages are informational — there is no
threshold. CI uploads separate SHA-qualified Node.js and Python artifacts
containing the merged and per-group `summary.json` files.

## Test tags and CI selection

`.ci/test-catalog.mjs` classifies every repository CI test family as a stable
case, for the CI scheduler and the merge-request result table. It is metadata
over the layer entry points above, not a second test suite and not the list of
cases a layer runs — that list is the plan. Cases inherit the environment
envelope of their layer; when one child needs a stricter capability, split it
into a separate case instead of weakening the tag. Each case has tags for all
required environment dimensions:

- `arch:amd64|arm64`
- `llm:none|stub|real|unreviewed`
- `npu:none|required|unreviewed`
- `sandbox:none|bubblewrap|seatbelt|host|unreviewed`
- `layer:ut|st|e2e`, `container:*`, and runtime `network:*`

No case carries `sandbox:seatbelt` today: the macOS Seatbelt tests live in
`services/runner/src/macos-seatbelt.test.ts` and carry `os:macos`, so the
Linux/amd64 target this repository's CI plans against never selects them. They
no longer skip themselves off macOS — a Linux run simply does not contain them,
and a macOS plan would.

List the vocabulary or cases without executing tests:

```bash
pnpm ci:tags
pnpm ci:tags -- --json
pnpm ci:list
pnpm ci:list -- --tag layer:e2e --tag llm:stub --tag arch:amd64
pnpm ci:list -- --tag llm:none,llm:stub --exclude npu:required
pnpm ci:list -- --tag arch:arm64 --json
```

Repeated `--tag` clauses are AND conditions. Commas inside one clause are OR,
and every `--exclude` removes a match. `--case <id>` selects exact case IDs and
can be combined with tags. JSON output is intended for CI matrix generation.

Run the selected existing entry points with the same filters:

```bash
pnpm ci:run -- --tag layer:st --tag llm:stub --tag arch:amd64
pnpm ci:run -- --case e2e.mocked
```

`ci:run` requires at least one positive `--tag` or `--case`, verifies the
native architecture, and preflights every selected case before starting any
of them. Live cases additionally require `CI_ALLOW_REAL=1` and their documented
credential variables. Legacy E2E requires `CI_ALLOW_LEGACY=1`. The NPU smoke
requires `CI_ALLOW_NPU=1` and an explicit `SCIENCE_AGENT_NPU_PYTHON` from the
dedicated NPU environment; it fails closed in this generic image. Its catalog
entry explains the host requirement.

E2E agent turns run on JiuwenSwarm behind the adapter, `run-e2e.sh`'s
default and the backend the product ships; after the journeys the layer runs
the JiuwenSwarm checks (`test/contract/jw-only/live.mjs`) against the same
stack, and their outcome is part of the layer's exit code.
`CI_E2E_BACKEND=legacy` runs the same journeys on the built-in loop while it
still exists, with reports under `e2e[-group]-legacy`. The layer installs and
starts JiuwenSwarm itself (`scripts/jiuwenswarm.sh setup` then `start`) before
the stack comes up, so nothing needs to be running beforehand; cache
`.sciencediscovery-data/jiuwenswarm` to avoid repeating the ~1.5 GB install on
every run. UT's agent turns run on JiuwenSwarm too: `pnpm ci:ut` wraps the
shared runner in `scripts/with-jiuwenswarm.sh`, which starts one instance and
one adapter for the whole run.

## The sandbox capability

UT is one layer. A test that drives a real bubblewrap sandbox says so with
`sandbox:bubblewrap`, and that is the whole mechanism: the plan turns the tag
into a preflight, and a host that cannot create the user namespaces bubblewrap
needs fails the entire run rather than quietly running the rest.

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok
```

On Ubuntu 24.04 a failure here is usually the AppArmor restriction on
unprivileged user namespaces, which every job that needs the sandbox clears
with `sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0`.

When adding a UT test, put it in the package or suite that already matches its
requirements, and never weaken an isolation assertion so a test can run without
the sandbox; see [.agents/skills/ci/SKILL.md](../.agents/skills/ci/SKILL.md).

`pnpm ci:catalog:check` is the guard. It fails when a scheduler case has an
unknown tag or the wrong number of values for a dimension, when a workspace
package's test file sits outside the shared runner's collection patterns and so
would be run by no layer at all, when a package has a test script but no test
file, when a layer runs something that is not a slice of the shared plan, or
when an entry point drifts off that slice. `pnpm ci:selftest` runs the
regression tests for that guard, and the UT layer runs it.

## Build

Build the current host architecture. Using `.ci` as the build context makes it
impossible for the Dockerfile to copy the product checkout into a layer.

```bash
docker build --file .ci/Dockerfile --tag sciencediscovery-ci:test .ci
```

Build both supported Linux architectures and publish a manifest:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file .ci/Dockerfile \
  --tag <registry>/sciencediscovery-ci:<tag> \
  --push \
  .ci
```

For a local, non-pushed multi-architecture artifact, replace `--push` with
`--output type=oci,dest=sciencediscovery-ci.oci`. Docker cannot `--load` a
multi-platform manifest into its classic local image store.

## Source and result mounts

The repository has no submodules, so a plain checkout is enough. Mount a real
checkout rather than a linked Git worktree: a worktree's `.git` file points at
the main repository and is not portable into the container.

All commands use the same mounts. `<host-results>` should be a new or empty
directory for the run, and it must already exist and be owned by the invoking
identity: Docker creates a missing bind-mount source as root, and the container
then cannot write its reports.

Mount the checkout at `/src`, which is also the image's `WORKDIR`. Do not mount
it at `/workspace`: the Runner's bubblewrap sandbox mounts the Session
workspace over that exact path, so a checkout there is shadowed inside the
sandbox. Five Runner tests fail that way — the two `scientific-execution`
subcases lose their fake managed interpreter and exit 127, and the three NPU
Broker cases see their `/workspace`-prefixed arguments re-anchored into
doubled paths.

```text
-v <repo>:/src
-v <host-results>:/ci-results
```

The container installs into the mounted checkout, so `node_modules` ends up
bound to the container's pnpm store. The next host command then aborts with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, because pnpm wants to purge the
modules directory and refuses to do so without a TTY. Rebind it with
`CI=1 pnpm install --frozen-lockfile` before working on the host again, or give
the container a checkout of its own.

Run with the checkout owner's numeric identity so generated dependencies,
build output, and reports remain writable on the host and permission-sensitive
tests do not acquire root's bypass privileges:

```text
--user "$(id -u):$(id -g)"
```

The image also defaults to its unprivileged `node` user (UID/GID 1000), but the
explicit flag is portable to Linux agents whose checkout owner uses another
numeric identity.

Runner tests and mocked journeys execute bubblewrap inside Docker. Use the same
non-privileged sandbox allowances as the product's checked-in Compose file:

```text
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt systempaths=unconfined
```

Do not add `--privileged` or mount the Docker socket. A host that denies
unprivileged user namespaces still blocks the real sandbox; see
[Known limits](#known-limits).

Optional cache volumes speed up repeated dependency and browser installs:

```text
--mount type=volume,source=sciencediscovery-ci-cache,target=/ci-cache
```

That volume is not only a cache: CI points `CI_RUNTIME_DIR` below it, so it also
holds the E2E stack's `data/envs`. (Without that variable — a laptop run — the
E2E layer falls back to the repository-local, gitignored `.e2e-data/` instead of
the data directory a personal instance uses.) Those service environments are *editable*
installs whose `.pth` files record the absolute source path, so a volume
populated from one checkout location is unusable from another. After changing
the mount path, drop `/ci-cache/sciencediscovery-e2e` and
`/ci-cache/sciencediscovery-tests` (or the whole volume); otherwise the stack
starts and the service dies with `ModuleNotFoundError`, and the E2E layer
reports BLOCKED because it never became healthy.

## One command per layer

From the repository root, substitute absolute host paths for `<repo>` and
`<host-results>`.

UT:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test pnpm ci:ut
```

ST:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test pnpm ci:st
```

E2E (mocked only):

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env E2E_COMMIT_SHA="$(git rev-parse HEAD)" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test pnpm ci:e2e
```

The selector can replace the final command on capability-driven workers. For
example, this runs only hermetic ST cases compatible with amd64 and no NPU:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test \
  pnpm ci:run -- --tag layer:st --tag llm:stub --tag arch:amd64 --exclude npu:required
```

Set `CI_RESULTS_DIR` only when the result mount uses a different in-container
path. The default E2E invocation chooses internal loopback ports, generates an ephemeral
local API token, builds and starts its own stack, installs the pinned Chromium,
and always stops the stack while collecting reports. It never reads
`E2E_LLM_*` and cannot select the `real` Playwright project.

For local E2E, both `CI_RUNTIME_DIR` and `CI_RESULTS_DIR` accept relative paths,
for example `CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:e2e`.
The E2E entry resolves them against the repository root before starting services
or Playwright. Direct `bash .ci/run-e2e.sh mocked` invocations follow the same
rule, so npm's `.e2e` working directory cannot move the data or journey reports.
Absolute paths retain their existing locations. The browser-free path regression
checks are included in `node --test .ci/ci-contract.test.mjs`.

`E2E_COMMIT_SHA` gives journey reports an immutable revision even when the
mounted checkout is a linked worktree whose external Git metadata is not
visible in the container. A regular clone can still resolve its own SHA, but
passing the value explicitly keeps the command identical across both layouts.

The first E2E run downloads the Chromium revision pinned by
`test/e2e.package-lock.json`. The entry never invokes managed-environment
setup and defaults `SCIENTIFIC_ENVS=0`, so the mocked job does not access conda
channels. J3 therefore reports its managed-Python precondition as BLOCKED,
never as a pass. A separate, explicitly network-enabled job may set
`E2E_SCIENTIFIC_ENVS=1` and reuse a pre-seeded `CI_RUNTIME_DIR`; that setup is
outside the generic default command.

## Results

The host directory mounted at `/ci-results` receives:

```text
ut/
  run.log                          # the layer entry point's own log
  summary.json                     # the layer's exit code and per-step timings
  tagged/                          # the frozen plan and its accounting
    plan.json
    preflight.json
    summary.json                   # planned / executed / passed / failed / skipped
st/
  run.log
  summary.json
  tagged/
e2e/
  run.log
  stack.log
  summary.txt
  playwright-report/
  test-results/                  # results.json, failure screenshots/traces
  journey-reports/               # report.md/html and step screenshots
selection/
  run.log                         # selected case commands and combined output
  summary.json                    # selection, tags, result paths and outcomes
```

`run-layer.mjs` stops at the first failing UT/ST command and records every
attempted command, exit code, and duration. It gives each run a unique
`SCIENCE_AGENT_DATA_DIR` below `CI_RUNTIME_DIR` (default
`/ci-cache/sciencediscovery-tests`) and removes it afterward, so tests cannot
leave generated logs or bootstrap tokens in the source mount. The E2E entry propagates
Playwright's exit code after copying the HTML report. Everything else is written
into the results while the run is still going: `test-results/` (through
`E2E_OUTPUT_DIR`) and `journey-reports/` as each journey ends, and `run.log`
and `stack.log` line by line. A run that is cancelled or killed therefore
keeps the evidence of every journey that finished, and a failed journey's
first error lines follow its `journey report (FAIL)` line in `run.log`.

The default mocked suite passes today: 8 passed and 2 skipped against an
isolated local stack. Both skips are preconditions, not coverage — J3 is
BLOCKED because the generic command keeps `SCIENTIFIC_ENVS=0`, and the
connector case is skipped for the same class of reason. Playwright exits 0 on
a skip, so a job that only reads the exit code reports a blocked journey as a
pass; read the counts and the not-passed titles as well.

The earlier note here claimed J4 must stay red because only the main
artifact reached the Project catalog. That is no longer the failure: J4 was
red because it still drove the SubAgent card as an inline disclosure, which
`fix(web): open SubAgent runs in a dedicated view` replaced, and it never
reached the artifact assertions. With the journey following the card into its
own conversation, both declared artifacts do appear.

## Known limits

The default image is intentionally hermetic with respect to models and external
services. The following checks need capabilities that a generic repository CI
container cannot safely or reliably provide.

| Test or capability | Missing generic-container capability | Recommended execution |
|---|---|---|
| `test/api/run_real_smoke.sh` | Live model endpoint, credential, outbound network, billable/rate-limited calls | Separate secret-bearing job with `CI_ALLOW_REAL=1` and `SCIENCE_AGENT_LLM_BASE_URL`, `SCIENCE_AGENT_LLM_MODEL`, `SCIENCE_AGENT_LLM_API_TOKEN`; select `st.agent-loop-real` |
| `npm --prefix .e2e run test:real` and `journey-real-request.spec.ts` | Live OpenAI-compatible endpoint and `E2E_LLM_*`; the real project is deliberately absent by default | Dedicated job with `CI_ALLOW_REAL=1` and the three `E2E_LLM_*` variables; select `e2e.real`, never add it to `pnpm ci:e2e` |
| Real NPU workloads such as `services/runner/workloads/npu-smoke-test.py` | Vendor device nodes, drivers, runtime libraries, model/data assets, and usually a native aarch64/NPU host | Hardware-specific runner with explicit device mounts and its own acceptance record |
| Full bubblewrap execution when the host denies unprivileged user namespaces | Docker flags cannot override a host kernel/AppArmor policy that rejects user namespace creation | Run on a Linux worker with user namespaces enabled; record UT/E2E as BLOCKED if the bwrap preflight fails |
| Host-only sandbox fallback/full-profile validation | A container cannot reproduce every host `/proc/sys`, AppArmor, LXC, and distribution-specific bwrap combination | Keep the existing stubbed capability/unit tests in UT; run real preflight/fallback checks on representative native hosts |
| Docker Desktop on macOS/Windows | The product runner requires Linux user/mount namespaces and bubblewrap | Use a native Linux CI worker or VM |

The tag catalog keeps unsupported generic-container capabilities discoverable
instead of silently dropping them. For example,
`pnpm ci:list -- --tag npu:required` lists `st.npu-smoke` with its limitation.
On a dedicated amd64 or arm64 NPU environment, set `CI_ALLOW_NPU=1` and point
`SCIENCE_AGENT_NPU_PYTHON` at the MindSpore-enabled interpreter before running
that selection. The generic image has neither dependency and remains blocked.

The hermetic `test/api/run_m1_smoke.sh` is supported and is the ST entry. A
missing historical/example command such as `test/gateway/run_m0_smoke.sh` is
not classified as unsupported; it simply is not part of this revision.
