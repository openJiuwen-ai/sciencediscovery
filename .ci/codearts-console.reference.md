# What is configured in the CodeArts console

Half of this CI lives outside the repository. The workflows in
`.codearts/workflow/` name build tasks by id and hand them parameters, but what
those tasks *are* — the image they run, the steps around the shell, the shell
itself, the private parameters — is configured on the CodeArts console, where
nothing here can read it. This file is the mirror of that side.

**The rule: a console change asked of a person is made here in the same
commit, and the full text of whatever they must paste is handed over with the
request.** This is not bookkeeping. `.ci/codearts-runner-shell.reference.sh`
was once changed in the repository and not on the console; the console kept
running the previous text, and a full CI round finished green with no artifacts
before anyone worked out why.

`.ci/codearts-console.test.mjs` fails when a workflow names a build task or
passes a custom parameter this file does not mention, so the mirror cannot
silently fall behind the YAML. It cannot check the console itself — only a run
log can do that, and the "how to tell" notes below say what to look for.

## Build tasks

| id | what it is | its shell |
| --- | --- | --- |
| `f0b81e4b4b554747b84171782f7a2b15` | The x64 run-shell task. Every x64 job of the parent workflow and the auto merge run on it. | [`codearts-runner-shell.reference.sh`](codearts-runner-shell.reference.sh) |
| `b6e9c483743d470d9725a1b23c6d1d91` | The aarch64 packaging task. It predates this arrangement and still carries its own shell. | not mirrored |
| `dc2f05de339b410a972184a84b9f1c6f` | Adds the `ci-running` label when the parent workflow starts. | not mirrored: owned by the shared CI bot repository |
| `52d1699f53ca463ab77c4c4398be7e5a` | Publishes the result comment and the final label. | not mirrored: same owner |

The code check is a separately registered pipeline,
`2dce32a1e91949d4872f6d10a9d86b2e`, invoked as a sub-pipeline. Its four tasks
are configured and maintained outside this repository.

The three tasks above that are not mirrored are still called from here, so the
parameters they expect are this repository's half of the contract:

| task | parameters it is passed |
| --- | --- |
| `b6e9c483…` | the same run-shell set as the x64 task below, with its own `SH_FILE_PATH` and aarch64 `ARGS` |
| `dc2f05de…` | `number`, the merge request; `WEBHOOK_PAYLOAD` |
| `52d1699f…` | `number`; `result_html`, a short OBS key and never inline HTML; `final_label`, `ci-successful` or `ci-failed` |

## The x64 run-shell task

Its steps, in the order a run log shows them:

1. **Cache Check** — platform housekeeping. It reports `"docker rm" requires at
   least 1 argument` on a fresh node; that is normal and means nothing.
2. **代码检出** — the platform git plugin. It checks the merge request out at
   the workspace root, which our shell does not use: the shell clones again,
   under `.codearts-build/repository`, from the refs it is given. The step is
   redundant and costs about ten seconds; removing it is a console change
   nobody has made yet.
3. **The shell** — the text of
   [`codearts-runner-shell.reference.sh`](codearts-runner-shell.reference.sh),
   pasted verbatim. It checks out, hands over to
   `.ci/codearts-build-dispatch.sh`, records the script's exit status in
   `ARTIFACT_PATH/exit-code`, and reports success unless `STRICT_EXIT` is `1`.
4. **上传文件到 OBS** — uploads `ARTIFACT_PATH`. The action resolves that path
   under `.codearts-build/repository/`, which is the whole reason the shell
   works there and not at the workspace root.

**Image**: the task's image field is

```
swr.cn-north-4.myhuaweicloud.com/openjiuwen/${RUNNER_IMAGE}
```

so `RUNNER_IMAGE` is a bare `name:tag`, never a full address. The two images
are built from this directory by
`.ci/build-codearts-runner-image.sh --variant full|light`:

| `RUNNER_IMAGE` | recipe | what it carries |
| --- | --- | --- |
| `sciencediscovery-ci-runner:latest` (console default) | [`codearts-runner.Dockerfile`](codearts-runner.Dockerfile) | node, pnpm, uv, bubblewrap, OpenSSH, the QEMU emulator and the 3.1 GB guest image |
| `sciencediscovery-ci-light:latest` | [`codearts-light-runner.Dockerfile`](codearts-light-runner.Dockerfile) | git, python3, curl and a CA bundle |

*How to tell which one ran*: the shell prints `image : recipe=ci-runner-v2` or
`recipe=ci-light-v1` on its second line, and `node/pnpm : none / none` on the
light one.

### Custom parameters

Every one of these is declared on the task and passed by a job's `with:`. Where
the console default matters it is named; the shell supplies the rest of the
fallbacks, so an empty value is not a failure.

| name | what it selects | note |
| --- | --- | --- |
| `RUNNER_IMAGE` | the image, as `name:tag` | console default `sciencediscovery-ci-runner:latest`; only the auto merge overrides it |
| `GIT_REPO_URL` | repository to clone | always the public https URL |
| `GIT_REF` | the ref under test | `refs/merge-requests/<id>/head` for a layer, `refs/heads/main` for the auto merge |
| `GIT_TARGET_REF` | the ref it will merge into | equal to `GIT_REF` means no replay |
| `SH_FILE_PATH` | repository-relative script to run | the only thing that distinguishes one job from another |
| `ARGS` | script arguments, one per line | optional |
| `ENVS` | `NAME=VALUE` records, one per line | the dispatcher refuses names such as `PATH` or `BASH_ENV` |
| `ARTIFACT_PATH` | directory the OBS step uploads | shell default `.ci-results/publish` |
| `OBS_BUCKET`, `OBS_DIRECTORY`, `OBS_ENDPOINT` | where that upload lands | bucket `openjiuwen-ci` |
| `STRICT_EXIT` | `1` makes the task fail when the script did | console default is empty, which is the masking behaviour every layer relies on |

## Private parameters

`GITCODE_TOKEN`, on the auto-merge pipeline. It is the only value this CI needs
that exists nowhere in the repository: the console holds it, the pipeline
substitutes it into an `ENVS` record, and the build task hands it to
`.ci/codearts-auto-merge.sh`. Its account has to be allowed to merge and to
comment on merge requests, and to be an administrator for `force_merge`.

*How to tell it arrived*: the dispatcher prints `Environment records: 3`, and
the script's first GitCode call succeeds instead of printing
`FATAL: GITCODE_TOKEN is empty`.

## Which pipeline is registered against which branch

| pipeline | source branch | consequence |
| --- | --- | --- |
| the parent workflow | `main`, and a debug copy on `ci/verify-pr-ci` | a pipeline change can be rehearsed on the CI branch |
| the auto merge | `main` | it cannot be rehearsed: a change only takes effect once it is on `main` |

## Deliberately not mirrored here

Credentials of any kind, and the task scripts owned by the shared CI bot
repository. Those tasks are named above by id and purpose, which is all this
repository needs to know about them.
