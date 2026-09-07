# CodeArts on GitCode

Read this reference for `.codearts/workflow/`, CodeArts Pipeline failures,
GitCode merge-request checks backed by CodeArts, the default CCE runner, or OBS
test logs. For the OBS bucket, object-key layout, upload contract, public reads,
and toolchain cache, also read [codearts-obs.md](codearts-obs.md). This
repository intentionally does not use GitCode Actions.

## Pipeline inventory

`.codearts/workflow/codearts-pipeline.yml` is the parent, and it now contains
no shell of its own. CodeArts bills pipelines and build tasks separately; the
pipeline quota is exhausted, so every step is an
`official_devcloud_cloudBuild` invocation of a generic run-shell task,
parameterised with `SH_FILE_PATH`, `ARGS` and `ENVS`. Every x64 job uses
`f0b81e4b4b554747b84171782f7a2b15`, whose container image already carries the
toolchain and the QEMU guest image, and the auto-merge pipeline calls the same
task; aarch64 still uses `b6e9c483743d470d9725a1b23c6d1d91`. That task's
console shell records the script's status and then reports success itself, so
its OBS action uploads the log whatever the layer did. Passing
`STRICT_EXIT: "1"` makes it propagate the status instead, and any job that has
to be able to fail — today `verify_results` and the auto merge — must pass it.
A judge that cannot be red is how a run with two failed layers was once
published as successful. The
layers themselves live in `.ci/codearts-layer.sh`: the two UT tiers —
`ci:ut:host` on the build host and `ci:ut:guest` in a QEMU guest — the
hermetic `ci:st` entry point, and the x86_64 package. Because that console shell returns success even when
the layer failed — so its OBS action can still upload the log — every CodeArts
job is green by construction. `.ci/codearts-verify.sh` is therefore the run's
only failure authority: it waits for every layer, reads each recorded
`exit-code` back out of OBS, additionally requires a complete artifact set for
the two packaging layers, and fails closed on a missing object. The result
gate is `completed('verify_results', 'code_check')`, and
`.ci/codearts-pr-result.sh` fills the table's status column from the same
recorded exit codes rather than from job statuses. The parent still owns PR
labels, invokes
the reusable code-check pipeline, builds the x86_64 debug binary on a hosted
runner, invokes an ARM CodeArts Build task for aarch64, and renders the final
PR result. The code check is an externally registered CodeArts pipeline containing the SCA,
anti-poison, static-analysis, and blacklist CloudBuild tasks. Its former local
definition `.codearts/workflow/codearts-pipeline-code-check.yml` was migrated
out of this repository and intentionally deleted. Do not recreate it or remove
the parent caller merely because the local file is absent.

`.codearts/workflow/codearts-resources-pipeline.yml` lives only on the
operational `ci/codearts-resources` branch and is triggered by pushes to that
branch. It prefetches checksum-pinned toolchains and the QEMU Ubuntu image,
falls back to the declared mainland source only on a public OBS miss, verifies
the bytes, and uploads them to stable OBS keys. The branch intentionally
contains only the resource workflow, resource scripts, `README.md`, and the
license; do not merge it into `main`. The formal parent workflow only consumes
these resources and must fail closed when a stable object is missing or has an
invalid checksum.

`.codearts/workflow/codearts-auto-merge-pipeline.yml` is the auto-merge
pipeline, triggered by a `/merge` comment on a merge request targeting
`main`. It is registered against `main` in the console, so unlike the parent
workflow it cannot be rehearsed on `ci/verify-pr-ci`: a change here only takes
effect once it is on `main`. The pipeline
itself only routes the trigger: its single job is an
`official_devcloud_cloudBuild` step that runs `.ci/codearts-auto-merge.sh` on
the same x64 build task the test layers use, because pipeline executor minutes
ran out. `.ci/gitcode-merge-request.py` makes the GitCode
calls, and `.ci/auto-merge.test.mjs` rehearses every decision against a
fixture repository and a fake API.

The script is fetched from `refs/heads/main`, never from the merge request, so
a merge request cannot edit what merges it. Only three values cross the
build-parameter boundary — `${MERGE_ID}`, `${COMMIT_ID}` and the private
`GITCODE_TOKEN` — because a note webhook payload is kilobytes of JSON and a
build parameter is the wrong place for it. The commenter therefore comes back
from `GET /pulls/{number}/comments`: the newest comment whose first word is
`/merge` is the request being served. The script checks that commenter against
`CODEOWNERS` on `main`, reads the merge request's live state (open, not draft,
`mergeable`, head still the commit `${COMMIT_ID}` names), then calls GitCode's
`PUT /api/v5/repos/{owner}/{repo}/pulls/{number}/merge` with
`merge_method=rebase` and `force_merge=true` — linear history, no merge
commit, and GitCode marks the merge request merged. The `/merge` comment from
a CODEOWNERS member is the authorization: `force_merge` carries the merge
past the repository's `review_mode: approval` rule, which otherwise answers
`405 Not enough required approvers` to API and UI alike; the report says
when that happened. `force_merge` needs the repository setting 允许管理员强制合入
and an administrator token. A conflict, a stale head, a rejected merge, or a
non-owner commenter produces an error comment instead, and the build task runs
with `STRICT_EXIT: "1"` so that refusal is also a red run. The pipeline
declares no inputs of its own; its only parameter is `GITCODE_TOKEN`, kept as
a private parameter in the console, whose account must be allowed to merge and
comment on merge requests. Without a merge-request context the job is skipped.

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

Interpret results in the parent workflow, not in the PR bot. The parent
includes both UT tiers, the E2E guest, `binary_aarch64` and its OBS
verification job in the `completed(...)` gate that selects mutually exclusive
success and failure post jobs. Every job in that gate must be able to fail on
its own: a job killed by its CodeArts timeout satisfies neither condition, and
the merge request then keeps the running label with no result comment. It renders a complete result
HTML file from the UT/ST/binary job statuses and each code-check child's own
public result JSON, uploads that file to OBS, and passes its OBS key plus the
already chosen `final_label` to the bot. The bot downloads and posts the HTML
unchanged; it must not read other result artifacts or derive a result
independently, because stale artifacts can disagree with the current run.

Do not use a `rerun` comment to validate a pipeline change: CodeArts can
restart the definition registered for the target branch rather than the one
under test. Update and push the merge request's source branch instead, so the
definition is selected again from the branch the request targets.

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

Every job in the debug parent workflow has a CodeArts job timeout expressed as
`timeout` plus `timeout_unit: minute`. Give lightweight preparation,
artifact-verification, and result-publication jobs five minutes. Give each UT,
ST, binary-package, QEMU, and code-check job 20 minutes. The formal workflow
has no resource-seed job. The separate `ci/codearts-resources` workflow gives
its QEMU preparation job 40 minutes because the first TUNA download can exceed
20 minutes; its smaller toolchain job remains 20 minutes. A timeout must leave
the job non-completed; do not convert it to success or hide it with step-level
continuation.

`official_git_clone` downloads the configured target branch. For a PR-context
run, preserve that downloaded `HEAD` as the target SHA, validate the event's
source SHA, and create a disposable checkout by rebasing the PR-only commits
onto that target. This matches the repository's `merge_method=rebase` landing
policy and prevents an old PR base from replacing newer target-side CI
scripts. Decide whether integration checkout is needed from the actual
`${MERGE_ID}` value, not `pipeline.trigger_type`; comment-triggered `Node` runs
must follow the same checkout path as initial MR runs. Initial PR webhooks
store metadata under `payload.object_attributes`, but a comment webhook has
`event_type: note`, comment metadata under `payload.object_attributes`, and PR
metadata under `payload.merge_request`. Accept both layouts, require a PR
note's `noteable_type` to be `MergeRequest`, and validate its `iid` against
`${MERGE_ID}` when present.

Validate all payload data first: `source_branch` must be a non-empty valid Git
branch without CR/LF, system `${COMMIT_ID}` must be a 40-hex SHA, and
`${MERGE_ID}` must be a positive integer. Use `${COMMIT_ID}` as the
authoritative source head for both initial PR and PR-note runs; do not depend
on a webhook-specific `last_commit` location. Then fetch the upstream MR ref,
verify that it contains the event SHA, and call the repository helper while
`HEAD` still identifies the downloaded target commit:

```sh
FETCH_REF=refs/remotes/origin/codearts-pr-source
git fetch --no-tags --force origin \
  "+refs/merge-requests/$MR_NUMBER/head:$FETCH_REF"
git merge-base --is-ancestor "$SOURCE_SHA" "$FETCH_REF"
bash .ci/rebase-codearts-pr.sh "$SOURCE_BRANCH" "$SOURCE_SHA"
```

Use `refs/merge-requests/<number>/head`, not
`refs/heads/<source_branch>`. The MR ref is exposed by the upstream repository
for both same-repository and fork PRs, whereas a fork-only source branch does
not exist under upstream `refs/heads/`. If the execution SHA is not already
present, fetch that exact SHA before verifying ancestry. Pinning both SHAs
prevents later branch updates from changing the code covered by the current
run. `.ci/rebase-codearts-pr.sh` uses their merge base, fails on a rebase
conflict, disables repository hooks and commit signing, and never pushes the
rewritten commit. It records `target-sha`, `source-sha`, and `integration-sha`
under `.ci-results/codearts-checkout/`; jobs continue to use the original
source SHA for PR-scoped OBS paths and artifact names. Fail rather than testing
another commit if the recorded source SHA is no longer reachable from the MR
ref.

## Default runner constraints

The default CCE pool is an unprivileged EulerOS 2.0 SP10 pod even when YAML
requests `ubuntu-latest`. It runs as `octopus`, has no usable root, and cannot
create user namespaces. Runner UT and E2E therefore cannot run directly in
that pod. Do not use QEMU user-mode emulation as a workaround: it still shares
the host kernel and its namespace restriction.

The UT guest tier instead runs `pnpm ci:ut:guest` in a full Ubuntu guest
under `qemu-system-x86_64 -accel tcg,thread=multi`. TCG is software-only, so
`/dev/kvm` is neither requested nor required. The job downloads a
pre-provisioned qcow2 from its immutable resource-commit/run path and verifies
the repository-pinned SHA256 before booting. A miss or checksum mismatch fails
before the VM starts; formal CI never rebuilds the image or falls back to a
source mirror. The `ci/codearts-resources` workflow owns the date-pinned
Ubuntu download, one-time guest provisioning, checksum generation,
three-object upload, and public read-back verification.

The guest compiles nothing. Before booting, the job provisions the runner and
runs `pnpm install --frozen-lockfile` and `pnpm build` on native CPU, then
`.ci/pack-workspace.sh` packs `git archive HEAD` together with the dependency
tree and every `dist/` into one payload. `.ci/run-qemu-layer.sh <layer>` serves
that payload over the existing cloud-init seed server; the guest streams it
into place, verifies the baked Node, pnpm, uv, and bubblewrap versions,
configures the package registry, and invokes the layer entry point, whose step
list for `ut-guest` contains no install and no build. Measured on the run
before the split, the guest spent 476 s in `pnpm build` and 92 s in
`pnpm install` against 142 s of actual tests; the pinned image download was
17 s, so the image cache was never the cost.

The mocked E2E group runs in the same guest through the same `ci:e2e` entry
point: the host prepares it with `CI_E2E_PREPARE_ONLY=1`, which installs
`.e2e` and the pinned Chromium under `CI_E2E_BROWSERS_DIR` inside the
checkout so `.ci/pack-workspace.sh --include .e2e` carries them, and the guest
runs it with `CI_E2E_PREPARED=1`, a longer stack-health budget, and the
Huawei PyPI mirror it needs to provision the Python services. Driving Chromium
and provisioning those environments under TCG is far slower than the UT guest
tier; its job budget is correspondingly larger.

When the host has no QEMU, `.ci/run-qemu-layer.sh` downloads the portable
emulator the resource branch publishes, verifies it against
`.ci/qemu-emulator.sha256`, and unpacks it into the workspace. Assembling it
from signed Alpine packages inside the test job cost about 166 seconds per
run and would now be paid twice, once per guest job, so
`.ci/build-qemu-emulator.sh` on `ci/codearts-resources` owns that work: it
runs the same checksum-pinned bootstrap, proves the binaries execute from an
arbitrary directory, and packs the tree deterministically, so a rerun that
resolves the same Alpine packages republishes the same contents. The payload is still a
user-space tree of a musl loader, the QEMU binaries, their libraries and
firmware, independent of the host package manager and glibc, needing no root
and running no package scripts. The VM boots with a NoCloud seed over QEMU user networking. The guest clears its
own Ubuntu AppArmor userns sysctl, passes the real bubblewrap probe as the
unprivileged `ci` user, and invokes the unchanged layer entry point. Only the exact
`QEMU_SANDBOX_TEST_RESULT=<exit-code>` serial marker can make the host job
pass; the host removes serial CR characters before matching, and missing or
malformed markers fail closed. The guest sets Node's test-file concurrency to
one to avoid emulator-induced disconnect timing races without skipping or
changing assertions. This is slower than a native
worker and currently covers Runner UT only. A self-hosted Linux resource pool
that passes the real bubblewrap probe remains the preferred long-term route.

The debug x86_64 binary job keeps the repository's proven hosted labels
`[codearts-hosted, ubuntu-latest, x64, large]`. The aarch64 parent job runs on
`default` only to invoke ARM Build task `b6e9c483743d470d9725a1b23c6d1d91`;
the Build task, not the parent job's `runs-on`, owns the ARM executor. Its
console shell is a reusable bootstrap: it fetches the target branch from
`GIT_TARGET_REF` and the merge-request source from `GIT_REF`, requires the
Build system's `COMMIT_ID` (or the console-provided `GIT_COMMIT` alias) to be
reachable from the latter, then calls `.ci/rebase-codearts-pr.sh` before
invoking `.ci/codearts-build-dispatch.sh`. The dispatcher receives the
generated integration SHA as `EXPECTED_COMMIT` and the original event SHA as
`ARTIFACT_COMMIT`, so packaging verifies the rebased checkout while preserving
source-scoped artifact names and OBS paths. Do not add a duplicate custom
commit parameter when the Build task already provides `COMMIT_ID`.

The graphical Build shell action embeds its command in a Groovy
`WorkflowScript` before Bash sees it. A literal backslash in the pasted command
can therefore fail Groovy compilation with `unexpected char` before checkout.
Use the published ASCII-only bootstrap with no backslashes or empty lines as-is;
if a different command must contain backslashes, double every one for the
Groovy layer. Rich-text copy can insert `U+200B` on an apparently blank line;
paste as plain text and remove that invisible line if Bash reports it as a
command. The bootstrap
captures both success and failure output as `run.log`, records the real command
status in `exit-code`, and returns success only so the following OBS action can
preserve those diagnostics. The parent OBS verification job remains the final
failure authority and rejects any nonzero `exit-code`.

Runtime parameters from the parent are `GIT_REPO_URL`, `GIT_REF`, `GIT_TARGET_REF`,
`SH_FILE_PATH`, `ARTIFACT_PATH`, `OBS_BUCKET`, `OBS_DIRECTORY`,
`OBS_ENDPOINT`, `ENVS`, and `ARGS`. `SH_FILE_PATH` and `ARTIFACT_PATH` are
repository-relative. `ENVS` contains one `NAME=VALUE` record per line, and
`ARGS` contains one argument per line; values and arguments are not
shell-evaluated. The dispatcher rejects paths outside the checkout, malformed
environment names, and shell-control variables such as `PATH`, `BASH_ENV`,
and `LD_PRELOAD`, then uses `exec bash` so the child exit status becomes the
Build result. Keep long build commands in the referenced script rather than in
the pipeline parameter, whose custom value is limited by CodeArts.

Set `GIT_TARGET_REF` from CodeArts's source-specific system parameter as
`refs/heads/${sciencediscovery_TARGET_BRANCH}`. CodeArts resolves that value to
the merge request's actual target branch, so the same parent definition passes
`refs/heads/ci/verify-pr-ci` for the debug workflow and `refs/heads/main` after
the workflow is promoted. Do not hard-code either target branch in the ARM
Build call.

The Build task's following OBS action uploads
`.codearts-build/repository/${ARTIFACT_PATH}/*` with an empty destination file
name, folder upload disabled, and failure continuation disabled. The parent
does not treat `artifactIdentifier` as evidence for this OBS upload. A
dependent job probes the commit-qualified aarch64 binary, `SHA256SUMS`,
`VERSION`, `run.log`, and `exit-code` at the exact run-specific OBS prefix,
requires the exit code to be zero, and validates the checksum file format.
Missing objects therefore fail closed.

The aarch64 package script asserts both the pipeline's expected commit and
`uname -m` before packaging. It calls the repository-owned package entry
point, verifies the normalized binary and `SHA256SUMS`, and leaves the binary,
`SHA256SUMS`, `VERSION`, `run.log`, and `exit-code` in the artifact directory.
Both architecture paths probe bubblewrap independently. If the probe fails,
the job may use the script's explicit `--skip-smoke` downgrade, but the log
and PR documentation must say the artifact is packaging-only rather than
release-smoke verified.

Debug binaries use the CodeArts source context's eight-character
`commit_id_short` and are named
`ScienceDiscovery-<commit_id_short>-linux-<architecture>`. Keep the local
rename, OBS key, verifier, checksum regex, and PR result link synchronized when
this convention changes. `VERSION` continues to record the full commit.

Raw GitHub Release downloads can time out repeatedly from mainland CodeArts
runners. The debug binary jobs therefore set `MICROMAMBA_CONDA_MIRROR` to the
Tsinghua TUNA conda-forge mirror. `fetch-managed-micromamba.mjs` downloads the
architecture-specific pinned `.tar.bz2`, verifies the archive SHA256, extracts
`bin/micromamba`, and still verifies the executable against the upstream raw
binary SHA256. Do not replace this with an untrusted GitHub proxy or disable
either checksum. In the formal CodeArts workflow, `BINARY_CACHE_ONLY=1` makes
the stable OBS object mandatory, so this source URL is not contacted. The
mirror remains the verified fallback used by the dedicated resource workflow
and by non-cache-only local invocations.

The OBS layout and verified toolchain cache contract are defined in
[codearts-obs.md](codearts-obs.md). Keep public runtime scripts on the generic
`BINARY_CACHE_URL` / `BINARY_CACHE_DIR` mechanism; CodeArts-specific variable
translation stays in `.ci/` and `.codearts/`.

Install Node, pnpm, uv, and other user-space tools with
`.ci/provision-runner.sh`; do not use `dnf` or rely on `sudo`. Pipeline `env`
entries are parameters, not implicit shell exports, so pass mirror values into
shell steps explicitly. Keep committed uv lockfiles portable: retarget only the
disposable CodeArts checkout and verify that locked package versions do not
change.

## Upload test logs to OBS

Follow the upload and failure-preservation contract in
[codearts-obs.md](codearts-obs.md). In particular, keep the real layer exit
code, upload only from an absolute path below `${SHARE_PATH}`, and use both the
source commit and `pipeline.run_id` in the object key.

## Publish the PR result

The PR comment must expose the public GitCode Checks page, not a CodeArts
console URL that requires a Huawei Cloud login:

```text
https://gitcode.com/openJiuwen/sciencediscovery/pull/<MR_NUMBER>/check
```

List all four code-check subtasks (SCA, anti-poison, CodeCheck, and blacklist),
plus core UT, QEMU Runner UT, ST, and both binary architectures. User-facing status cells contain
only `PASSED` or `FAILED`. CodeArts may report successful jobs as lifecycle
state `completed`; normalize `completed`, `passed`, `success`, `successful`,
and `succeeded` to `PASSED`, and every other value to `FAILED`. Do not print
`COMPLETED` in the table.

The four code-check rows do **not** share the parent `jobs.code_check.status`.
Read the SCA, anti-poison, CodeCheck, and blacklist public result JSON files
independently. Normalize each JSON `status` after trimming and lowercasing it:
only `completed`, `pass`, `passed`, `success`, `successful`, and `succeeded`
map to `PASSED`; missing, malformed, unknown, and all other values map to
`FAILED`. This deliberately treats the observed provider typo `FIALED` as
`FAILED` instead of guessing intent or hiding the failure behind the parent
summary.

Validate each code-check JSON `link` separately from its status and publish it
only when it is an absolute HTTPS URL; otherwise show `N/A`. A missing or
invalid link must not change a valid status. For UT/ST and failed binary rows,
probe the public OBS log object with a small ranged request
(`Range: bytes=0-0`) and accept only HTTP `200` or `206`.
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
not available, ask the user for the complete job log. When upload ran, the
public diagnostics and artifact paths follow the layout in
[codearts-obs.md](codearts-obs.md).

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
| QEMU reports `could not load module for type tcg-accel-ops` | A workspace-extracted QEMU needs `QEMU_MODULE_DIR=<root>/usr/lib/x86_64-linux-gnu/qemu`; also pass its data directory with `-L` and its SeaBIOS path explicitly. |
| QEMU exits without `QEMU_SANDBOX_TEST_RESULT=<code>` | Guest provisioning, cloud-init, or the test harness did not finish. Keep the job red and inspect the run-scoped `ut-guest/run.log`; do not infer success from QEMU's process status alone. |
| The guest layer reports `BLOCKED: ... expects a workspace its host already installed and built` | The job reached the guest without running install and build on the host. Fix the host steps; do not add an install or build to the guest, which is what the split exists to remove. |
| A guest log shows `Scope: all N workspace projects`, or `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | pnpm 11 defaults `verify-deps-before-run` to `install`, and its check keys `node_modules/.pnpm-workspace-state-v1.json` by the absolute project directories of the machine that installed. A workspace moved into the guest therefore always reports "the workspace structure has changed", and the reinstall then aborts because the modules directory came from another store. Keep `pnpm_config_verify_deps_before_run=` in the guest: pnpm reads the override from `pnpm_config_`, not `npm_config_`, and only skips the check for a falsy value. |
| YAML requests `ubuntu-latest`, but logs show `octopus_container` and EulerOS | The default CCE execution mode ignored or overrode the OS label; use a dedicated pool for an actual Ubuntu rootfs. |
| A child CloudBuild command ends with bare `--pr_id` | The child read `${MERGE_ID}`, which is not inherited from the parent. Pass the parent's MR ID as `PR_ID` and consume `${PR_ID}` inside every child task. |
| `fatal: couldn't find remote ref refs/heads/<source>` on a fork PR | The checkout tried to fetch a fork-only branch from upstream. Fetch `refs/merge-requests/<MERGE_ID>/head` and detach at the validated event SHA. |
| The PR table reports `COMPLETED` | The workflow exposed a raw CodeArts lifecycle state. Normalize it to `PASSED`; map every non-success state to `FAILED`. |
| All four code-check rows show one shared status | The parent job status was reused. Read and normalize the four public child result JSON files independently. |
| A child result says `FIALED` or another unknown value | It is outside the success allowlist and must render as `FAILED`; fail closed rather than correcting arbitrary provider strings. |
| An `arm64` binary job runs on `x86_64` | Runner labels or scheduling are wrong. Fail the architecture preflight before packaging; do not call a cross-build a native ARM64 runner result. |
| Managed micromamba times out on `github.com/mamba-org/micromamba-releases` | Mainland egress cannot reach the raw GitHub Release reliably. For the debug binary jobs, use the pinned TUNA conda package through `MICROMAMBA_CONDA_MIRROR`; keep both archive and extracted-binary SHA256 checks. |
| A stable OBS toolchain, QEMU base, or prebuilt Runner image is missing or has the wrong checksum | Keep the formal job failed; it is cache-only by design. Run the `ci/codearts-resources` workflow to rebuild and verify resources, update the formal image commit/run/SHA pin when advancing the image, then rerun formal CI. Never weaken the repository checksum. |
| ARM provisioning says no matching `uv` version even though the mirror index lists it | pip's compatibility filter rejected the wheel. Read the logged Python and pip versions before deciding whether the cause is the Python requirement or platform-tag support. Provisioning avoids both variables by fetching the architecture-specific pinned TUNA wheel (or `CI_UV_WHEEL_URL`) with the repository SHA256, then extracting its verified `uv` and `uvx` scripts directly. |
| A CPython stable-cache request gets `403` for its raw `+` URL | OBS may have the object but the HTTP path is unescaped. Percent-encode the basename (`+` becomes `%2B`) before probing or downloading, then verify SHA256 as usual. |
| ARM Build fails with Groovy `unexpected char: '\'` before any shell output | The graphical shell action compiled a literal backslash as Groovy source. Replace the pasted content with the zero-backslash bootstrap, or double every backslash before saving. |
| ARM Build prints an apparently blank command and exits 127 with `command not found` | Rich-text copy inserted an invisible `U+200B` character. Paste the ASCII-only bootstrap as plain text; its published form contains no empty lines where the editor can add that character. |
| The ARM Build task is green but an aarch64 OBS object is missing | The bootstrap or OBS action is missing/misconfigured, or the parent and child prefixes differ. Keep the parent OBS-verification job red; compare `OBS_DIRECTORY`, `ARTIFACT_PATH`, and the five expected object names. |
| A generated UT/ST OBS URL returns `403` after checkout or provisioning failed | The upload step never ran and the object does not exist. Probe the object before linking and fall back to the GitCode Checks page. |
| `独占任务official_devcloud_cloudBuild所在的job下不能配置其他step` | The bot CloudBuild task shares its job with rendering or upload. Move preparation into a separate prerequisite job. |
| A CodeArts UI save restores old pipeline logic | The UI committed a stale expanded snapshot. Diff the new `main` commit, preserve its generated fields, and reapply the lost logic. |
| A `rerun` comment starts CI but PR checkout, labels, or result publishing are skipped | The comment trigger reports type `Node`, so an `MR`-only guard evaluates false. In expressions, test `sources.sciencediscovery.merge_id`; in steps, use `${MERGE_ID}`. |
| `inputs.PR_CONTEXT_ID != ''` skips a `Node` rerun even though `${MERGE_ID}` is present in the shell | CodeArts did not runtime-expand the input default for the Node trigger. Remove the proxy input and use `sources.sciencediscovery.merge_id` directly. |
| A job fails on its first step with `named capturing group is missing trailing '}'` | A `${{ env.<input> }}` expansion inside a script received a value containing `${…}` (typically a console default of `${MERGE_ID}`); CodeArts substitutes with Java `Matcher.appendReplacement`, which reads `${` as a group reference. Keep input defaults free of `${`, and read system parameters through the step `env:` block. |
| Checkout reports `expected a merge_request payload, received note` | PR comments use the Note Event schema. Read PR metadata from `payload.merge_request`, not the comment's `payload.object_attributes`. |
