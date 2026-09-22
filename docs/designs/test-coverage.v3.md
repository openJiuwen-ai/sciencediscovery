# Node Coverage Dashboard Design v3

Status: accepted for implementation

This version records the final, deliberately small scope agreed after the
earlier designs: reuse the existing CI/nightly workflows, publish only the JSON
needed by the status board, and avoid a second coverage workflow or retention
policy.

## Requirements

- **COV3-1 — Existing tests.** Run the repository's existing built Node tests
  under Node's V8 coverage collector. Do not add another test tier.
- **COV3-2 — Affected PR/main scope.** Pull requests and pushes to the default
  branch select changed Node-test workspaces and their transitive dependents.
  Shared coverage infrastructure selects every group.
- **COV3-3 — Existing workflows.** Coverage is a job in `ci.yml`. Direct
  PR/default-branch runs publish affected-group results; the existing 02:00
  Asia/Shanghai Nightly call publishes the complete baseline. Release calls
  skip coverage.
- **COV3-4 — Minimal artifact.** Upload one SHA-qualified artifact containing
  the aggregate and per-group JSON summaries. Use the repository's default
  artifact retention. LCOV remains a local intermediate and is not uploaded.
- **COV3-5 — Dashboard.** Add one Coverage tab that shows the latest whole
  baseline, per-path line/branch/function totals, nightly history, and recent
  PR results. A homepage value composed from later main-group summaries must
  be labelled as an estimate.
- **COV3-6 — Explicit scope.** The percentage covers built Node workspace and
  CI-script tests; browser/TSX, Python, and Playwright tests are excluded.

## Acceptance criteria

1. Selector tests cover dependents, shared-infrastructure full runs, and
   irrelevant-path skips.
2. Aggregation tests exclude test sources and preserve group metadata.
3. `ci.yml` publishes affected summaries for PR/main and a complete summary
   when called by Nightly, without a separate coverage workflow.
4. Dashboard tests distinguish coverage summaries from UT/ST/E2E artifacts
   and compose later main-group results over the latest complete baseline.

## Accuracy boundary

Only the nightly result is a complete aggregate. Between nightly runs, the
homepage estimate combines group summaries measured at different main-branch
SHAs and must remain labelled as an estimate.

## Version history

- **v3 (2026-09-22):** Final minimal scope: existing CI/nightly workflows,
  affected groups, one JSON artifact, and one dashboard tab. Earlier v1/v2
  drafts remain retrievable from branch history.
