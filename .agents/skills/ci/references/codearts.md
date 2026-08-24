# CodeArts on GitCode

Read this reference for `.codearts/workflow/`, CodeArts Pipeline failures,
GitCode merge-request checks backed by CodeArts, the default CCE runner, or OBS
test logs. This repository intentionally does not use GitCode Actions.

## Pipeline inventory

`.codearts/workflow/codearts-pipeline.yml` runs the repository's `ci:ut:core`
and hermetic `ci:st` entry points. `.codearts/workflow/codearts-pipeline-code-check.yml`
is the repository-hosted definition of the separate merge-request code-check
pipeline; its jobs invoke CloudBuild tasks whose complete commands remain in
CodeArts.

GitHub remains a separate mirrored repository and covers full UT, mocked E2E,
and smoke-gated binaries. Do not add `.gitcode/workflows/ci.yml` as another CI
definition: GitCode merge-request CI is CodeArts-only.

## PaC syntax and source checkout

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
lists display names only. Keep generated stage and step identifiers verbatim.

Each job must run `official_git_clone`. For this pipeline's single GitCode
source, the task expands the checkout directly into `${SHARE_PATH}`, not a
nested `${SHARE_PATH}/sciencediscovery` directory. Run
`.ci/provision-runner.sh`, set writable `CI_RESULTS_DIR` / `CI_RUNTIME_DIR`
paths, and call the repository-owned layer entry point.

## Default runner constraints

The default CCE pool is an unprivileged EulerOS 2.0 SP10 pod even when YAML
requests `ubuntu-latest`. It runs as `octopus`, has no usable root, and cannot
create user namespaces. Runner UT and E2E therefore remain excluded. A
sandboxed layer requires a self-hosted resource pool that passes an actual
bubblewrap probe.

Install Node, pnpm, uv, and other user-space tools with
`.ci/provision-runner.sh`; do not use `dnf` or rely on `sudo`. Pipeline `env`
entries are parameters, not implicit shell exports, so pass mirror values into
shell steps explicitly. Keep committed uv lockfiles portable: retarget only the
disposable CodeArts checkout and verify that locked package versions do not
change.

## Upload test logs to OBS

Preserve diagnostics without hiding test failures: run the layer, stage its
exit code, guarantee `run.log` exists, upload the log, and then exit with the
staged code.

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
more than once, and a commit-only key overwrites earlier diagnostics. This
source expansion and OBS layout passed on CodeArts on 2026-08-24.

## Read a result

CodeArts PaC runs do not register in GitCode's `/api/v8/.../actions` endpoints.
The merge-request bot table is visible through:

```bash
gitcode pr view <number> -R <owner>/<repo> --comments --json
```

The MR check page may expose a CodeArts console link and `pipeline.run_id`, but
complete run details require CodeArts credentials. If those credentials are
not available, ask the user for the complete job log. UT/ST `run.log` files are
also archived at:

```text
obs://openjiuwen-ci/sciencediscovery/ci/<commit>/<pipeline.run_id>/<ut|st>/run.log
```

Do not infer a root cause from the generic final `COCT.1140002.450`; use the
first failing step and its inner command or plugin error.

## Failure signals

| Symptom | Meaning |
| --- | --- |
| `插件official_shell不存在[行N，列M]` | The step used `run:` instead of `official_shell_plugin` and `OFFICIAL_SHELL_SCRIPT_INPUT`. |
| `download task did not create the expected source directory` while files are listed directly under `share` | The shell expected a nested repository directory; use `${SHARE_PATH}` itself. |
| `target path should be absolutely path which start with:[.../share]` | An `upload-obs` source is relative or outside `${SHARE_PATH}`. |
| `sudo: /bin/sudo must be owned by uid 0 and have the setuid bit set` | The default pool has no usable root; install user-space tools under `$HOME` or the workspace. |
| YAML requests `ubuntu-latest`, but logs show `octopus_container` and EulerOS | The default CCE execution mode ignored or overrode the OS label; use a dedicated pool for an actual Ubuntu rootfs. |
