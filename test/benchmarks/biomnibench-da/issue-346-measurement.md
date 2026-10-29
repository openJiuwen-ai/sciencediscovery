# Issue #346 measurement notes

## Inputs
- Manual validation run [40819738668](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/40819738668): research-9=da-13-3, research-12=da-14-1.
- These are authorized Manual traces, **not** the unrecovered original eight historical pairs.
- No research tasks were rerun for grading.

## Official rubric repeats (nightly-ci-ds)
- Run [40865906295](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/40865906295)
- Judge: deepseek-flash, temperature 0, three repeats
- da-13-3: **87 / 64 / 78**; criterion **#4 A/B/A**, **#5 A/B/B** (pair disagreements 2/3 each)
- da-14-1: **100 / 100 / 100**; criteria 1–7 all A/A/A

## Local-rubric-v1 repeats (nightly-ci-ds)
- Run [40874943681](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/40874943681) on branch `ci/346-local-repeat-grade`
- Same Manual fixtures; da-13-3 graded with registered `local-rubric-v1` (`gating: false`); da-14-1 official
- da-13-3 local: **87 / 87 / 87**; criterion **#4 A/A/A**, **#5 A/A/A** (pair disagreements 0/3)
- da-14-1 official: **100 / 100 / 100**

## Interpretation
- On this Manual sample, local clarification of criteria 4/5 removed the observed same-input level flips.
- Official upstream pins and release figures remain unchanged; local scores are informational only.
- Residuals: original eight pairs unrecovered; da-14-1 21-column naming deferred; criterion 6 needs more samples before any local change.
