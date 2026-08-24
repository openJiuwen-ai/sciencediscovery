---
name: ci
description: >
  Run the UT/ST/E2E layers locally before opening a merge request, and read a
  CI result on GitHub Actions, GitCode or CodeArts. Use when a pipeline fails,
  when changing a workflow file, when asking which platform covers which tests,
  or when a job needs the bubblewrap sandbox.
---

# CI layers and the three pipelines

Project-local skill for **ScienceDiscovery**.

**Read [CONTRIBUTING.md](../../../CONTRIBUTING.md) first.** It owns the parts a
contributor needs: the layer entry points and their `CI_RESULTS_DIR` /
`CI_RUNTIME_DIR` overrides, which pipeline covers which layer, the GitCode and
GitHub repository split, and the rule that all three layers run locally before a
merge request opens. `.ci/README.md` documents the toolchain image.

This skill covers what CONTRIBUTING deliberately leaves out: diagnosing a
pipeline, reaching results and logs through each platform's API, and validating
a workflow change before merging it.

## Rules

1. **Never weaken a sandbox assertion to make a pipeline green.** Tests that
   assert isolation or the sandbox's `/workspace` view must run where a sandbox
   exists. Moving them to a stand-in deletes what they verify.
2. **Call the `pnpm ci:*` entry points, never the underlying commands.** A
   pipeline that inlines `pnpm test` becomes a second, platform-specific test
   definition that drifts from the repository's.
3. **Validate a GitCode workflow change by dispatching it against a branch**
   before merging (see *Test a workflow change*). The dispatch endpoint
   validates the YAML and names the offending key.
4. Read a failing job's log before theorising. Every platform here exposes one.

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

### CodeArts

`.codearts/workflow/codearts-pipeline.yml` is validated by CodeArts, not by
GitCode Actions, and it has no `run:` key. A step is `name` + `uses` + `with`;
a shell step is:

```yaml
- name: Report the runner
  uses: official_shell_plugin
  with:
    OFFICIAL_SHELL_SCRIPT_INPUT: |
      uname -srm
```

Writing `run:` is rewritten server-side into a plugin called `official_shell`,
which does not exist, and the pipeline fails validation before any job starts.
The user manual lists official plugins by display name only; the `uses:`
identifiers come from the platform's own YAML view or from a run's `task`
field. Keep the `stages.<id>` key verbatim — it is the record on the server.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| Job fails in ~1s, log is one line `FAILED`, `start_time` null | No job was created. Either the runner label matched nothing (arm64), or the run was never expanded into jobs. |
| `bwrap: No permissions to create new namespace` | The host forbids user namespaces. Use `ci:ut:core`; `ci:ut:runner` and `ci:e2e` cannot run. |
| API test expects `runner_exec`, gets `undefined` | An execution never ran. Almost always a missing sandbox. |
| `BLOCKED: isolated E2E stack did not become healthy` | The Runner refused to serve; check the sandbox before reading `stack.log`. |
| `插件official_shell不存在[行N，列M]` on a CodeArts pipeline | A step at that line uses `run:`. CodeArts has no `run:`; use `uses: official_shell_plugin` with `with.OFFICIAL_SHELL_SCRIPT_INPUT`. |
| `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` is behind a `package.json`. Regenerate with `pnpm install --lockfile-only`. |
| Playwright reports success with fewer tests than expected | A skip is not a pass. Check the counts and the not-passed titles; a BLOCKED precondition reports as skipped. |
