# Issue #346: Manual-trace offline measurement

Status on 2026-10-29 (Asia/Shanghai): **MEASUREMENT COMPLETE (Manual new traces)** — not the original eight historical pairs.

Yi authorized replacing the missing historical 8-pair archive with Manual validation
new traces from run [40819738668](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/40819738668)
(`research-9`=da-13-3, `research-12`=da-14-1), graded inside CI with environment
`nightly-ci-ds` (no secrets on the Develop host).

Grade run: [40865906295](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/40865906295)
on diagnostic branch `ci/346-manual-repeat-grade`.

Judge: `deepseek-flash`, temperature 0, 3 repeats per unchanged answer. No research rerun.

# Offline official-rubric repeat grading (Manual new traces)

Status: complete; judge: deepseek-flash; temperature: 0.
Source: Manual validation run 40819738668 (research-9=da-13-3, research-12=da-14-1).
Not the original eight historical pairs. No research rerun.

| Answer | Case | Scored / planned | Scores | Range |
|---|---|---|---|---|
| da-13-3-manual-40819738668 | da-13-3 | 3 / 3 | [87, 64, 78] | [64, 87] |
| da-14-1-manual-40819738668 | da-14-1 | 3 / 3 | [100, 100, 100] | [100, 100] |

| Answer | Criterion | Levels | Adjacent changes | Pair disagreements |
|---|---|---|---|---|
| da-13-3-manual-40819738668 | 1 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-13-3-manual-40819738668 | 2 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-13-3-manual-40819738668 | 3 | ['B', 'B', 'B'] | 0/2 | 0/3 |
| da-13-3-manual-40819738668 | 4 | ['A', 'B', 'A'] | 2/2 | 2/3 |
| da-13-3-manual-40819738668 | 5 | ['A', 'B', 'B'] | 1/2 | 2/3 |
| da-13-3-manual-40819738668 | 6 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 1 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 2 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 3 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 4 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 5 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 6 | ['A', 'A', 'A'] | 0/2 | 0/3 |
| da-14-1-manual-40819738668 | 7 | ['A', 'A', 'A'] | 0/2 | 0/3 |


## Interpretation for local rubric

- **da-13-3 criterion 4** is unstable on an unchanged answer (A/B/A) — keep as primary local-clarification target.
- **da-13-3 criterion 5** is also unstable here (A/B/B) — include in local variant; original issue focused on 4/6.
- **da-13-3 criterion 6** was stable A/A/A on this sample — do not rewrite from this measurement alone.
- **da-14-1** showed zero judge noise on a perfect (100) answer; the original 21-column / criteria 1–2 ambiguity remains a task/rubric clarity debt for incomplete answers, not demonstrated as same-input grade jitter here.

Official upstream rubrics stay unchanged.


## Local clarified rubric (local-rubric-v1)

Yi authorized rewriting **da-13-3 criteria #4 and #5** as a separately pinned local variant after Manual-trace measurement
(40819738668 + 40865906295): official same-input grades flipped A/B on #4 and #5 because the official A-level checklists
require specific adipose-deposition / "body composition drives remodeling" slogans, while the Manual answer used a
treatment-exposure collinearity / correlation≠causation framing.

- File: `local-rubrics/da-13-3.local-rubric-v1.txt`
- Registry: `local-rubrics.json` (channel `local-variant`, version `local-rubric-v1`)
- Official upstream rubric OID `b54c2480…` unchanged; gates/release still use official only
- Local A levels accept either the official narrative **or** a substantive alternative (collinearity / non-causal framing)
  when direction, leptin/adipokine substance, overlap explanation (#4), and GAHT context + limitations (#5) are present
- da-13-3 criterion #6 and da-14-1 were **not** rewritten from this measurement ( #6 stable here; da-14-1 perfect/stable on this sample)
- Residual: re-run offline local-variant repeat-grade on the Manual fixtures inside CI `nightly-ci-ds` to quantify remaining noise; Draft PR stays unmerged until maintainers accept
