# GitHub Actions

Read this reference for `.github/workflows/`, GitHub-hosted runner behavior,
GitHub run status, logs, or artifacts.

## Coverage and runner behavior

`.github/workflows/ci.yml` runs full `ci:ut`, hermetic `ci:st`, mocked `ci:e2e`,
and native smoke-gated release builds on x86_64 and aarch64. It is the only
hosted pipeline in this project that covers Runner UT and E2E.

UT, E2E, and binary smoke install bubblewrap and clear Ubuntu 24.04's AppArmor
restriction on unprivileged user namespaces before probing the sandbox. If the
probe fails, diagnose the host policy; do not replace the sandbox or remove the
tests.

GitHub is `openJiuwen-ai/sciencediscovery`, where changes are proposed; it
syncs periodically to the GitCode repository. That direction is the reverse of
what it was, so older runs, merge requests and stale documentation describe
GitCode as the source. The two repositories have different histories and SHAs
either way. Always name the host when reporting a commit and compare trees
rather than assuming matching commit IDs.

## Read a result

Use `gh`; retry authentication once, then ask the user to repair it if it still
fails.

```bash
gh run list --repo <owner>/<repo> --limit 5
gh run view <run-id> --repo <owner>/<repo> \
  --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
gh run view <run-id> --repo <owner>/<repo> --log-failed
```

For a failed job, inspect its complete failed-step log and then download the
corresponding `ut-results`, `st-results`, or `e2e-results` artifact when the log
points into a generated report. The E2E job summary must include executed,
skipped/blocked, failed, and flaky counts; a green conclusion alone is not
enough.

The Coverage job summary must show the Node.js and Python results directly in
the run page, label each result as full, incremental, skipped, or unavailable,
and identify the selected groups when the scan is partial. Coverage is
informational: do not add a percentage threshold. A coverage test failure must
still fail the job even when a partial summary can be rendered.

## Validate workflow changes

Keep workflow steps as orchestration around repository-owned `pnpm ci:*`
commands. Preserve `if: always()` on result uploads so a failing layer still
publishes evidence, and keep the test command's failure visible as the job
conclusion.

The workflow supports `workflow_dispatch`. When the branch exists in the
GitHub repository, dispatch it from that ref and inspect every job rather than
only the aggregate conclusion:

```bash
gh workflow run .github/workflows/ci.yml --repo <owner>/<repo> --ref <branch>
gh run list --repo <owner>/<repo> --workflow CI --limit 5
```

Do not push a GitCode-only branch to the GitHub mirror merely to obtain a run
unless the user has authorized that separate-repository mutation.
