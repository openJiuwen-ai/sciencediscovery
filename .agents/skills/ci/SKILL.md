---
name: ci
description: >
  Read, diagnose, and change the CI pipelines: CodeArts on GitCode merge
  requests and GitHub Actions on the mirror. Use when a pipeline or job fails,
  when editing .codearts/workflow/ or .github/workflows/, when asking which
  platform runs which layer, when reproducing a pipeline failure locally, or
  when a job needs the bubblewrap sandbox. Running the layers before a merge
  request and reading the result comment on it belong to the create-pr skill.
---

# ScienceDiscovery CI

Project-local skill for **ScienceDiscovery**.

[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns the layer entry points
(`pnpm ci:ut`, `ci:st`, `ci:e2e`, and the two UT tiers `ci:ut:host` /
`ci:ut:guest`), the writable `CI_RESULTS_DIR` / `CI_RUNTIME_DIR` overrides,
and the GitCode/GitHub repository split. [.ci/README.md](../../../.ci/README.md)
documents the toolchain image and the tag catalog. This skill covers what the
pipelines do with those entry points: which platform runs which layer, how to
read a run on each platform, how to validate a workflow change, and how to
attribute a failure. The local gate before a merge request and the result
comment the bot posts on it are in
[.agents/skills/create-pr/SKILL.md](../create-pr/SKILL.md).

## What runs where

Here, the CI `e2e` layer and `pnpm ci:e2e` mean the mocked **browser subset**.
E2E as a validation method also includes user journeys through public API,
CLI and local-stack product entry points; see the
[E2E skill](../e2e-testing/SKILL.md). Those journeys have their own documented
driver commands and are not automatically run by the browser layer. Adapter
smokes in `ci:st` are not E2E merely because they call a model. Keep layer
names, entry points and pipeline scheduling unchanged when reporting this
broader coverage.

Three pipelines exist and none runs everything.

| Pipeline | Trigger | UT | ST | Browser E2E subset | Binary/resource output |
| --- | --- | --- | --- | --- | --- |
| CodeArts — `.codearts/workflow/codearts-pipeline.yml` | merge request to `main` on gitcode.com (open, update, reopen); update and push the PR source branch to start a fresh run | both tiers: `ci:ut:host` on the runner, `ci:ut:guest` in a QEMU guest | `ci:st` | off; the journeys reach a browser under emulation but outrun timeouts sized for native speed | x86_64 + aarch64 packages; smoke is host-dependent |
| CodeArts resources — `.codearts/workflow/codearts-resources-pipeline.yml` on `ci/codearts-resources` | push to `ci/codearts-resources` | — | — | — | checksum-pinned toolchains and QEMU image uploaded to stable OBS keys |
| GitHub Actions — `.github/workflows/ci.yml` | push to `main`, pull request, or `workflow_dispatch` on the mirror `openJiuwen-ai/sciencediscovery` | full `ci:ut` | `ci:st` | mocked `ci:e2e` | x86_64 + aarch64, smoke-gated |

CodeArts's default pool cannot create user namespaces, so the UT guest tier
cannot run directly there. The debug pipeline runs the unchanged `ci:ut:guest`
layer in a checksum-pinned, pre-provisioned Ubuntu guest under software-only
QEMU TCG. That guest is not a separate test project: it is where the guest UT
tier executes, and the PR result table shows both tiers as UT.

The host does the compiling. The job provisions the runner, runs
`pnpm install --frozen-lockfile` and `pnpm build` on native CPU, and
`.ci/pack-workspace.sh` hands the guest `git archive HEAD` plus the dependency
tree and build output as one payload. The guest streams it in and runs the
layer entry point, which for `ut-guest` has no install and no build step.
Emulated CPU is roughly an order of magnitude slower than native: the run
before this split spent 476 s building and 92 s installing inside the guest to
reach 142 s of tests. A self-hosted pool that passes a bubblewrap probe
remains preferable.

The mocked E2E group reuses that guest rather than a second E2E definition.
Its host runs the same `pnpm ci:e2e` entry point with
`CI_E2E_PREPARE_ONLY=1`, which installs `.e2e` and the pinned Chromium into
the checkout and stops before the stack; the guest runs `pnpm ci:e2e` with
`CI_E2E_PREPARED=1` and owns the stack and the journeys. The CodeArts host
still never runs a journey itself: the browser and the Runner both need the
namespaces that pool denies. Expect this job to be slow — Chromium and the
Python service environments are provisioned and driven under TCG — and treat a
timeout as evidence for a self-hosted runner, not as a reason to weaken the
group.
The CodeArts debug workflow is a cache consumer, not a cache seeder. Its UT,
ST, binary, and QEMU jobs require the checksum-pinned OBS objects and fail
closed on a missing or invalid object instead of contacting external source
sites. The isolated `ci/codearts-resources` branch owns source fallback,
verification, and stable-key uploads; it is operational infrastructure and is
not intended to merge into `main`.
The CodeArts parent workflow also invokes the externally registered code-check
child (SCA, anti-poison, static analysis, blacklist), reads each task's public
result JSON independently, and renders one result comment with those four
statuses, UT, ST, and both debug binary jobs. A second CodeArts
pipeline, `codearts-auto-merge-pipeline.yml`, lands a merge request when a
`CODEOWNERS` member comments `/merge` on it, through GitCode's merge API with
`merge_method=rebase` (see the CodeArts reference). Both pipelines call build
tasks whose images, parameters and shell are configured on the CodeArts
console; `.ci/codearts-console.reference.md` mirrors that side, and changing
the console without changing it has already cost a wasted CI round. This repository
intentionally has no `.gitcode/workflows/` pipeline; do not reintroduce
GitCode Actions unless the user changes that policy.

## Shared rules

1. Never weaken a sandbox assertion to make a pipeline green. Tests that
   assert isolation or the sandbox's `/workspace` view must run on a host where
   bubblewrap can create namespaces.
2. Call the `pnpm ci:*` entry points, never their underlying commands. Do not
   create a second platform-specific test definition.
3. CodeArts bills pipelines and build tasks against separate quotas, and the
   pipeline's is the one that runs out. No workflow step may run shell, clone,
   or upload on a pipeline executor: every step is
   `uses: official_devcloud_cloudBuild` against the generic `run-shell` task,
   which checks the merge request out, rebases it, and calls a repository
   script through `.ci/codearts-build-dispatch.sh`. Adding a CI layer means
   adding a case to `.ci/codearts-layer.sh`, not editing a build task in the
   console — build tasks cannot be changed from code. A build task's console
   shell returns success even when the layer failed, so its OBS action can
   upload the log: the CodeArts job status is green by construction and must
   never be read as a result. `.ci/codearts-verify.sh` reads the recorded
   `exit-code` objects back and is the only job that can turn a run red.
   `pnpm ci:selftest` fails the build when a workflow step reaches for the
   pipeline quota again, or when the result gate stops keying on that
   verification.
4. UT has exactly two tiers and no third bucket. Every UT case belongs to
   `ut:host` (runs on an ordinary CI host, no sandbox) or to `ut:guest` (needs
   a Linux guest kernel that grants user namespaces, so bubblewrap works), and
   their union is all of UT. A new UT test joins the tier of the package it
   lives in: a host-tier test may not depend on a guest capability, and a
   guest-tier assertion may not be weakened so the test can move to the host
   tier. Do not add a `ci:ut:*` entry point beside them; extend a tier
   instead. `pnpm ci:catalog:check` fails closed on a UT case with no tier or
   two, on a workspace package with tests that lands in both tiers or in
   neither, on `ci:ut` no longer equalling the two tiers, and on a guest tier
   that installs or builds. `pnpm ci:selftest` is that guard's regression
   suite.
5. Read the failing job log before theorising. If the platform log is not
   accessible with the available credentials, ask for the log instead of
   inferring the failure from a status badge.
6. Preserve the real test exit code when adding artifact upload steps. Stage
   the result, upload diagnostics, then restore that exit code.
7. Reproduce a pipeline failure with the layer entry point that job ran
   (`pnpm ci:ut:host` for the CodeArts UT job, `pnpm ci:ut` for the GitHub
   one), on a checkout of the commit the run tested, with `CI_RESULTS_DIR` /
   `CI_RUNTIME_DIR` pointed somewhere writable. Each layer leaves `run.log`
   and a summary under `CI_RESULTS_DIR/<layer>/`.
8. Do not copy the parent `code_check` job status into all four child rows.
   Normalize each child JSON independently; only the explicit success aliases
   documented in the CodeArts reference pass, and every other value fails
   closed. Validate its detail link separately so a missing link does not
   overwrite a valid status.
9. For a CodeArts merge-request run, test the integration result rather than
   the source branch snapshot: pin the downloaded target SHA and event source
   SHA, then use `.ci/rebase-codearts-pr.sh` to create a disposable rebased
   checkout. Never push that rewritten commit. A conflict is a failed check.

## Platform routing

- For `.github/workflows/`, GitHub-hosted runner behavior, `gh run`, or GitHub
  artifacts, read [references/github.md](references/github.md) completely
  before acting.
- For `.codearts/workflow/`, CodeArts runs on GitCode merge requests, OBS test
  logs, or the CodeArts CCE runner, read
  [references/codearts.md](references/codearts.md) completely before acting.
- For CodeArts OBS object keys, public URLs, uploads, run artifacts,
  code-check JSON, or the verified toolchain cache, also read
  [references/codearts-obs.md](references/codearts-obs.md) completely before
  acting.
- For cross-platform comparisons or changes, read every applicable reference.

## Common failure signals

| Symptom | Meaning |
| --- | --- |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. Use only the repository's sandbox-free layer there; do not weaken Runner tests. |
| QEMU reports `could not load module for type tcg-accel-ops` | A workspace-extracted QEMU cannot find its modules. Point `QEMU_MODULE_DIR` at the extracted architecture-specific QEMU module directory. |
| A guest job reports a cache miss for `ScienceDiscovery-qemu-emulator-alpine-x86_64.tar` | The portable emulator was never published, or its checksum moved. Do not reassemble it in the test job — that is the 166 seconds this cache removed. Push or rerun `ci/codearts-resources`, read `Verified published QEMU emulator: <sha256>`, and update `.ci/qemu-emulator.sha256` if the pinned Alpine packages changed. |
| `apk.static` reports `TLS: server certificate not trusted` on the resource branch | The static bootstrap has no X.509 trust store, so its package indexes are empty. Supply the checksum-pinned CA bundle through `SSL_CERT_FILE`; keep HTTPS and Alpine package-signature verification enabled. |
| The merge request stays on `ci-running` with no result comment | A job was killed by its CodeArts timeout rather than failing, so nothing recorded an exit code and neither result job's condition became true. Give each guest a `QEMU_TIMEOUT_SECONDS` inside its job budget so the wrapper always writes a result. |
| QEMU boots but the guest emits no `QEMU_SANDBOX_TEST_RESULT` marker | The VM timed out, failed before the guest harness ran, or could not shut down cleanly. Keep the job failed and read `ut-guest/run.log`. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran; check sandbox availability first. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; inspect the sandbox probe before application logs. |
| The guest reports `BLOCKED: ... expects a workspace its host already installed and built` | The host steps did not install and build before the guest started. Fix the host, never the guest: adding an install or build there is exactly what the split removed. |
| A guest log shows `Scope: all N workspace projects`, or `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm's `verify-deps-before-run` ran and decided to reinstall. Its check keys `node_modules/.pnpm-workspace-state-v1.json` by the absolute project directories of the machine that installed, so a moved workspace always looks changed. Keep `pnpm_config_verify_deps_before_run=` — the `pnpm_` prefix and the empty value both matter — in the guest environment; do not let the guest install instead. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`; regenerate it with `pnpm install --lockfile-only`. |
| Playwright is green with fewer tests than expected | A skip is not a pass. Check counts and not-passed titles; a BLOCKED precondition is reported as skipped. |
| `fatal: couldn't find remote ref refs/heads/<source>` on a fork PR | The job fetched a fork-only branch from the upstream repository. Fetch GitCode's upstream merge-request ref instead; see the CodeArts reference. |
| The PR result table says `COMPLETED` | A CodeArts lifecycle state leaked into user-facing output. Normalize each task to `PASSED` or `FAILED` in the parent workflow. |
| One code-check JSON says `FIALED`, is missing, or contains an unknown status | It is not a success alias. Fail that child closed to `FAILED`; do not reuse the parent or another child's status. |
| A UT/ST public OBS link returns `403` after an early job failure | The job failed before the upload step, so the object was never created. Probe the object and fall back to the GitCode Checks page. |
| A formal CodeArts job reports a stable OBS cache miss | Do not add source fallback to the test/build job. Push or rerun `ci/codearts-resources`, verify its checksum-pinned upload, update the formal prebuilt-image pin when needed, then rerun the formal workflow. |
