---
name: ci
description: >
  Read, diagnose, and change the CI pipeline: GitHub Actions on pull requests,
  the nightly schedule and the release tag. Use when a job fails, when editing
  .github/workflows/, when asking which layer runs what, when reproducing a
  pipeline failure locally, or when a job needs the bubblewrap sandbox. Running
  the layers before proposing a change, and reading the result a proposal
  receives, belong to create-github-pr.
---

# ScienceDiscovery CI

Project-local skill for **ScienceDiscovery**.

[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns the layer entry points
(`pnpm ci:ut`, `ci:st`, `ci:e2e`) and the writable `CI_RESULTS_DIR` /
`CI_RUNTIME_DIR` overrides. [.ci/README.md](../../../.ci/README.md) documents
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
run is the row below, and the reason they exist is in their own file headers.

| Pipeline | Gate | Trigger | Profile | Jobs |
| --- | --- | --- | --- | --- |
| `.github/workflows/ci.yml` | yes | push to `main`, pull request, or `workflow_dispatch` | `pr` | `ci:ut` and `ci:st` (each recording coverage), mocked `ci:e2e`, Coverage (merges UT's and ST's data, runs nothing), x86_64 + aarch64 release binaries (smoke-gated), the Docker image |
| `.github/workflows/nightly.yml` | — | 16:00 UTC daily, or manual | `daily` | calls `ci.yml`, adds real E2E, with a `nightly-<date>-<sha>` version |
| `.github/workflows/release.yml` | — | push of a version tag | `release` | calls `ci.yml` with the tag's version, then publishes if it passes |

The binary and Docker jobs are distribution gates and sit outside the plan: the
four-entry smoke that proves a built binary boots is a job's exit code, not a
planned identity, so `planned == executed == passed` says nothing about it.

## One plan, three layers

`ci:ut`, `ci:st` and `ci:e2e` are not three suites. Each runs
`test/support/tagged/shared.mjs` against the `pr` profile in
`test/support/tagged/profiles.mjs`, narrowed to that layer's `category`. That
profile is stated as tag dimensions rather than as a selector string, and
`pnpm test:policy` prints it — read that before theorising about what a job
covers. Each pipeline names its own: a pull request takes `pr`, `nightly.yml`
takes `daily`, and `release.yml` takes the credential-free `release` profile
(same policy as `pr`). Daily adds the disjoint `e2e-real` slice. The job passes it as an
argument, so the command in the log is the command that reproduces the run.
The three hermetic groups partition the PR plan, so these layers together run exactly
`pnpm test:shared`, the command a developer runs locally.

What this means when reading a failure: selection comes from the tags in each
test's source and from nothing else. A job's credentials, devices, installed
services and `CI_*` variables cannot add a case or remove one — a missing
capability fails the plan's preflight instead, before any test body runs. A
skipped case is a failed run. So "the layer passed but ran fewer tests" is not
a possible outcome any more; `node .ci/tagged-summary.mjs` fails the job unless
`planned == executed == passed`, including when no plan was produced at all.
Real E2E runs only in daily CI with explicit credentials. Live ST, NPU, legacy and macOS work is tagged out of the shared selector and
keeps its own opt-in entry points; `test/support/tagged/MIGRATION.md` is the
ledger of what is in and what is out.

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
   pointed somewhere writable. Each layer leaves `run.log` and a summary under
   `CI_RESULTS_DIR/<layer>/`, and its frozen plan under
   `CI_RESULTS_DIR/<layer>/tagged/`.

## Platform routing

For `.github/workflows/`, GitHub-hosted runner behavior, `gh run`, or GitHub
artifacts, read [references/github.md](references/github.md) completely before
acting.

## Common failure signals

| Symptom | Meaning |
| --- | --- |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. On Ubuntu 24.04 that is the AppArmor restriction the jobs clear with `sysctl kernel.apparmor_restrict_unprivileged_userns=0`; do not weaken Runner tests instead. |
| Playwright is green with fewer tests than expected | A skip is not a pass, and the plan already says so. Read `<CI_RESULTS_DIR>/e2e/tagged/summary.json`: it names every planned journey that did not report one. |
| `EMPTY_SELECTION`, `EMPTY_MODULE` or `COLLECTION_DRIFT` | A collection problem, not a product failure. The plan is frozen from source, so a selector that matches nothing, a module that registers no test, and a source that changed between freezing and running are all failures of the run. |
| `PREPARATION_FAILED` | The shared runner's own setup — install, build, the five service virtualenvs, the pinned Chromium — did not complete. The message names the log to read; nothing was collected yet, so this is never a product assertion. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran; check sandbox availability first. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; inspect the sandbox probe before application logs. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`; regenerate it with `pnpm install --lockfile-only`. |
| The E2E job spends its first minute downloading conda packages | Expected. `E2E_SCIENTIFIC_ENVS=1` provisions the managed Python base so the environment journey runs instead of reporting a skip; it is about 330 MB on a runner with no cache. |
