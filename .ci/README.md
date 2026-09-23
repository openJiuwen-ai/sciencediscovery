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

## One plan, three layers

### Research-test scheduling after PR #154

| Profile / job | Scope | Paid credentials |
| --- | --- | --- |
| PR: `ci:ut` | Tagged package/helper tests and offline benchmark-verifier checks | None |
| PR: `ci:st` | Mock agent-loop smoke and pinned Swarm SDK/MCP contract checks | None |
| PR: `ci:e2e` | All reviewed mocked browser journeys, including research lifecycle/source fixtures | None |
| Daily: `ci:e2e:real` | Every tagged real browser journey: five DRB, research team, two BiomniBench and existing real journeys | `nightly-research` environment only |

`daily` adds a real-E2E policy row; `release` keeps the credential-free PR policy.
The three hermetic jobs remain unchanged entry points; daily adds the disjoint
`e2e-real` slice. Always parenthesize the OR-ed profile before intersecting a slice.
The browser worker receives a frozen subplan, including exact test identities;
inherited Playwright suite tags must not change which titles match that plan.

Mocked source tags declare `fixture:standard`, `fixture:research` (MCP fault
proxy and small-context Swarm), or `fixture:literature` (also offline sources).
The shared runner starts separate disposable stacks for these batches. It does
not weaken missing-fixture assertions into skips or inject fake sources into
real benchmarks. `SCIENCE_AGENT_API_ENTRYPOINT` is a local-only startup seam
used by the literature fixture; the default product API entry point is unchanged.

The two Python benchmark-verifier suites are a planned UT command check;
the pinned Swarm patch/SDK suites are a planned ST command check. Their individual
framework case counts remain in logs rather than being counted as separate
frozen identities. New Node helper/fixture tests are individually tagged.
The UT preparation downloads the pinned DRB evaluator, but all of its judge and
fetch calls in this suite are mocked. Empty or skipped Python suites fail the
command; no live credentials are required for these verification tests.

### Daily real-E2E prerequisites

Nightly runs at **00:00 Asia/Shanghai (16:00 UTC)**, with a separate real E2E job
in the reusable CI workflow. GitHub schedules only workflows on the default
branch: merging into `feat/jiuwenswarm` alone does not activate the schedule.
The nightly workflow passes secrets to the reusable workflow; PR jobs do not
receive live credentials. Nothing here dispatches a paid run during development.

Configure the GitHub environment `nightly-research`:

- Variables: `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_JUDGE_BASE_URL`, `E2E_JUDGE_MODEL`.
- Secrets: `E2E_LLM_TOKEN`, `E2E_JUDGE_TOKEN`, `JINA_API_KEY`, `HF_TOKEN`.
- The HF account must have accepted BiomniBench-DA access terms. Setup downloads
  only the two tasks' CSVs, instructions and rubrics, not the full dataset.
- The DRB evaluator is pinned to `852f4022d1f98fb707222e395405136e8f0e8d52`;
  BiomniBench inputs are verified against committed blob hashes before model use.

Missing credentials/data/dependencies fail explicitly. No case disappears from
discovery because an environment variable is absent. Selected skips, missing
results and assertion failures fail plan accounting. `real-e2e-results` retains
the plan, per-case metrics, scores and diagnostics even on failure (seven days).
Treat these artifacts as research data; restrict access appropriately.

Real tests use one browser worker; the isolated runtime enforces child concurrency
two. DRB additionally requests at most two total children; the team retains six
roles. Each DRB gets 20 minutes generation plus 10 minutes evaluation, team gets
40 minutes and BiomniBench 20 minutes per case. Timeouts are failures, not success
or a monetary cap. The job has a six-hour ceiling and does not retry failed cases.
Judge scores and token usage are recorded separately from generator usage.

The three hermetic layers are three slices of one plan, not three suites. Each
runs `test/support/tagged/shared.mjs` against the single selector in
[test/support/tagged/profiles.mjs](../test/support/tagged/profiles.mjs),
narrowed only by the group that layer schedules:

| CI layer | Entry point | Slice of the shared selector |
|---|---|---|
| UT | `pnpm ci:ut` | `category:ut` |
| ST | `pnpm ci:st` | `category:st` |
| Mock E2E | `pnpm ci:e2e` | `category:e2e and not model:real`, driving `.ci/run-e2e.sh` |
| Daily real E2E | `pnpm ci:e2e:real` | `category:e2e and model:real`, daily profile only |

The three hermetic slices partition the PR plan; the fourth slice adds real
journeys for daily CI. The hermetic slices together are `pnpm test:shared`, the command a developer
runs. Which cases are selected comes from the tags in each test's own source —
never from the machine, its credentials, its devices or its installed
services. A missing capability fails the plan's preflight, and a skip is a
failed run, so a layer cannot go green by running less.
[test/support/tagged/MIGRATION.md](../test/support/tagged/MIGRATION.md) records
what the plan covers. Real E2E is included only in the daily profile; live ST,
NPU, legacy and macOS work keep their own opt-in entry points (`ci:st:real`, `ci:e2e:real`,
`ci:st:npu`, `ci:e2e:legacy`).

`node .ci/tagged-summary.mjs` reads each slice's frozen plan back and fails
unless `planned == executed == passed` with nothing skipped — including when a
layer stopped before it produced a plan at all.

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
Playwright's exit code after copying reports, including failure evidence.

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
