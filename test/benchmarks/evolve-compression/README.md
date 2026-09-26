# PUCT compression tutorial: real E2E

`test/evolve-compression-real.spec.ts` reads the task directly from the Chinese
[tutorial](../../../docs/zh/domains/evolve-a-solution.md), selects PUCT in the
browser and runs real model-generated code in the sandbox. Checkpoint replies
use the tutorial's documented “you decide” path; no seed, evaluator or search
result is scripted.

Completion requires a completed main run, a normally finished PUCT search and
readable persisted code matching the selected candidate hash. A seed that stays
best is a valid result. Completion does not require a particular score, an
improvement, a specific number of candidates, filenames or exactly two versions.
A main response that only announces startup does not finish the test: it waits
for the background search.

`quality-scorecard.json` reports the search's `bestTestScore`, the baseline and
best gate scores separately, and the frozen evaluator definition. Scores are
never converted into compression percentages or compared across different
scoring definitions. A missing test score is `unavailable` with a note; it is not
zero and gate score is not substituted. No extra LLM judge or minimum score is
used. Session/child trajectories, search events, result code, version identity
and screenshots are retained in the Playwright output.

Run against an isolated Linux Swarm stack with working bubblewrap, scientific
Python and the evolution sidecar. Set `E2E_API_TOKEN`, `E2E_REAL=1`, and either
`E2E_LLM_MODEL_ID` or `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_LLM_TOKEN`. Select
platform task dispatch on the server. The default total work budget is two hours
(`E2E_EVOLVE_RUN_TIMEOUT_MS=7200000`). Use `E2E_KEEP_RESEARCH_RECORDS=1` to retain
the server session after the run.

```bash
node test/sync-e2e.mjs --write
npm --prefix .e2e ci
E2E_REAL=1 pnpm --dir .e2e exec playwright test \
  --config=playwright.config.ts --project=real evolve-compression-real.spec.ts
```

The `model:real` case is collected by the shared daily `e2e-real` policy and is
excluded from the mocked PR gate. Missing credentials are a preflight failure,
not a reason to remove it from the catalog. Score extraction regressions run as
ordinary UT through `scripts/evolve-scorecard.test.mjs`.
