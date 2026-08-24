# CodeArts on GitCode

Read this reference for `.codearts/workflow/`, CodeArts Pipeline failures,
GitCode merge-request checks backed by CodeArts, the default CCE runner, or OBS
test logs. This repository intentionally does not use GitCode Actions.

## Pipeline inventory

`.codearts/workflow/codearts-pipeline.yml` is the parent: it owns PR labels,
runs the repository's `ci:ut:core` and hermetic `ci:st` entry points, invokes
the reusable code-check pipeline, and renders the final PR result. The child
definition `.codearts/workflow/codearts-pipeline-code-check.yml` contains only
the SCA, anti-poison, static-analysis, and blacklist CloudBuild tasks; their
complete commands remain in CodeArts.

GitHub remains a separate mirrored repository and covers full UT, mocked E2E,
and smoke-gated binaries. Do not add `.gitcode/workflows/ci.yml` as another CI
definition: GitCode merge-request CI is CodeArts-only.

## Parent and child orchestration

The parent invokes registered child pipeline
`3a80cbaf5dec4e0b8804ce1401787f5f`. The manual documents a minimal
`SubPipeline` form, but the CodeArts editor expands this repository's step to
the platform plugin below. Preserve the generated fields when editing it:

```yaml
- name: Run the reusable code-check pipeline
  uses: official_devcloud_subPipeline
  with:
    PR_ID: "${PR_ID}"
    number: "${PR_ID}"
    SYSTEM_DEVCLOUD_SUBPIPELINE_TRIGGER_ID: 3a80cbaf5dec4e0b8804ce1401787f5f
    SYSTEM_DEVCLOUD_SUBPIPELINE_BRANCH: PARENT
```

A sub-pipeline run does not inherit the parent's `${MERGE_ID}`. Define a parent
`PR_ID` input whose default is `${MERGE_ID}`, pass `${PR_ID}` through the
expanded plugin, and make every child CloudBuild task consume the child input
`${PR_ID}`. Reading `${MERGE_ID}` inside the child expands to empty and produces
commands such as `--pr_id` with no argument. A manual run may provide `PR_ID`;
when it is empty, skip the PR-oriented child and run UT/ST only.

CodeArts supports manual execution without an `on` entry. Guard GitCode writes
with `${{ pipeline.trigger_type == 'MR' }}` so a manual run does not use an
empty `${MERGE_ID}`. Keep the label task in the parent before verification, and
keep the final publisher in `post` with `select: always` so failed checks can
still report their status.

Interpret results in the parent workflow, not in the PR bot. The parent uses
`completed('ut', 'st', 'code_check')` to select mutually exclusive success and
failure post jobs, renders a complete `result_html` body from
`jobs.<job_id>.status`, and passes the already chosen `final_label`. The bot may
post that HTML and apply the supplied label, but must not read OBS or derive a
result independently; otherwise stale artifacts can disagree with the current
CodeArts run.

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
| A child CloudBuild command ends with bare `--pr_id` | The child read `${MERGE_ID}`, which is not inherited from the parent. Pass the parent's MR ID as `PR_ID` and consume `${PR_ID}` inside every child task. |
