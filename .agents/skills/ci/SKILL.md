---
name: ci
description: >
  Run the UT/ST/E2E layers locally before opening a merge request, and read a
  CI result on GitHub Actions, GitCode or CodeArts. Use when a pipeline fails,
  when changing a workflow file, when asking which platform covers which tests,
  or when a job needs the bubblewrap sandbox.
---

# CI layers and the three pipelines

Project-local skill for **ScienceDiscovery**. The layer entry points are the
contract; `.ci/README.md` documents the toolchain image behind them.

## Rules

1. **Run the layers locally before opening a merge request.** No pipeline runs
   the full set, so a green CI does not mean the change is covered.
2. **Never weaken a sandbox assertion to make a pipeline green.** Tests that
   assert isolation or the sandbox's `/workspace` view must run where a sandbox
   exists. Moving them to a stand-in deletes what they verify.
3. **Call the `pnpm ci:*` entry points, never the underlying commands.** A
   pipeline that inlines `pnpm test` becomes a second, platform-specific test
   definition that drifts from the repository's.
4. **Validate a GitCode workflow change by dispatching it against a branch**
   before merging (see *Test a workflow change*). The dispatch endpoint
   validates the YAML and names the offending key.
5. Read a failing job's log before theorising. Every platform here exposes one.

## The three pipelines

| File | Platform | Jobs | Sandbox |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | GitHub Actions | `ut`, `st`, `e2e`, `binary` (x86_64 + aarch64) | yes |
| `.gitcode/workflows/ci.yml` | GitCode Actions | `ut` (core), `st`, `binary` (x86_64) | **no** |
| `.codearts/workflow/codearts-pipeline.yml` | CodeArts (PaC) | merge-request smoke test | no |

GitHub is the only platform with full coverage. What GitCode omits, and why, is
in *Why GitCode cannot sandbox*.

A **fourth** pipeline exists and is not in this repository: the one whose result
table `openJiuwen-bot` posts on every merge request —
静态检查 / 禁用词扫描 / 防投毒检查 / 开源合规检查 / UT测试 / build. It is configured
in the CodeArts console and each step delegates to a CodeArts Build task by
`jobId`, so its behaviour cannot be changed from this repository. Do not
confuse its `UT测试` with the `ut` job in `.gitcode/workflows/ci.yml`.

## Run the layers

```bash
pnpm ci:ut     # architecture check, typecheck, paper/gateway, build, binary, all package tests
pnpm ci:st     # build, then the hermetic agent-loop smoke (no credentials, no sandbox)
pnpm ci:e2e    # starts an isolated stack and runs the @mocked journeys
```

Both default to paths that exist only inside the `.ci` image, so outside it
point them somewhere writable. Keep the runtime directory **outside the
checkout**, or the Runner sandbox mounts over it:

```bash
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=~/ci-runtime pnpm ci:st
```

Split layers, for when the host has no working sandbox:

```bash
pnpm ci:ut:core     # ci:ut minus @sciencediscovery/runner — needs no sandbox
pnpm ci:ut:runner   # only that package — needs real bubblewrap
```

The live layers (`ci:st:real`, `ci:e2e:real`, `ci:st:npu`, `ci:e2e:legacy`)
need credentials or hardware and fail closed behind their `CI_ALLOW_*` gates.

## Before opening a merge request

Run these three. They take longer than CI does, and they cover what CI cannot:

```bash
pnpm ci:ut     # NOT ci:ut:core — the runner package tests only run here and on GitHub
pnpm ci:st
pnpm ci:e2e
```

`pnpm ci:ut` requires a working sandbox. Check first:

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok
```

If that fails, the host cannot run `ci:ut:runner` or `ci:e2e` at all. On Ubuntu
24.04 the usual cause is the AppArmor restriction on unprivileged user
namespaces:

```bash
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

Inside a container it is normally unfixable — see below.

To reproduce a pipeline exactly, use the toolchain image. Mount the checkout at
`/src`, never `/workspace`: the Runner's sandbox mounts over that path and five
Runner tests fail in ways that look like product defects. `.ci/README.md` has
the per-layer commands.

## Why GitCode cannot sandbox

GitCode's hosted runner is a Docker container, and its capability bounding set
drops `CAP_SYS_ADMIN`:

```
/.dockerenv present, pid1 tini, Ubuntu 24.04, job user uid 20001
CapBnd: 00000000a80425fb   → no CAP_SYS_ADMIN      Seccomp: 2 (filter active)
unshare -Ur / unshare -m   → Operation not permitted, as root too
```

bubblewrap installs from apt and then cannot create a namespace. Because the
capability is missing from the *bounding* set, nothing inside the container can
regain it. This is identical on every flavor (`slim` … `xlarge`), is unchanged
by a custom `container:` image, and `options: --privileged` is accepted and
silently ignored. There is also no arm64 runner: a job requesting
`[ubuntu-latest, arm64, medium]` is created, records `arch=arm64`, then fails
to schedule with `HTTP404错误` and an empty log.

Consequences, all encoded in `.gitcode/workflows/ci.yml`:

- `ut` runs `ci:ut:core`; the `@sciencediscovery/runner` tests run on GitHub.
- There is no `e2e` job — the Runner refuses to serve without a usable sandbox,
  so the stack never becomes healthy.
- `binary` passes `--skip-smoke` and builds x86_64 only.

The runner ships `git curl wget sudo apt-get python3 tar xz` and **no**
`node npm corepack bwrap`. `.ci/provision-runner.sh` installs Node, pnpm and uv
with ordered fallbacks and prints what it found before installing.

## Read a CI result

### GitHub Actions

```bash
gh run list --repo <owner>/<repo> --limit 5
gh run view <run-id> --repo <owner>/<repo> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
gh run view <run-id> --repo <owner>/<repo> --log-failed
```

### GitCode

Use **`api.gitcode.com`**, not `gitcode.com` — the host in the docs 404s. The
token stored by the `gitcode` CLI works as a bearer token.

```bash
TOKEN=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.config/gc/auth.json')));print(d['hosts']['gitcode.com']['users'][d['hosts']['gitcode.com']['active_user']]['token'])")
B=https://api.gitcode.com/api/v8/repos/<owner>/<repo>/actions

curl -sS -H "Authorization: Bearer $TOKEN" "$B/workflows"              # is the workflow registered?
curl -sS -H "Authorization: Bearer $TOKEN" "$B/runs?status=FAILED"     # list runs
curl -sS -H "Authorization: Bearer $TOKEN" "$B/runs/<run-id>"          # run detail, per-job status
curl -sS -H "Authorization: Bearer $TOKEN" "$B/runs/<run-id>/jobs"     # job ids
curl -sSL -H "Authorization: Bearer $TOKEN" \
  "$B/runs/<run-id>/jobs/<job-id>/download_log" -o log.zip             # ZIP of per-step .log files
```

Four traps:

- **`status` and `event` values are upper case**: `FAILED`, `COMPLETED`,
  `RUNNING`, `PUSH`, `Manual`. A lower-case `event` filter silently returns 0.
- **`/runs` without a `status` filter** returns
  `PARAMETER_ERROR … codeArtsIds`. Always pass one.
- **The listing is incomplete** — it does not return every run the web UI
  shows. Treat a missing run as "not indexed", not "does not exist"; the web
  流水线 tab is authoritative.
- **`download_log` is a ZIP**, and the path uses an underscore. `download-log`
  with a hyphen is not a route.

### The bot table on a merge request

`gitcode pr view <n> -R <owner>/<repo> --comments --json` returns the comment
whose HTML table lists the console pipeline's steps. That is the fourth
pipeline, not this repository's workflow.

## Test a workflow change

Registration reads from the **default branch**, so a new workflow file on a
feature branch is invisible until it merges. But dispatch resolves the `ref`,
so a change can be validated and executed on a branch:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ref":"<branch>"}' "$B/workflows/<workflow-id>/dispatches"
```

A `201` with a `workflow_run_id` means the YAML validated. A `400` returns
diagnostics naming the offending key. Two rules the validator enforces that a
GitHub workflow does not:

- **Every step needs a `name`.** A bare `- uses:` step is rejected.
- **The checkout plugin is `checkout`**, not `checkout-action@0.0.1`. The
  validator reports only the *first* missing plugin, so fix and re-run.

The checkout lands in the working directory, and `run:` steps execute under
`bash -e` — a bare failing command aborts the step.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| Job fails in ~1s, log is one line `FAILED`, `start_time` null | No job was created. Either the runner label matched nothing (arm64), or the run was never expanded into jobs. |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. Use `ci:ut:core`; `ci:ut:runner` and `ci:e2e` cannot run. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran. Almost always a missing sandbox. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; check the sandbox before reading `stack.log`. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`. Regenerate with `pnpm install --lockfile-only`. |
| Playwright reports success with fewer tests than expected | A skip is not a pass. Check the counts and the not-passed titles; a BLOCKED precondition reports as skipped. |
