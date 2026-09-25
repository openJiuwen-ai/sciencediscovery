# TC-E2E-01: delivery and independent quality scoring

The real Swarm research case creates the same five built-in specialists, custom
MCP reviewer and team extension as before. The original research question and
workflow instructions are unchanged. The case remains opt-in, outside PR gates.

## Completion contract

All eight real research cases (five DRB, two BiomniBench, one TC) use two layers:

1. **Delivery:** the main run completes and its final assistant message references
   at least one persisted, readable, nonempty artifact. Names, nested paths,
   artifact IDs and version links are supported. An unreferenced intermediate
   file does not pass. A failed/cancelled run with an artifact is `partial`, not
   `passed`. A referenced immutable version takes precedence over the latest head.
2. **Quality:** a separate evaluator scores the frozen deliverables. Low scores,
   missing judge credentials, malformed responses and evaluation timeouts never
   turn successful delivery into a failed E2E assertion. Errors remain visible as
   `evaluation.status=error` with no numeric score, not zero or success.

There are no quality gates based on word count, number of citations, fixed file
paths, literal handoff strings, specialist counts, numeric group shapes or UI
preview selectors. No additional Harness diagnostic scoring layer is introduced;
use retained runtime logs when investigating failures. Existing mocked UI and
unit tests are unaffected.

DRB still uses the pinned official RACE/FACT prompts, criteria and calculations.
Its evaluator's legacy threshold status remains in the scorecard but is not an
E2E assertion. BiomniBench still uses its unchanged, pinned official rubric via
the existing local OpenAI-compatible adapter (not the upstream Gemini verifier).
Biomni rubric inputs `trace.md` and `answer.txt` may be nested; missing scoring
inputs produce a scoring error rather than changing delivery status.

## TC rubric

[tc-research-quality-v1.txt](tc-research-quality-v1.txt) is the versioned judge
prompt. Five dimensions are graded 0–4:

| Dimension | Weight |
| --- | ---: |
| Task coverage and completeness | 20 |
| Evidence and traceability | 25 |
| Analysis and conclusion boundaries | 25 |
| Reproducibility and artifact consistency | 15 |
| Collaboration and final audit | 15 |

The program computes `level / 4 * weight`; it never changes the judge's levels.
An unassessable dimension has a null score and makes the total null, without
redistributing its weight. There is no quality pass threshold. Known defects,
missing evidence and inaccessible evidence must be distinguished.

The judge receives the original task, final report, artifact/version manifest,
selected full or explicitly marked excerpted artifacts, and bounded read-only
access to retained source packages, code, child tool records and audit inputs.
It does not receive the old internal check results. Report-to-audit comparisons
are computed from the actual text before judging, including small differences;
the model judges their impact. These comparisons do not assert scientific truth.

Reads are restricted to registered evidence documents, capped at 30,000
characters per call and approximately 500,000 returned characters per assessment.
After at most 20 exploration calls, finalization uses `tool_choice=none` while
retaining the tool schema, with at most two finalization attempts. Raw responses,
finish reasons, usage and accessed evidence are retained privately. Unknown
artifact versions, unsupported levels and malformed final JSON cannot become a
valid score. The judge must state its sampling scope; no code execution or live
literature verification is performed by this adapter.

## Run

Prepare the isolated Swarm stack as described in the repository's
[Swarm guide](../../../jiuwen_swarm/README.md), and configure the generator with
`E2E_LLM_MODEL_ID` or `E2E_LLM_BASE_URL`, `E2E_LLM_MODEL`, `E2E_LLM_TOKEN`.
Configure the separate TC judge:

```bash
export TEAM_JUDGE_BASE_URL=https://your-provider.example/v1
export TEAM_JUDGE_MODEL=your-judge-model
# Set TEAM_JUDGE_API_KEY through your local secret configuration.
# Existing OPENAI_BASE_URL/OPENAI_API_KEY and RACE_MODEL are supported fallbacks.
node test/sync-e2e.mjs --write
E2E_RESEARCH=1 E2E_SWARM_TASK=1 npm --prefix .e2e run test:real -- science-research-team-real.spec.ts
```

`E2E_TEAM_EVALUATION=rubric` is the default; use `off` to disable paid judging.
`TEAM_JUDGE_PYTHON` defaults to `python3` and needs only the standard library.
`E2E_TEAM_EVAL_TIMEOUT_MS` defaults to 900,000 ms, separate from the existing
`E2E_TEAM_RUN_TIMEOUT_MS` generation deadline. Biomni judging now defaults to
`rubric` (`E2E_BIOMNI_EVALUATION=off` disables it); DRB keeps its existing mode.
Missing judge configuration is recorded as an evaluation error.

Re-score a retained TC evidence directory without rerunning agents:

```bash
python3 test/benchmarks/research-team/judge.py \
  --input /path/to/playwright-case-artifacts \
  --output /path/to/new-quality-evaluation
```

Required inputs: `team-metrics.json` (task and team configuration),
`team-artifacts.json`, `team-children.json`, and `signoff-calls.json`. Older exports
without a delivery manifest use their `evidence_brief.md` artifact. Store each
assessment in a fresh output directory and keep research evidence private.
Output: `scorecard.json`, `evidence-manifest.json`, `audit-comparison.json`,
`response-NN.json` and `evidence-reads.json`. Original research results are not
modified by offline scoring.

## Local verification

```bash
node --test scripts/real-e2e-scoring.test.mjs
node --import tsx --test test/helpers/real-delivery.test.ts
python3 -m unittest discover -s test/benchmarks/research-team -p 'test_*.py'
```
