# Node and Python Coverage Dashboard Design v4

Status: accepted for implementation

This version extends the deliberately small v3 design with Python coverage.
It keeps coverage in the existing CI and Nightly workflows, preserves each
service's current test framework, and publishes separate Node.js and Python
summaries so neither percentage is mistaken for whole-repository coverage.

## Requirements

- **COV4-1 — Existing tests and standard collectors.** Run the existing built
  Node tests with Node's V8 coverage collector. Run the existing Python tests
  with `coverage.py` branch coverage, retaining `unittest` for gateway/paper
  and `pytest` for memory-graph/evolve. Do not add another test tier or a
  custom coverage engine.
- **COV4-2 — Affected PR/main scope.** Pull requests and default-branch pushes
  select changed Node-test workspaces plus their transitive dependents, and
  changed Python services. Shared coverage infrastructure selects every group
  for the affected language. Partial results must identify their selected
  groups and must not be presented as a complete baseline.
- **COV4-3 — Existing workflows.** Coverage remains a job in `ci.yml`. Direct
  PR/default-branch runs publish affected-group results; the existing 02:00
  Asia/Shanghai Nightly call publishes complete Node.js and Python baselines.
  Release calls skip coverage.
- **COV4-4 — Separate minimal artifacts.** Publish one SHA-qualified JSON
  artifact per language, each containing aggregate and per-group summaries.
  Use the repository's default artifact retention. Raw V8 LCOV and
  `coverage.py` data/JSON remain local intermediates and are not uploaded.
- **COV4-5 — Dashboard semantics.** Display Node.js and Python as separate
  first-class metrics. If a combined line percentage is shown, calculate it
  from summed covered and total lines, never by averaging percentages. A value
  composed from later main-group summaries must be labelled as an estimate.
- **COV4-6 — Explicit scope.** Node.js covers built workspace and CI-script
  tests. Python covers the maintained gateway, paper, memory-graph, and evolve
  services. Browser/TSX and Playwright tests remain outside these percentages.
- **COV4-7 — Test semantics, not a threshold gate.** Existing test failures
  still fail the coverage job. Coverage percentages are informational until a
  separate threshold policy is reviewed and accepted.

## Acceptance criteria

1. Node selector tests continue to cover dependents, shared-infrastructure full
   runs, and irrelevant-path skips.
2. Python selector tests cover each maintained service, shared-infrastructure
   full runs, multi-service changes, and irrelevant-path skips.
3. Python summary tests exclude test files, retain covered/total line and
   branch counts, and aggregate groups by summing counts.
4. `ci.yml` publishes affected Node.js and/or Python summaries for PR/main and
   complete summaries for Nightly without adding another workflow.
5. The four existing Python service suites run through `coverage.py` with the
   same pass/fail semantics as their current `unittest` or `pytest` commands.
6. The dashboard consumes the separate language artifacts and never labels a
   partial result as whole-repository coverage.

## Accuracy boundary

Only Nightly produces complete language baselines. A PR or default-branch run
can contain only affected groups. Node.js and Python results are kept separate;
any optional combined line value is a weighted count-based calculation and is
not evidence for browser/TSX or Playwright coverage.

## Version history

- **v4 (2026-09-22):** Add Python coverage with `coverage.py`, per-service PR
  selection, separate language artifacts, and count-based combined semantics.
- **v3 (2026-09-22):** Node-only minimal implementation. Preserved in
  `docs/designs/test-coverage.v3.md`.
