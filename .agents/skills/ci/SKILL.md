---
name: ci
description: >
  Run the UT/ST/E2E layers locally before opening a merge request, and read a
  CI result on GitHub Actions or CodeArts. Use when a pipeline fails,
  when changing a workflow file, when asking which platform covers which tests,
  or when a job needs the bubblewrap sandbox.
---

# ScienceDiscovery CI

Read [CONTRIBUTING.md](../../../CONTRIBUTING.md) first. It owns the layer entry
points, writable `CI_RESULTS_DIR` / `CI_RUNTIME_DIR` overrides, per-platform
coverage, the GitCode/GitHub repository split, and the local checks required
before a merge request. `.ci/README.md` documents the toolchain image.

This skill adds platform-specific result access, workflow validation, and
failure diagnosis.

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

## Platform routing

- For `.github/workflows/`, GitHub-hosted runner behavior, `gh run`, or GitHub
  artifacts, read [references/github.md](references/github.md) completely
  before acting.
- For `.codearts/workflow/`, CodeArts runs on GitCode merge requests, OBS test
  logs, or the CodeArts CCE runner, read
  [references/codearts.md](references/codearts.md) completely before acting.
- This repository intentionally has no `.gitcode/workflows/` pipeline. GitCode
  merge-request CI uses CodeArts; do not reintroduce GitCode Actions unless the
  user explicitly changes that policy.
- For cross-platform comparisons or changes, read every applicable reference.

## Common failure signals

| Symptom | Meaning |
| --- | --- |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. Use only the repository's sandbox-free layer there; do not weaken Runner tests. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran; check sandbox availability first. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; inspect the sandbox probe before application logs. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`; regenerate it with `pnpm install --lockfile-only`. |
| Playwright is green with fewer tests than expected | A skip is not a pass. Check counts and not-passed titles; a BLOCKED precondition is reported as skipped. |
