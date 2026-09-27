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
zero and gate score is not substituted. No minimum score is required. Session/child trajectories, search events, result code, version identity
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

## Optional supplementary LLM audit

Set `E2E_PUCT_LLM_EVALUATION=1` to additionally review the delivered code and
retained search evidence. Configure `PUCT_JUDGE_MODEL`, `PUCT_JUDGE_BASE_URL` and
`PUCT_JUDGE_API_KEY` (fallbacks: `RACE_MODEL`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`).
`PUCT_JUDGE_PYTHON` optionally selects the Python interpreter.

This local, non-official audit writes `llm-scorecard.json` separately from the
native held-out performance score. It weights correctness 40%, constraints 20%,
evidence 25% and reusability 15%, rating each dimension 0–4. It does not execute
code, replace measured algorithm performance or change delivery success.

Each request allows 65,536 output tokens and 900 seconds. Transient errors,
truncation and invalid scores receive at most three retries with identical
inputs. The first valid score is accepted; no best-score selection occurs.
Permanent HTTP errors (including insufficient balance) stop immediately.
`E2E_PUCT_EVAL_TIMEOUT_MS` defaults to 3,900,000 (65 minutes), separate from the
Agent run budget. Enable this audit only with a model supporting this output
budget; it adds model calls. `llm-scorecard.attempts/` retains requests without
credentials, returned responses and attempt status/usage/timing. A rerun must
use a new output path to preserve prior evidence.
