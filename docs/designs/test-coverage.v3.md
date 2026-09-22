# Incremental and Nightly Node Coverage Design v3

Status: accepted for implementation

Supersedes [v2](test-coverage.v2.md). Version 3 keeps the product repository as
the owner of coverage execution, adds affected-workspace coverage beside the
PR gate, and changes the complete baseline from weekly to daily.

## Purpose

Give contributors fast coverage feedback for the code they changed while
retaining one comparable, authoritative whole-Node-scope baseline. Feed both
forms into a dedicated dashboard coverage page without presenting a mixed-SHA
estimate as a complete rerun.

## Requirements

- **COV3-1 — Native groups.** The Node coverage runner executes `.ci`,
  `scripts`, and each Node-test workspace from the same working directory its
  ordinary test command uses. It writes whole-run and per-group line, branch,
  and function summaries.
- **COV3-2 — Affected selection.** Pull requests and pushes to `main` map the
  Git diff to coverage groups. A changed workspace selects itself and its
  transitive Node-test dependents. Shared build or coverage infrastructure
  changes select the complete scope; documentation and browser-only changes
  may skip this Node-only job.
- **COV3-3 — PR signal.** Each pull request runs only its affected groups. Test
  failures fail the coverage check, while percentage changes remain
  informational until a separately reviewed threshold policy exists.
- **COV3-4 — Main increment.** A push to `main` publishes the affected group
  summaries. The dashboard may replace those groups in the latest complete
  baseline and label the result `incremental estimate`, including its baseline
  date and source SHAs.
- **COV3-5 — Daily authority.** A scheduled run at 03:30 Asia/Shanghai and a
  manual dispatch execute every Node group. Their aggregate is the
  authoritative baseline and resets incremental staleness.
- **COV3-6 — Explicit scope.** Percentages cover built Node workspace tests and
  repository CI-script tests. Browser/TSX, Python, and Playwright suites remain
  outside the totals and are never silently represented as zero coverage.
- **COV3-7 — Artifacts.** Summary artifacts are SHA-qualified and retained for
  90 days. They contain a schema-versioned root summary plus per-group
  summaries. LCOV detail is a separate SHA-qualified artifact retained for 30
  days, so dashboard history does not repeatedly download large trace files.
- **COV3-8 — Coverage page.** The status board has a dedicated Coverage tab
  with baseline/current identity, line trend, filterable group rows, and recent
  PR affected-group results. The homepage links to it and marks an incrementally
  composed value as an estimate.

## Acceptance criteria

1. Selector tests cover transitive dependents, shared-infrastructure full runs,
   CI/script groups, and browser/documentation skips.
2. Aggregation tests cover test-source exclusion, an LCOV final record without
   a trailing newline, and per-group metadata.
3. The workflow runs affected coverage for PR and `main` push events, a full
   run daily/manual, and uploads summary evidence even when tests fail.
4. Dashboard parser tests distinguish coverage summaries from UT/ST/E2E layer
   summaries and compose later main-group results over a full baseline.
5. The Coverage tab labels full and incremental values distinctly and shows
   group line, branch, and function percentages.

## Accuracy boundary

The daily run is the only authoritative complete aggregate. Between daily
runs, the dashboard estimate combines group summaries measured at different
main-branch SHAs. Transitive dependent selection reduces stale results but
does not make that mixed-SHA aggregate equivalent to a complete rerun. The UI
must retain this distinction.

## Version history

- **v3 (2026-09-22):** Add affected-group PR/main coverage, daily complete
  baseline, per-group summaries, split summary/LCOV artifacts, and a dedicated
  dashboard coverage page.
- **v2 (2026-09-21):** Introduce a weekly source-owned Node baseline.
- **v1 (2026-09-21):** Initial per-UT-job proposal.
