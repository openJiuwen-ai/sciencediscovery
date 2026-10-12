# GitHub Actions

Read this reference for `.github/workflows/`, GitHub-hosted runner behavior,
GitHub run status, logs, or artifacts.

## Coverage and runner behavior

`.github/workflows/ci.yml` implements the cumulative profiles described in
[the CI skill](../SKILL.md#what-runs-where). Every PR runs L1 plus hermetic
UT/ST and the four mocked browser workers. Merge-group runs add basic real
API journeys and distribution checks; nightly and release add research.
`nightly.yml` and `release.yml` call the same workflow. Release currently takes
the same eligible cases and evaluation modes as daily; it needs credentials.

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

For a failed job, inspect its complete failed-step log, the event, and the
tested SHA. A queue run tests its merge-group candidate, which can differ from
the PR head. The E2E summary must account for planned, executed, passed,
skipped/blocked and failed cases; a green Playwright exit alone is not enough.
Use these artifacts when the log points into a generated report:

| Artifact | Use |
| --- | --- |
| `l1-results`, `ut-results`, `st-results` | Slice plan, preflight, summary and failure logs |
| `mocked-e2e-plan` | Parent frozen plan that generated the four-worker matrix |
| `mocked-e2e-results-<shard>` | Worker plan/results, browser reports and stack logs; inspect these even if aggregation failed |
| `e2e-results` | Combined mocked verdict and worker reports, assembled by `merge-gate` |
| `real-e2e-plan`, `real-e2e-collection-diagnostics` | Expected real identities, model/backend configuration and collection failures |
| `real-e2e-results-<shard>`, `real-e2e-evidence-<shard>` | Worker accounting/scores and complete real journey evidence |
| `real-e2e-results`, `real-e2e-verdict` | Combined scores and exact-accounting verdict from `real-report` |

Download into a task-owned directory and preserve the worker directory names
and report-relative paths. To reproduce mocked aggregation, with an output
directory already created:

```bash
gh run download <run-id> --repo <owner>/<repo> \
  --name mocked-e2e-plan --dir <output>/plan
gh run download <run-id> --repo <owner>/<repo> \
  --pattern 'mocked-e2e-results-*' --dir <output>/workers
node .ci/mocked-report.mjs <output>/plan/plan.json <output>/workers <output>/combined
```

`Account for real cases` is the display name of `real-report`, not another
test. It checks the real worker union against the parent plan. Mocked workers
are reconciled inside `merge-gate`, and again by `real-plan` before paid calls.
Do not treat results from different SHAs, backends or partial attempts as one
passing suite. Report the backend, case totals and supplemental check totals
separately.

The Coverage job runs no test. It `needs` UT and ST, downloads the
`ut-coverage` and `st-coverage` artifacts that `pnpm ci:ut -- --coverage` and
`pnpm ci:st -- --coverage` wrote during the gate's own runs, and merges them
with `node scripts/coverage-report.mjs` (`pnpm coverage:report`). Never make it
execute a test command or select a subset of directories to re-measure: a
second execution reports on a run that did not gate the change. Its summary
must show the merged Node.js and Python figures directly in the run page, then
each layer's own figures with its job result and planned/executed/passed
counts, and any Python process that could not be measured. Coverage is
informational: do not add a percentage threshold. When a layer passed, missing
coverage for a file it ran fails the merge step; when a layer failed, the job
summarises what was uploaded and that job's failure is the signal.

## Validate workflow changes

Keep workflow steps as orchestration around repository-owned `pnpm ci:*`
commands. Preserve `if: always()` on result uploads so a failing layer still
publishes evidence, and keep the test command's failure visible as the job
conclusion.

Run `pnpm ci:l1` and `pnpm ci:selftest` for policy/matrix/accounting changes,
then the affected slices. Scheduler changes need a complete execution of all
selected workers plus reconciliation; selection-only checks do not establish
that the stacks can run concurrently. Keep Playwright workers/retries and
case assertions intact. Report elapsed stage time separately from summed
runner time, and do not confuse either with provider billing.

Check the actual workflow `needs`: UT, ST and mocked planning follow L1;
mocked workers follow planning; real planning waits for UT, ST and mocked
workers. Coverage only consumes UT/ST coverage. Binary and Docker jobs follow
L1 on `merge`, `daily` and `release`, and are skipped on `pr`.

The workflow supports `workflow_dispatch`. For an authorized ref in the
target repository, state both profile and backend and inspect every job:

```bash
gh workflow run .github/workflows/ci.yml --repo <owner>/<repo> --ref <branch> \
  -f profile=pr -f backend=jiuwenswarm
gh run list --repo <owner>/<repo> --workflow CI --limit 5
```

`merge`, `daily` and `release` dispatches make paid calls and need access to
the configured Environment; a fork dispatch does not inherit upstream secrets.
A dispatch is not proof that queue events work: verify an actual
`merge_group` run and that the ruleset requires `merge-gate`. Environment
restrictions can block a job before any test starts; inspect that state before
calling it a failing test. Use the fork/PR procedure in
[create-github-pr](../../create-github-pr/SKILL.md); never push a task branch to
the upstream or the GitCode mirror just to obtain a run.
