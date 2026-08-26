# CodeArts on GitCode

Read this reference for `.codearts/workflow/`, CodeArts Pipeline failures,
GitCode merge-request checks backed by CodeArts, the default CCE runner, or OBS
test logs. This repository intentionally does not use GitCode Actions.

## Pipeline inventory

`.codearts/workflow/codearts-pipeline.yml` is the parent: it owns PR labels,
runs the repository's `ci:ut:core` and hermetic `ci:st` entry points, invokes
the reusable code-check pipeline, and renders the final PR result. The code
check is an externally registered CodeArts pipeline containing the SCA,
anti-poison, static-analysis, and blacklist CloudBuild tasks. Its former local
definition `.codearts/workflow/codearts-pipeline-code-check.yml` was migrated
out of this repository and intentionally deleted. Do not recreate it or remove
the parent caller merely because the local file is absent.

`.codearts/workflow/codearts-auto-merge-pipeline.yml` is the auto-merge
pipeline, triggered by a `/merge` comment on a merge request targeting
`main`. A copy named `codearts-auto-merge-pipeline-test.yml` exists only on
`ci/verify-pr-ci`, registered against that branch, for experiments. On a
`/merge` comment it checks the commenter against
`CODEOWNERS` on `main`, reads the merge request's live state (open, base equal to the merge
request's own target branch, not draft, `mergeable`, head still the commit
the comment was made on), then calls GitCode's
`PUT /api/v5/repos/{owner}/{repo}/pulls/{number}/merge` with
`merge_method=rebase` and `force_merge=true` — linear history, no merge
commit, and GitCode marks the merge request merged. The `/merge` comment from
a CODEOWNERS member is the authorization: `force_merge` carries the merge
past the repository's `review_mode: approval` rule, which otherwise answers
`405 Not enough required approvers` to API and UI alike; the report says
when that happened. `force_merge` needs the repository setting 允许管理员强制合入
and an administrator token. A conflict, a stale head, a rejected merge, or a
non-owner commenter produces an error comment instead. It declares no
inputs: the merge request number, source commit, and
note payload come from the system `${MERGE_ID}`, `${COMMIT_ID}`, and
`${WEBHOOK_PAYLOAD}`; the only parameter is `GITCODE_TOKEN`, kept as a
private parameter in the console, whose account must be allowed to merge
and comment on merge requests. Without a merge-request context the job is
skipped.

GitHub remains a separate mirrored repository and covers full UT, mocked E2E,
and smoke-gated binaries. Do not add `.gitcode/workflows/ci.yml` as another CI
definition: GitCode merge-request CI is CodeArts-only.

## Parent and child orchestration

The parent invokes registered child pipeline
`2dce32a1e91949d4872f6d10a9d86b2e`. The manual documents a minimal
`SubPipeline` form, but the CodeArts editor expands this repository's step to
the platform plugin below. Read the live YAML before editing and preserve all
generated fields:

```yaml
- name: code_check
  uses: official_devcloud_subPipeline
  with:
    PR_ID: "${MERGE_ID}"
    number: "${PR_ID}"
    webhook_payload: "${WEBHOOK_PAYLOAD}"
    SYSTEM_DEVCLOUD_SUBPIPELINE_TRIGGER_ID: 2dce32a1e91949d4872f6d10a9d86b2e
    SYSTEM_DEVCLOUD_SUBPIPELINE_BRANCH: PARENT
```

A sub-pipeline run does not inherit the parent's `${MERGE_ID}`. Define a parent
`PR_ID` input whose default is `${MERGE_ID}`, pass an effective PR number
through the expanded plugin, and make every child CloudBuild task consume the
child input `${PR_ID}`. Reading `${MERGE_ID}` inside the child expands to empty
and produces commands such as `--pr_id` with no argument. The generated caller
currently forwards `${MERGE_ID}` as `PR_ID` for MR runs and `${PR_ID}` in the
`number` field. Before claiming that a manual `PR_ID` run is supported, verify
in an actual run that the effective value reaches every child task.

Do not use `pipeline.trigger_type == 'MR'` to recognize PR context. A GitCode
comment such as `rerun` re-triggers the PR pipeline with trigger type `Node`,
while system `${MERGE_ID}` remains populated. In an expression, read its
documented source-context equivalent and guard PR labels and comments with
`${{ sources.sciencediscovery.merge_id != '' }}`. Do not copy `${MERGE_ID}`
into an input default for this purpose: CodeArts leaves that input empty on a
`Node` run even though the system parameter is available to steps. Manual and
periodic runs have no source `merge_id`, so they run UT/ST without writing to a
PR. A manually supplied `PR_ID` may still enable the PR-oriented code-check
child, but it must not enable labels or comments. Keep the label task in the
parent before verification, and keep the final publisher in `post` with
`select: always` so failed checks can still report their status.

Interpret results in the parent workflow, not in the PR bot. The parent uses
`completed('ut', 'st', 'code_check')` to select mutually exclusive success and
failure post jobs, renders a complete result HTML file from
`jobs.<job_id>.status`, uploads that file to OBS, and passes its OBS key plus the
already chosen `final_label` to the bot. The bot downloads and posts the HTML
unchanged; it must not read other result artifacts or derive a result
independently, because stale artifacts can disagree with the current run.

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

`official_git_clone` may still download the configured `main` source for a
PR-context run, so UT/ST must explicitly switch to the source commit from the
MR event. Decide whether checkout is needed from the actual `${MERGE_ID}`
value, not `pipeline.trigger_type`; comment-triggered `Node` runs must follow
the same checkout path as initial MR runs. Initial PR webhooks store metadata
under `payload.object_attributes`, but a comment webhook has `event_type: note`,
comment metadata under `payload.object_attributes`, and PR metadata
under `payload.merge_request`. Accept both layouts, require a PR note's
`noteable_type` to be `MergeRequest`, and validate its `iid` against
`${MERGE_ID}` when present.

Validate all payload data first: `source_branch` must be a non-empty valid Git
branch without CR/LF, system `${COMMIT_ID}` must be a 40-hex SHA, and
`${MERGE_ID}` must be a positive integer. Use `${COMMIT_ID}` as the
authoritative source head for both initial PR and PR-note runs; do not depend
on a webhook-specific `last_commit` location. Then fetch the upstream MR ref
and detach at that execution SHA:

```sh
FETCH_REF=refs/remotes/origin/codearts-pr-source
git fetch --no-tags --force origin \
  "+refs/merge-requests/$MR_NUMBER/head:$FETCH_REF"
git merge-base --is-ancestor "$SOURCE_SHA" "$FETCH_REF"
git checkout --detach "$SOURCE_SHA"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
```

Use `refs/merge-requests/<number>/head`, not
`refs/heads/<source_branch>`. The MR ref is exposed by the upstream repository
for both same-repository and fork PRs, whereas a fork-only source branch does
not exist under upstream `refs/heads/`. If the execution SHA is not already
present, fetch that exact SHA before verifying ancestry. Detaching at that SHA
also prevents a later source update from changing the code covered by the
current run. Fail rather than testing another commit if the recorded SHA is no
longer reachable from the MR ref.

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

An early checkout or provisioning failure occurs before `run.log` is staged
and before `upload-obs` runs. In that case the public OBS URL is expected to be
missing and may return HTTP `403`; do not publish it as if a log exists.

## Publish the PR result

The PR comment must expose the public GitCode Checks page, not a CodeArts
console URL that requires a Huawei Cloud login:

```text
https://gitcode.com/openJiuwen/sciencediscovery/pull/<MR_NUMBER>/check
```

List all four code-check subtasks (SCA, anti-poison, CodeCheck, and blacklist),
plus UT and ST. User-facing status cells contain only `PASSED` or `FAILED`.
CodeArts may report successful jobs as lifecycle state `completed`; normalize
`completed`, `passed`, `success`, `successful`, and `succeeded` to `PASSED`, and
every other value to `FAILED`. Do not print `COMPLETED` in the table.

For code-check detail links, read the public result JSON created by the child
pipeline and publish its validated absolute HTTPS `link`; use `N/A` when the
JSON or link is unavailable. For UT/ST, probe the public OBS object with a
small ranged request (`Range: bytes=0-0`) and accept only HTTP `200` or `206`.
If the object is missing or inaccessible, link to the GitCode Checks page and
say that the public test log was not generated. This probe controls only link
availability; `jobs.<job_id>.status` controls the reported test result.

Keep result rendering and OBS upload in a preparation job, and keep the
`official_devcloud_cloudBuild` bot task alone in its publisher job. CodeArts
rejects a job that places another step beside this exclusive CloudBuild task.
The bot's `result_html` input is an OBS object key, not inline HTML.

## Read a result

CodeArts PaC runs do not register in GitCode's `/api/v8/.../actions` endpoints.
The result comment and `ci-*` labels the bot puts on the merge request are
described in the create-pr skill; this section is about the run itself.

The MR check page (`/pull/<number>/check`) exposes the job status and
build-log entry. Complete CodeArts
run details may still require CodeArts credentials; if those credentials are
not available, ask the user for the complete job log. When upload ran, UT/ST
`run.log` files are also archived at:

```text
obs://openjiuwen-ci/sciencediscovery/ci/<commit>/<pipeline.run_id>/<ut|st>/run.log
```

Do not infer a root cause from the generic final `COCT.1140002.450`; use the
first failing step and its inner command or plugin error.

## Editing through the CodeArts UI

Saving the pipeline in CodeArts can commit an expanded but stale YAML snapshot
to `main`. After every UI mutation, fetch `origin/main` and diff the resulting
workflow against the intended prior version. Preserve newly generated fields
and deliberate UI changes, such as the current `merge_comment` value, then
reapply only the logic that the stale snapshot removed. Validate the final
workflow again before pushing. Never overwrite a new UI commit blindly.

## Failure signals

| Symptom | Meaning |
| --- | --- |
| `插件official_shell不存在[行N，列M]` | The step used `run:` instead of `official_shell_plugin` and `OFFICIAL_SHELL_SCRIPT_INPUT`. |
| `download task did not create the expected source directory` while files are listed directly under `share` | The shell expected a nested repository directory; use `${SHARE_PATH}` itself. |
| `target path should be absolutely path which start with:[.../share]` | An `upload-obs` source is relative or outside `${SHARE_PATH}`. |
| `sudo: /bin/sudo must be owned by uid 0 and have the setuid bit set` | The default pool has no usable root; install user-space tools under `$HOME` or the workspace. |
| YAML requests `ubuntu-latest`, but logs show `octopus_container` and EulerOS | The default CCE execution mode ignored or overrode the OS label; use a dedicated pool for an actual Ubuntu rootfs. |
| A child CloudBuild command ends with bare `--pr_id` | The child read `${MERGE_ID}`, which is not inherited from the parent. Pass the parent's MR ID as `PR_ID` and consume `${PR_ID}` inside every child task. |
| `fatal: couldn't find remote ref refs/heads/<source>` on a fork PR | The checkout tried to fetch a fork-only branch from upstream. Fetch `refs/merge-requests/<MERGE_ID>/head` and detach at the validated event SHA. |
| The PR table reports `COMPLETED` | The workflow exposed a raw CodeArts lifecycle state. Normalize it to `PASSED`; map every non-success state to `FAILED`. |
| A generated UT/ST OBS URL returns `403` after checkout or provisioning failed | The upload step never ran and the object does not exist. Probe the object before linking and fall back to the GitCode Checks page. |
| `独占任务official_devcloud_cloudBuild所在的job下不能配置其他step` | The bot CloudBuild task shares its job with rendering or upload. Move preparation into a separate prerequisite job. |
| A CodeArts UI save restores old pipeline logic | The UI committed a stale expanded snapshot. Diff the new `main` commit, preserve its generated fields, and reapply the lost logic. |
| A `rerun` comment starts CI but PR checkout, labels, or result publishing are skipped | The comment trigger reports type `Node`, so an `MR`-only guard evaluates false. In expressions, test `sources.sciencediscovery.merge_id`; in steps, use `${MERGE_ID}`. |
| `inputs.PR_CONTEXT_ID != ''` skips a `Node` rerun even though `${MERGE_ID}` is present in the shell | CodeArts did not runtime-expand the input default for the Node trigger. Remove the proxy input and use `sources.sciencediscovery.merge_id` directly. |
| A job fails on its first step with `named capturing group is missing trailing '}'` | A `${{ env.<input> }}` expansion inside a script received a value containing `${…}` (typically a console default of `${MERGE_ID}`); CodeArts substitutes with Java `Matcher.appendReplacement`, which reads `${` as a group reference. Keep input defaults free of `${`, and read system parameters through the step `env:` block. |
| Checkout reports `expected a merge_request payload, received note` | PR comments use the Note Event schema. Read PR metadata from `payload.merge_request`, not the comment's `payload.object_attributes`. |
