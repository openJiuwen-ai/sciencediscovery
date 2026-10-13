# DeepResearchBench II release benchmark

L5 (`release`) includes all **132** DRB II tasks, separately identified in
`test/deepresearchbench-ii.spec.ts`. PR/L2, merge/L3 and daily/L4 do not run them.
Collection is offline and credential-free: identities are committed, not
conditionally discovered from downloaded data. Missing prerequisites fail a
selected case; they never silently reduce the suite.

## Runtime dependency

The upstream is [DeepResearch-Bench-II](https://github.com/imlrz/DeepResearch-Bench-II),
pinned to `b38f360603db9531b102aef8c166cedb8509b6f6`. No upstream dataset, report
corpus or Python implementation is vendored. Preparation uses a shallow,
blob-filtered sparse checkout of the dataset, evaluator, licenses and locked
Python dependencies. Existing directories are verified, never reset. Dataset
and evaluator SHA-256 checks reject modified content before paid generation.
There is no fallback to a moving branch if the commit cannot be fetched.

```bash
node test/benchmarks/deepresearchbench-ii/prepare.mjs /absolute/cache/drb2
export DRB2_UPSTREAM_DIR=/absolute/cache/drb2
export DRB2_PYTHON=/absolute/cache/drb2/.venv/bin/python
```

CI performs this automatically only for `drb2-*` research workers. These workers
do not need the DRB I evaluator, `HF_TOKEN`, or `JINA_API_KEY` merely to score;
configured research providers may still require their own credentials.

## Execution and budgets

Use the existing isolated real E2E entry point, with `CI_ALLOW_REAL=1`, generator
`E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_LLM_TOKEN`, and independent Judge
`E2E_JUDGE_BASE_URL`, `E2E_JUDGE_MODEL`, `E2E_JUDGE_TOKEN`:

```bash
pnpm ci:e2e:real -- --profile release
```

This is the cumulative release suite, not only DRB II. To inspect the exact
selection without model calls:

```bash
node test/support/tagged/shared.mjs list --profile release --slice e2e-real --output .ci-release-plan
```

Each task gets an isolated job; the existing workflow permits two jobs at a
time and gives each research job 240 minutes including setup. Generation allows
120 minutes (`E2E_DRB2_RUN_TIMEOUT_MS`); judging allows 30 minutes
(`E2E_DRB2_EVAL_TIMEOUT_MS`). Four minutes are reserved for test teardown.
There is **no test-added total-subagent or search-count prompt limit**. Product
runtime quotas and provider configuration still apply and must be held constant
for comparative runs. The original task, including its blocked references, is
preserved; only platform report-delivery instructions are appended. Rubrics
are never sent to the research Agent.

DRB II CI preparation disables Memory Graph, matching the initial experiment
and isolating report research from graph-service resource usage. Local runs
should set `SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE=0` too; metrics record it.

132 paid research tasks can take many hours and substantial tokens. For example,
30 minutes per task is 66 worker-hours, about 33 hours at two workers, excluding
setup, judging and other L5 cases. Timeouts are not spending caps. A release tag
triggers this cumulative gate; failure blocks publishing assets/Release, not
creation of the tag. Avoid repeated release candidates as an inexpensive smoke test.

## Scoring and assertions

The upstream prompt, blocked-source handling and rubric matching are reused.
The adapter parses valid JSON (or a JSON fence) without upstream's key-repair
regex, which can corrupt compact JSON strings. It also checks exact batch
multiplicity and verdict types; neither change alters rubric text or score meaning.
Every expected rubric must have a verdict in `{-1, 0, 1}`. Overall score is
`100 × satisfied items / all items`; blocked-reference rate is reported separately.
Final report delivery and **complete successful evaluation** are mandatory.
Missing reports, invalid/missing verdicts and exhausted Judge retries fail the
case. A low but valid score is not an infrastructure failure. There is no invented
quality threshold or historical regression gate; exit reviewers inspect scores.

Task 116 contains six repeated analysis rubric texts. The official output maps
scores by rubric text, so this task has 56 raw items but 50 distinct scored
items. We preserve that upstream behavior, validate duplicate multiplicity in
each response batch, and record both `raw_items` and `items`; duplicates are not
silently counted as missing results or used to inflate the denominator.

Default Judge transport is OpenAI-compatible chat completions. Use
`DRB2_JUDGE_API_STYLE=deepseek` for DeepSeek's `max_tokens` parameter; otherwise
`max_completion_tokens` is used. The initial output budget is 32,768
(`DRB2_JUDGE_MAX_OUTPUT_TOKENS`, 1,024–65,536). Truncation doubles the budget to a
65,536 ceiling on retry. Batches contain 15 rubrics, at most three attempts each,
one request at a time, with a 600-second response timeout and no redirects.
Official public scoring currently uses GPT-5.5; another Judge, changed budgets,
or platform delivery instructions make results an internal evaluation, **not an
official leaderboard submission**. Even matching the Judge name is not enough
to claim fully comparable execution conditions.

## Evidence and known limitations

Each attempt retains `benchmark-metrics.json`, the final `idx-N.md`, child
trajectories inside metrics, and `evaluation/scorecard.json`,
`rubric-results.json`, `judge-calls.jsonl`. Judge calls include usage and latency
for failed/retried responses as well as successful ones. Missing provider usage
is unknown, not zero cost. Generation and evaluation times are separate.
The normal score artifact retains case ID, lifecycle status and overall score;
full diagnostic evidence contains prompts/reports and belongs in restricted
CI artifacts. The frozen plan accounts for all 132 identities, including failures.

The existing platform session usage summary may omit intermediate/child model
calls; it is explicitly marked as **not a billing total**, not silently reported
as whole-task usage. The benchmark does not fix runtime metering or the existing
5-second status-poll timeout/recovery policy. Resource-constrained local hosts
can still fail long browser journeys; such failures remain visible rather than
relaxing delivery assertions. No persistent service restart or interruption
recovery guarantee is added here.

Upstream data licenses apply per task: 129 CC BY 4.0, tasks 26/110 CC BY-NC 4.0,
and task 119 CC0. Consult the pinned `DATA_LICENSE` and per-task attribution
before commercial use or redistributing data. Runtime download is not a license
exemption. Keep benchmark source articles/rubrics separate from Agent input.
