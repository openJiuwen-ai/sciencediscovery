# Node Test Coverage Design v2

Status: accepted for implementation

Supersedes [v1](test-coverage.v1.md). Version 2 moves publication out of the
per-PR CI workflow and into a source-owned weekly baseline, matching the
vLLM-Omni model in which the product repository runs coverage and the status
board only consumes its artifacts.

## Purpose

Produce a reproducible Node.js coverage baseline from the repository's existing
tests and expose it to the ScienceDiscovery GitHub status board. Coverage is
additional evidence; it does not replace the UT, ST, or E2E quality gates.

## Requirements

- **COV-1 — Stable entry point.** `pnpm coverage:node` prepares the gateway and
  paper test environments, builds the workspace, and runs the repository's
  built Node tests plus CI-script tests under Node's V8 coverage collector.
- **COV-2 — Isolated, bounded execution.** Test groups run from their native
  workspace directories, with at most four groups active by default. This
  preserves package-relative fixture and environment discovery while avoiding
  unrelated integration fixtures sharing ports or temporary resources.
  `COVERAGE_TEST_CONCURRENCY` may override the group limit with a positive
  integer on a dedicated runner.
- **COV-3 — Product-only totals.** The summarizer removes test and temporary
  sources, then writes `coverage/lcov.info`, `coverage/summary.json`, and
  `coverage/summary.md` with line, branch, and function totals.
- **COV-4 — Explicit scope.** The report covers built Node workspace and
  repository CI-script tests. Browser/TSX, Python, and Playwright suites remain
  outside the reported percentages.
- **COV-5 — Source-owned publication.** The ScienceDiscovery repository owns a
  dedicated GitHub Actions workflow. It runs every Monday against the default
  branch, supports manual dispatch, and runs once when coverage infrastructure
  changes on `main`. It is not a pull-request gate. The workflow preserves a
  failing coverage command as a failed run while still attempting to upload
  any report files produced.
- **COV-6 — Versioned artifact.** Each run uploads
  `node-coverage-<source-sha>` for 90 days. The artifact carries the three
  report files and remains separate from `ut-results`, `st-results`, and
  `e2e-results`.
- **COV-7 — Dashboard consumption.** The status board reads coverage artifacts
  from the tracked ScienceDiscovery repository, parses `lcov.info`, and
  displays line, branch, and function coverage. A coverage-only artifact must
  not appear as an incomplete test-execution layer.

## Acceptance criteria

1. LCOV aggregation tests verify exclusion of test sources and correct line,
   branch, and function totals.
2. `pnpm coverage:node` produces all three report files even when individual
   test commands fail, while returning a failing exit code for the run.
3. The dedicated workflow is weekly/manual, does not run on pull requests, and
   uploads an SHA-qualified artifact even after a failing coverage command when
   report files exist.
4. A synthetic `node-coverage-<sha>` ZIP is parsed by the board without being
   treated as a UT/ST/E2E result artifact.
5. The board prefers the latest default-branch coverage artifact over a newer
   pull-request artifact and defaults to the tracked repository as its coverage
   source.

## Version history

- **v2 (2026-09-21):** Move coverage to a dedicated weekly source-repository
  workflow, retain manual execution, use SHA-qualified 90-day artifacts, and
  make the board a pure consumer.
- **v1 (2026-09-21):** Initial proposal generated coverage after every
  successful GitHub UT job and retained a fixed-name artifact for 14 days.
