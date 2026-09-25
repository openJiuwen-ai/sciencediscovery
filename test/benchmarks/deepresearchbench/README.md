# DeepResearchBench evaluation records

The real browser case is `test/deepresearchbench-swarm.spec.ts`. By default it does not
limit delegation count, sources per task or search depth. The Agent chooses
its research strategy. Existing runtime limits still apply; removing test
constraints does not disable production safety/resource budgets.

This work produces evaluation and performance records only. The version-wide
dashboard, storage ingestion, scheduled aggregation and UI are owned by a
separate workstream. That implementation can consume the records below.

The DRB-59 user tutorial is available in [English](../../../docs/en/domains/literature-research.md) and [中文](../../../docs/zh/domains/literature-research.md). Its task block matches the default unconstrained `researchPrompt`; historical report examples are not part of the Agent input.

## Setup and execution

The original five workload-stratified questions are preserved in `samples.ts`:

| ID | Local difficulty | Topic |
| --- | --- | --- |
| 59 | easy | Bird migration navigation |
| 64 | medium | UAV PID control |
| 58 | medium-hard | Horizontal gene transfer in plants and animals |
| 62 | hard | Scaling trapped-ion quantum computers |
| 75 | very-hard | Metal-ion interventions and cardiovascular disease |

These are local workload labels, **not official benchmark difficulty ratings**.
Original questions are unchanged; the shared prompt adds scientific-report and
platform Artifact delivery instructions. This is a platform integration study,
not an unmodified leaderboard submission. All five run by default. Set
Playwright `--grep 'DRB-(59|64) '` to select a local subset. CI selection is
frozen from source tags and never changes with case-ID environment variables.
Run serially on memory-constrained machines. For cold-start comparisons restart
the isolated Swarm stack between cases and retain each case's service logs;
shared MCP state can otherwise make results order-dependent.

For an explicitly cost-conscious experiment, set `E2E_DRB_MAX_SUBAGENTS=2`.
The prompt then limits total child creation (including failed/cancelled children),
not merely concurrent children. The completed-run assertions check that limit;
this is not a runtime admission cap or a monetary guarantee. Metrics retain the
limit and exact prompt, and results should be compared only with matching profiles.
Set runtime `maxConcurrentSubagents=2` separately to bound active children.
The team signoff case still requires all six expert roles; its optional
`E2E_TEAM_CONCURRENCY_HINT=2` adds a concurrency reminder, not a total-child cap.
Generation/timeout failures remain failures; no delivery assertions are relaxed.

Clone `https://github.com/Ayanami0730/deep_research_bench` outside this repository
and check out revision `852f4022d1f98fb707222e395405136e8f0e8d52`. The runner
rejects another revision or tracked edits to upstream evaluation code/data.
Install upstream requirements into a dedicated Python environment.

Configure:

```bash
export DRB_UPSTREAM_DIR=/absolute/path/to/deep_research_bench
export DRB_PYTHON=/absolute/path/to/evaluator-venv/bin/python
export LLM_BACKEND=openai
export OPENAI_BASE_URL=https://your-judge-endpoint/v1
export OPENAI_API_KEY='your-judge-key'
export RACE_MODEL='your-race-judge'
export CLEAN_MODEL='your-cleaner'
export FACT_MODEL='your-fact-judge'
export JINA_API_KEY='your-jina-key'
export E2E_DRB_EVALUATION=full
```

Alternatively, use the upstream `openrouter` backend and its
`OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` settings. Judge credentials are
independent of the generator's credentials. Do not commit credentials.

Use the existing isolated Swarm E2E stack/auth and generator settings documented
in `../../../jiuwen_swarm/README.md` (from the repository root, see
`jiuwen_swarm/README.md`). Then run from the repository root:

```bash
E2E_RESEARCH=1 E2E_SWARM_TASK=1 npm --prefix .e2e run test:real -- deepresearchbench-swarm.spec.ts
```

These real cases are excluded from default test collection unless
`E2E_RESEARCH=1`. The `swarm-research-mocked.spec.ts` journey remains in the
default mocked PR gate. Do not enable the real research switch in PR gates;
use an explicit local/manual benchmark run. Real evaluation additionally needs
the real project and configured generator/Judge credentials.

The default run budget is one hour (`E2E_DRB_RUN_TIMEOUT_MS=3600000`).
DRB-58 defaults to 90 minutes; DRB-59 and DRB-64 default to 120 minutes.
Their case-specific overrides (`E2E_DRB_58_RUN_TIMEOUT_MS`,
`E2E_DRB_59_RUN_TIMEOUT_MS`, `E2E_DRB_64_RUN_TIMEOUT_MS`) take precedence over
the suite-wide budget. The separate evaluation budget is one hour
(`E2E_DRB_EVAL_TIMEOUT_MS`). These
are harness deadlines, not injected research-count instructions. Judge mode
`full` is the default and requests RACE and FACT. Missing Judge credentials
record an evaluation error without preventing the research run or failing delivery.
Explicit modes `race` and `off` produce **partial** and **disabled** evaluation
records. Neither means a full quality assessment succeeded.

## Assertions and score semantics

E2E success requires a completed main run whose final response references at least
one readable, nonempty persisted artifact. Names and directories are unrestricted.
A failed or cancelled run with outputs is a partial delivery. Research activity,
child counts, word counts, headings, URL counts and quality scores do not gate
completion. Scoring uses the immutable report version selected by final delivery;
an ambiguous report is recorded as insufficient evidence.

Existing evaluator thresholds (`E2E_DRB_MIN_RACE`, `E2E_DRB_MIN_FACT`,
`E2E_DRB_MIN_COVERAGE`) remain descriptive local evaluator metadata, not official
benchmark pass marks or Playwright assertions. Interpret the raw scores and
verification coverage separately from the delivery outcome.

RACE uses the upstream cleaner, original question, task criteria, reference and
weighted formula. All criterion scores must be present and finite. The stored
`overall_score` and dimension scores are fractions (0–1); multiply by 100 for
display. **50 means parity with the reference**, not 50% factual accuracy.

FACT uses upstream extraction, deduplication, and support-judgment prompts.
Jina fetching uses upstream request/content format with bounded HTTP timeouts.
Failed source retrievals are unknown, not successful citations. Upstream
accuracy excludes unknowns; therefore verification coverage is also recorded
to reveal an inflated score from a tiny verified subset. Effective
citations count supported claim/source pairs, not distinct papers. No citations
or entirely inaccessible sources must not be interpreted as verified research.

Changing Judge models, using the generator as its own Judge, constraining
generation, or changing the evaluator revision prevents direct leaderboard
comparison. A single-case score is not a full-benchmark result.

## Record contract for the future dashboard

Each Playwright attempt retains these files under its output directory. Archive
the entire attempt directory before the next run: Playwright may clean its
output directory. CI should upload artifacts even when tests fail.

| File | Consumer-facing information |
| --- | --- |
| `benchmark-metrics.json` | `schema_version`, case/run/model identifiers, timestamps, exact generation prompt, run/evaluation budgets, integration status, generation duration and raw session usage, child statuses, embedded evaluation result |
| `deepresearchbench-<id>.json` | Original benchmark question and exact persisted report, usable for independent reevaluation |
| `child-trajectories.json` | Persisted child execution records, including recovered tool failures |
| `evaluation/scorecard.json` | Overall evaluation status, mode, thresholds, RACE/FACT results, Judge models/backend, upstream revision, report/reference hashes, evaluation duration and per-call Judge usage |
| `evaluation/criteria.json`, `reference.json`, `cleaned.json` | Reproducible scoring inputs |
| `evaluation/judge-input-*.json`, `judge-output-*.json` | Actual Judge prompts/responses and usage; may contain sensitive research content |
| `evaluation/extracted.jsonl`, `deduplicated.jsonl`, `validated.json` | FACT claims, source content, support verdicts and retrieval/validation errors |
| `evaluation/evaluator.log` | Evaluator diagnostics |

`evaluation.status` distinguishes `passed`, `failed`, `partial`, `disabled`,
`not_run`, `running`, and `error`. Missing scores are absent/null, never zero.
On an evaluator timeout, `benchmark-metrics.json` marks evaluation as `error`;
the last on-disk scorecard may still say `running`. Treat the enclosing attempt
record as authoritative for completion. An absent metric file indicates an
incomplete attempt, never a successful run.

Preserve failed attempts and distinguish integration success from evaluation
success. Do not silently aggregate different Judges, evaluator revisions,
thresholds or generation prompts. Store raw usage: providers differ in their
reasoning/cache-token accounting. Research token usage and Judge usage are
separate cost streams. This PR intentionally supplies **no dashboard**.

`generation_usage` is the raw platform session accounting response. Do not label
it total benchmark token cost unless it demonstrably includes every parent and
child model call. Missing usage is unknown, not zero. Integration passes do not
establish citation correctness or scientific completeness when judging is off.

## Offline tests

```bash
node --experimental-strip-types --test test/benchmarks/deepresearchbench/samples.test.ts
DRB_UPSTREAM_DIR=/absolute/path/to/deep_research_bench \
  /absolute/path/to/evaluator-venv/bin/python -m unittest discover \
  -s test/benchmarks/deepresearchbench -p 'test_*.py'
```

The upstream pipeline test exercises the real cleaner, scorer, extractor,
deduplicator and validator with mocked HTTP responses. It makes no paid calls.
Without the pinned upstream checkout, that integration test is explicitly
skipped; pure score-validation and gate tests still run.

## RACE response contract

The local adapter adds `race-criterion-id-v1`: an ID registry derived from the
pinned rubric's dimension and item order (`readability_05`, for example). Original
criterion descriptions, weights, article order and upstream score calculation are
unchanged. The output-format appendix requires exact IDs; display names may be
abbreviated. After validating every ID exactly once and finite 0–10 scores, the
adapter restores canonical names before invoking the upstream calculator. There
is no fuzzy matching or silent omission of criteria.

One structure-correction call is allowed. It includes the exact validation error
and prior response, asks to retain valid scores and analyses, and rejects changes
to existing identified judgements. If correction fails, no RACE total is emitted.
The upstream outer retry is limited to one attempt so retries do not multiply.
Retain original responses, contract errors and the normalized record separately;
the scorecard records the adapter version. This output-format change must be
reported when comparing runs even though the official rubric is unchanged.

Executed failing phases are `error`; FACT disabled by race-only configuration is
`skipped` with a reason. A completed RACE score remains available if FACT later
fails. Skipped checks are not zero scores and weights are never redistributed.
Historical results are not overwritten by this change.
