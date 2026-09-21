# Node Test Coverage Design v1

Status: superseded by [v2](test-coverage.v2.md)

## Purpose

Produce a reproducible Node.js coverage baseline from the repository's existing
tests and expose it to the ScienceDiscovery GitHub status board. Coverage is
additional evidence; it does not replace the UT, ST, or E2E quality gates.

## Requirements

- **COV-1 — Stable entry point.** `pnpm coverage:node` prepares the gateway and
  paper test environments, builds the workspace, and runs the repository's
  built Node tests plus CI-script tests under Node's V8 coverage collector.
- **COV-2 — Bounded execution.** Tests run with a default concurrency of four;
  `COVERAGE_TEST_CONCURRENCY` may override it with a positive integer on a
  dedicated runner.
- **COV-3 — Product-only totals.** The summarizer removes test and temporary
  sources, then writes `coverage/lcov.info`, `coverage/summary.json`, and
  `coverage/summary.md` with line, branch, and function totals.
- **COV-4 — Explicit scope.** The report covers built Node workspace and
  repository CI-script tests. Browser/TSX, Python, and Playwright suites remain
  outside the reported percentages.
- **COV-5 — CI publication.** After UT succeeds, GitHub Actions generates the
  report in a non-blocking step and uploads it as the `node-coverage` artifact
  for 14 days. Coverage collection keeps its own failing exit code for
  diagnostics, while failure to produce report files is visible as an artifact
  warning and never changes the meaning of the UT result.
- **COV-6 — Dashboard consumption.** The status board auto-discovers a recent
  default-branch artifact whose name contains `coverage`, `lcov`, or `codecov`,
  parses `lcov.info`, and displays line, branch, and function coverage. A
  coverage-only artifact must not appear as an incomplete test-execution layer.

## Acceptance criteria

1. LCOV aggregation tests verify exclusion of test sources and correct line,
   branch, and function totals.
2. `pnpm coverage:node` produces all three report files even when individual
   test commands fail, while returning a failing exit code for the run.
3. A synthetic `node-coverage` ZIP is parsed by the board without being treated
   as a UT/ST/E2E result artifact.
4. The board prefers the latest default-branch coverage artifact over a newer
   pull-request artifact.

## Version history

- **v1 (2026-09-21):** Initial Node coverage command, GitHub Actions artifact,
  and status-board integration contract.
