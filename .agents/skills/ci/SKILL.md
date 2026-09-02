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
(`pnpm ci:ut`, `ci:st`, `ci:e2e`, and the sandbox-free split `ci:ut:core` /
`ci:ut:runner`), the writable `CI_RESULTS_DIR` / `CI_RUNTIME_DIR` overrides,
and the GitCode/GitHub repository split. [.ci/README.md](../../../.ci/README.md)
documents the toolchain image and the tag catalog. This skill covers what the
pipelines do with those entry points: which platform runs which layer, how to
read a run on each platform, how to validate a workflow change, and how to
attribute a failure. The local gate before a merge request and the result
comment the bot posts on it are in
[.agents/skills/create-pr/SKILL.md](../create-pr/SKILL.md).

## What runs where

Two pipelines exist and neither runs everything.

| Pipeline | Trigger | UT | ST | E2E | Binary packages |
| --- | --- | --- | --- | --- | --- |
| CodeArts — `.codearts/workflow/codearts-pipeline.yml` | merge request to `main` on gitcode.com (open, update, merge, reopen) or a `rerun` comment on it | `ci:ut:core` | `ci:st` | — | x86_64 + aarch64 packages; smoke is host-dependent |
| GitHub Actions — `.github/workflows/ci.yml` | push to `main`, pull request, or `workflow_dispatch` on the mirror `openJiuwen-ai/sciencediscovery` | full `ci:ut` | `ci:st` | mocked `ci:e2e` | x86_64 + aarch64, smoke-gated |

CodeArts's default pool cannot create user namespaces, so Runner UT and E2E
run only on GitHub or on a self-hosted pool that passes a bubblewrap probe.
The CodeArts parent workflow also invokes the externally registered code-check
child (SCA, anti-poison, static analysis, blacklist), reads each task's public
result JSON independently, and renders one result comment with those four
statuses, UT, ST, and both binary jobs. A second CodeArts
pipeline, `codearts-auto-merge-pipeline.yml`, lands a merge request when a
`CODEOWNERS` member comments `/merge` on it, through GitCode's merge API with
`merge_method=rebase` (see the CodeArts reference). This repository
intentionally has no `.gitcode/workflows/` pipeline; do not reintroduce
GitCode Actions unless the user changes that policy.

## Shared rules

1. Never weaken a sandbox assertion to make a pipeline green. Tests that
   assert isolation or the sandbox's `/workspace` view must run on a host where
   bubblewrap can create namespaces.
2. Call the `pnpm ci:*` entry points, never their underlying commands. Do not
   create a second platform-specific test definition.
3. Read the failing job log before theorising. If the platform log is not
   accessible with the available credentials, ask for the log instead of
   inferring the failure from a status badge.
4. Preserve the real test exit code when adding artifact upload steps. Stage
   the result, upload diagnostics, then restore that exit code.
5. Reproduce a pipeline failure with the layer entry point that job ran
   (`pnpm ci:ut:core` for the CodeArts UT job, `pnpm ci:ut` for the GitHub
   one), on a checkout of the commit the run tested, with `CI_RESULTS_DIR` /
   `CI_RUNTIME_DIR` pointed somewhere writable. Each layer leaves `run.log`
   and a summary under `CI_RESULTS_DIR/<layer>/`.
6. Do not copy the parent `code_check` job status into all four child rows.
   Normalize each child JSON independently; only the explicit success aliases
   documented in the CodeArts reference pass, and every other value fails
   closed. Validate its detail link separately so a missing link does not
   overwrite a valid status.

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
| API test expects `runner_exec`, gets `undefined` | An execution never ran; check sandbox availability first. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; inspect the sandbox probe before application logs. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`; regenerate it with `pnpm install --lockfile-only`. |
| Playwright is green with fewer tests than expected | A skip is not a pass. Check counts and not-passed titles; a BLOCKED precondition is reported as skipped. |
| `fatal: couldn't find remote ref refs/heads/<source>` on a fork PR | The job fetched a fork-only branch from the upstream repository. Fetch GitCode's upstream merge-request ref instead; see the CodeArts reference. |
| The PR result table says `COMPLETED` | A CodeArts lifecycle state leaked into user-facing output. Normalize each task to `PASSED` or `FAILED` in the parent workflow. |
| One code-check JSON says `FIALED`, is missing, or contains an unknown status | It is not a success alias. Fail that child closed to `FAILED`; do not reuse the parent or another child's status. |
| A UT/ST public OBS link returns `403` after an early job failure | The job failed before the upload step, so the object was never created. Probe the object and fall back to the GitCode Checks page. |
