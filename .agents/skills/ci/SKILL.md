---
name: ci
description: >
  Run the UT/ST/E2E layers locally before opening a merge request, and read a
  CI result on GitHub Actions, GitCode or CodeArts. Use when a pipeline fails,
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
- For `.gitcode/workflows/`, GitCode Actions APIs, dispatch validation, or the
  GitCode hosted runner, read [references/gitcode.md](references/gitcode.md)
  completely before acting.
- CodeArts PaC uses `.codearts/workflow/` and the guidance below. It is not
  GitCode Actions; do not query CodeArts runs through GitCode's Actions API.
- For cross-platform comparisons or changes, read every applicable reference.

## CodeArts PaC

CodeArts steps have `name`, `uses`, and optional `with`; there is no GitHub-style
`run:` key. A shell step is:

```yaml
- name: Report the runner
  uses: official_shell_plugin
  with:
    OFFICIAL_SHELL_SCRIPT_INPUT: |
      uname -srm
```

Writing `run:` is rewritten server-side into a nonexistent plugin named
`official_shell`, so validation fails before a job starts. Plugin identifiers
come from the platform's YAML view or a run's `task` field, because the manual
lists display names only. Keep the generated `stages.<id>` key verbatim.

Each job must run `official_git_clone`. For this pipeline's single GitCode
source, it expands the checkout directly into `${SHARE_PATH}`, not a nested
`${SHARE_PATH}/sciencediscovery` directory. Run `.ci/provision-runner.sh`, set
writable result/runtime paths, and then call `ci:ut:core` or `ci:st`.

The default CCE pool is an unprivileged EulerOS pod even when the YAML requests
`ubuntu-latest`. It has no usable root or user namespaces, so Runner UT and E2E
remain excluded. A sandboxed layer requires a self-hosted resource pool that
passes an actual bubblewrap probe.

### Upload test logs to OBS

`upload-obs` validates its local input before contacting OBS. `source_file`
must be an absolute path below the current `${SHARE_PATH}`:

```yaml
- name: Upload ST log to OBS
  uses: upload-obs
  with:
    key: "sciencediscovery/ci/${{ sources.sciencediscovery.commit_id }}/${{ pipeline.run_id }}/st/run.log"
    source_file: "${SHARE_PATH}/.ci-results/st/run.log"
    self_folder: "false"
```

Use both the source commit and `pipeline.run_id` in `key`: one commit can run
more than once, and a commit-only key overwrites earlier diagnostics. The
checked-in workflow stages the test exit code and guarantees `run.log` exists,
uploads it, and then exits with the staged code. This source expansion and OBS
layout passed on CodeArts on 2026-08-24.

## Common failure signals

| Symptom | Meaning |
| --- | --- |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. Use only the repository's sandbox-free layer there; do not weaken Runner tests. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran; check sandbox availability first. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; inspect the sandbox probe before application logs. |
| `插件official_shell不存在[行N，列M]` | A CodeArts step used `run:` instead of `official_shell_plugin` and `OFFICIAL_SHELL_SCRIPT_INPUT`. |
| `target path should be absolutely path which start with:[.../share]` | A CodeArts `upload-obs` source is relative or outside `${SHARE_PATH}`. |
| `sudo: /bin/sudo must be owned by uid 0 and have the setuid bit set` | The CodeArts default pool has no usable root; install tools under `$HOME` or the workspace. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`; regenerate it with `pnpm install --lockfile-only`. |
| Playwright is green with fewer tests than expected | A skip is not a pass. Check counts and not-passed titles; a BLOCKED precondition is reported as skipped. |
