---
name: ci
description: >
  Read, diagnose, and change the CI pipeline: GitHub Actions on pull requests,
  the merge queue, the nightly schedule and the release tag. Use when a job
  fails, when editing .github/workflows/, when asking which layer runs what, when reproducing a
  pipeline failure locally, or when a job needs the bubblewrap sandbox. Running
  the layers before proposing a change, and reading the result a proposal
  receives, belong to create-github-pr.
---

# ScienceDiscovery CI

Project-local skill for **ScienceDiscovery**.

[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns the layer entry points
(`pnpm ci:l1`, `ci:ut`, `ci:st`, `ci:e2e`, `ci:e2e:real`) and the writable
`CI_RESULTS_DIR` / `CI_RUNTIME_DIR` overrides. [.ci/README.md](../../../.ci/README.md) documents
the toolchain image and the scheduler's tag catalog. This skill covers what the
pipeline does with those entry points: how to read a run, how to validate a
workflow change, and how to attribute a failure. Running the layers before
proposing a change, and reading what the proposal receives, are in
[create-github-pr](../create-github-pr/SKILL.md).

## What runs where

Here, the CI `e2e` layer and `pnpm ci:e2e` mean the mocked **browser subset**.
E2E as a validation method also includes user journeys through public API, CLI
and local-stack product entry points; see the
[E2E skill](../e2e-testing/SKILL.md). Those journeys have their own documented
driver commands and are not automatically run by the browser layer. Adapter
smokes in `ci:st` are not E2E merely because they call a model.

**GitHub Actions is the only CI, and it is the gate, on the pull request.**
gitcode.com is a read-only mirror: nothing runs there and nothing is decided
there. The CodeArts pipeline that used to run on a GitCode merge request, and
the QEMU guest it needed because its pool could not create user namespaces,
were removed — GitHub's `ubuntu-latest` runs every layer natively. What that
removal cost, and nothing has replaced, is the externally registered code-check
child (SCA, anti-poison, static analysis, blacklist); nothing runs those on a
change today.

One workflow defines the gate. `nightly.yml` and `release.yml` are not a second
and third definition: both call `ci.yml` through `workflow_call`, so what they
run is defined by the profiles below.

| Tier / profile | Trigger | Cumulative coverage and gate |
| --- | --- | --- |
| L1 / `l1` | Every CI run except draft PRs; required before L2 | Lightweight architecture, docs, catalog and E2E metadata checks, without starting services or browsers; required before L2 |
| L2 / `pr` | Non-draft PR opened, synchronized, reopened or marked ready for review; push to `main` or `master`; default manual dispatch | L1 + hermetic UT/ST and mocked browser E2E; no model credentials or distribution jobs |
| L3 / `merge` | `merge_group: checks_requested`, after maintainer review and enqueue | Rerun L1/L2 on the group SHA + basic real API journeys, x86_64/aarch64 binary smoke and Docker deployment checks; required before automatic merge |
| L4 / `daily` | `nightly.yml`, 16:00 UTC daily or manual | L3 + all eligible nightly research journeys and their declared judging; records the nightly outcome and artifacts |
| L5 / `release` | `release.yml`, version tag push | Currently the same eligible cases and evaluation modes as L4; retains its own extension tier. Failure blocks Release/assets publication, not creation of the already-pushed tag |

`ci.yml` also accepts `workflow_dispatch` and `workflow_call` profiles
`pr`, `merge`, `daily`, and `release`. [.ci/tier-policy.mjs](../../../.ci/tier-policy.mjs)
forces PR events to `pr` and merge-group events to `merge`, including a queue
with one PR. Default-branch push does not repeat the paid suite. UT and ST
record coverage outside Release runs; Coverage merges those records and runs
no tests.

The binary and Docker jobs are distribution gates and sit outside the plan: the
four-entry smoke that proves a built binary boots is a job's exit code, not a
planned identity, so `planned == executed == passed` says nothing about it.

## One plan, cumulative tiers and disjoint slices

`test/support/tagged/profiles.mjs` owns selection. `tier:l1` through `tier:l5`
declare the first tier that includes a case; higher profiles include lower
ones. Category, model/judge cost, and execution backend are separate concerns.
`pnpm test:policy` prints the policy dimensions: read it before deciding what
a run covers. The disjoint slices are `l1`, `ut` (excluding L1), `st`, `e2e`
(mocked), and `e2e-real`. L1 + UT + ST + mocked E2E together run exactly the
default `pnpm test:shared` PR plan. L3/L4/L5 additionally take the real slice
and require model credentials.

The shared runner receives the profile as an argument, so reproduce the
command from the log. For example, `pnpm ci:e2e -- --profile merge --shard
standard-config` runs that mocked partition, while `CI_ALLOW_REAL=1 pnpm
ci:e2e:real -- --profile merge --backend jiuwenswarm` runs the basic real slice
with configured credentials. `ci:e2e:real` defaults to `daily`; specify `merge`
when reproducing L3. To inspect selection without paid calls, use `pnpm
test:list --profile merge --slice e2e-real --backend jiuwenswarm`.

Backend selection is independent: `--backend jiuwenswarm|legacy` overrides
`CI_E2E_BACKEND`; `legacy` selects the native loop. Workflow input `backend`
falls back to repository variable `CI_E2E_BACKEND`, then `jiuwenswarm`.
The backend changes execution identity, not the selected case IDs. There is
no automatic second backend or fallback; report which backend actually ran.

With the profile, backend and shard fixed, selection comes from source tags.
Credentials, devices and installed services cannot silently filter that
frozen plan — a missing capability fails preflight before any test body runs. A
skipped case is a failed run. So "the layer passed but ran fewer tests" is not
a possible outcome any more; `node .ci/tagged-summary.mjs` fails the job unless
`planned == executed == passed`, including when no plan was produced at all.
Real E2E runs in L3/L4/L5 with explicit credentials and `CI_ALLOW_REAL=1`.
The separate `ci:st:real` native compatibility smoke, adapter live tests, NPU
and legacy-only suites keep their own opt-in entry points; they are not added
by selecting the native backend. `test/support/tagged/MIGRATION.md` is the
ledger of what is in and what is out. Quarantined cases stay outside the plan,
never counted as passes. There is no suite API/token budget gate or historical
L5 quality-baseline gate today; request/case/job timeouts still apply. A green
release certifies the selected assertions, not a calibrated capability baseline.

## Job ordering and isolated mocked workers

After L1, UT, ST and `e2e-plan` can start independently. `e2e-plan` freezes the
mocked slice and `.ci/mocked-matrix.mjs` derives its worker matrix from source
metadata. Do not maintain a second file/title list in the workflow.

| Mocked worker | Fixture | State constraint |
| --- | --- | --- |
| `standard-config` | `standard` | `isolation:fresh` before `isolation:global`; owns the supplemental JiuwenSwarm checks once |
| `standard-journeys` | `standard` | `isolation:session` journeys on a separate standard stack |
| `research` | `research` | Separate research mock stack |
| `literature` | `literature` | Separate literature mock stack |

The matrix uses `max-parallel: 4`, `fail-fast: false`. Each worker retains
Playwright `workers: 1` and `retries: 0`; files and their steps stay together.
Parallelism is between isolated stacks, not between tests sharing global
settings. Both standard partitions must keep the `standard` fixture: changing
the fixture changes product setup. Counts come from the frozen plan, not this
table. Supplemental checks are separate from browser identity totals.

Without `--shard`, `pnpm ci:e2e` still runs the full serial suite. Local
parallel runs need prepared dependencies, distinct result/runtime directories,
service ports and JiuwenSwarm state. `JIUWENSWARM_HOME` isolates runtime state;
`JIUWENSWARM_ROOT` / `JIUWENSWARM_SRC` select the installation, not that state.
On a shared network, allow each SDK instance to bind its automatically chosen
ports before starting the next. Independent runners avoid that startup race;
do not change the user's `HOME` or use a human trial instance for tests.

The existing `merge-gate` reconciles the exact union of mocked artifacts with
the parent plan: revision, source/evaluator fingerprints, backend, identities
and exactly-once supplemental checks. Missing, duplicated, skipped or failed
results fail the gate. It produces combined `e2e-results`, preserving worker
HTML/image links; no separate mocked accounting job is added.

Real work **still waits for UT, ST and all mocked workers**. `real-plan`
reconciles mocked results before freezing the real matrix. That matrix has
one serialized basic worker and one worker per research case, with at most
two concurrent workers. `real-report` (displayed as **Account for real cases**)
reconciles their identities and results; it does not run another journey or
call a model. `merge-gate` requires the jobs selected by `.ci/tier-policy.mjs`;
for non-PR profiles these include real accounting and both distribution gates.

## Merge queue and model credentials

The repository ruleset must require both the merge queue and the stable
`merge-gate` check. Enabling the queue alone does not make L3 a required check.
PR and queue runs use the same check name with different required jobs; do not
require a queue-only job before a PR can enter the queue. Require review of the
current PR head and dismiss stale approvals; admin setup is documented in
[.ci/README.md](../../../.ci/README.md#merge-queue-and-credentials-repository-setup).

L3/L4/L5 reuse **nightly-ci-ds**, with no Environment required reviewers or
final approval job. Its model/judge variables configure `real-plan`; secrets
are injected only into `real-e2e`. Keep model credentials in the Environment,
not repository secrets, and exclude `pull_request` from jobs using them.
Environment ref restrictions must admit the intended queue refs, default
branch, release tags and trusted manual-dispatch refs. Those settings require
repository administration; committing YAML does not create them.

Maintainer review and enqueue are the trust decision: queued code can read
credentials injected into its job. L3 passing allows automatic merge once
other required conditions pass. Never recommend `pull_request_target` with an
unrestricted checkout of the PR head. A rebuilt queue candidate needs results
for its new SHA and may repeat paid calls; an earlier PR pass does not replace
the merge-group run.

## Shared rules

1. Never weaken a sandbox assertion to make a pipeline green. Tests that
   assert isolation or the sandbox's `/workspace` view must run on a host where
   bubblewrap can create namespaces. Every job that needs it installs
   bubblewrap and clears
   `kernel.apparmor_restrict_unprivileged_userns` before using it.
2. Call the `pnpm ci:*` entry points, never their underlying commands. Do not
   create a second test definition, and do not add a list of cases beside the
   tags: `pnpm ci:catalog:check` fails a layer that runs anything other than a
   slice of the shared plan, an entry point that drifts off that slice, and a
   package test file that sits outside the collection patterns the plan is
   built from. `pnpm ci:selftest` is that guard's regression suite.
   `pnpm test:run --<group> <value>` builds its own selector from the tag
   vocabulary and can therefore reach outside the shared plan. That is the
   developer entry point; CI uses `--slice`, which is appended to the shared
   selector with `and` and is always a subset of it. Do not put a query in a
   workflow.
3. UT is one layer. A UT test needing the sandbox says so with
   `sandbox:bubblewrap`, which the plan turns into a preflight the whole run
   fails on; it does not move the test to a different job. Do not add a
   `ci:ut:*` entry point beside `ci:ut`.
4. Read the failing job log before theorising. If the log is not accessible
   with the available credentials, ask for it instead of inferring the failure
   from a status badge.
5. Preserve the real test exit code when adding artifact upload steps. Stage
   the result, upload diagnostics, then restore that exit code.
6. Reproduce a pipeline failure with the same layer entry point, on a checkout
   of the commit the run tested, with `CI_RESULTS_DIR` / `CI_RUNTIME_DIR`
   pointed somewhere writable. Keep the event/profile, backend and shard the
   same. Each slice leaves its frozen plan and summary under
   `CI_RESULTS_DIR/<slice>/tagged/`; inspect the worker artifact for driver and
   stack logs. Compare a queue result to its group SHA, not only the PR head.

## Platform routing

For `.github/workflows/`, GitHub-hosted runner behavior, `gh run`, or GitHub
artifacts, read [references/github.md](references/github.md) completely before
acting.

## Common failure signals

| Symptom | Meaning |
| --- | --- |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. On Ubuntu 24.04 that is the AppArmor restriction the jobs clear with `sysctl kernel.apparmor_restrict_unprivileged_userns=0`; do not weaken Runner tests instead. |
| Playwright is green with fewer tests than expected | A skip is not a pass, and the plan already says so. Read `<CI_RESULTS_DIR>/e2e/tagged/summary.json`: it names every planned journey that did not report one. |
| PR real/distribution jobs are skipped | Expected for `pr`. On a merge-group run, inspect L1's routed profile and `merge-gate` instead; `merge` requires those jobs. |
| `SHARD_IDENTITY_MISMATCH`, `SHARD_RESULT_PLAN_MISMATCH` or missing worker artifacts | Inspect parent and worker plans, SHA, backend and artifact layout before blaming a journey; the aggregate cannot certify mismatched evidence. |
| Real jobs are waiting, or **Account for real cases** fails | Check `needs` and UT/ST/mock results first; real accounting checks completeness rather than adding a model test. Read `real-e2e-verdict` and the failing worker evidence. |
| `EMPTY_SELECTION`, `EMPTY_MODULE` or `COLLECTION_DRIFT` | A collection problem, not a product failure. The plan is frozen from source, so a selector that matches nothing, a module that registers no test, and a source that changed between freezing and running are all failures of the run. |
| `PREPARATION_FAILED` | The shared runner's own setup — install, build, the five service virtualenvs, the pinned Chromium — did not complete. The message names the log to read; nothing was collected yet, so this is never a product assertion. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran; check sandbox availability first. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; inspect the sandbox probe before application logs. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`; regenerate it with `pnpm install --lockfile-only`. |
| The E2E job spends its first minute downloading conda packages | Expected. `E2E_SCIENTIFIC_ENVS=1` provisions the managed Python base so the environment journey runs instead of reporting a skip; it is about 330 MB on a runner with no cache. |
