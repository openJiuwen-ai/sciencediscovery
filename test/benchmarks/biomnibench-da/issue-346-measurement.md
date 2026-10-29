# Issue #346: measurement prerequisite

Status on 2026-10-29: **BLOCKED — no repeat-grading measurement executed**.

The required inputs are the eight unchanged answer/trace pairs from
[run 38734441039](https://github.com/openJiuwen-ai/sciencediscovery/actions/runs/38734441039):

| Case | Original evidence artifact names |
|---|---|
| da-13-3 | `real-e2e-evidence-a1-research-1-r1`, `real-e2e-evidence-a2-research-1-r1`, `real-e2e-evidence-a3-research-1-r1`, `real-e2e-evidence-a2-research-1-r3` |
| da-14-1 | `real-e2e-evidence-a1-research-2-r1`, `real-e2e-evidence-a2-research-2-r1`, `real-e2e-evidence-a3-research-2-r1`, `real-e2e-evidence-a1-research-2-r4` |

The paginated GitHub artifacts API currently lists corresponding `real-e2e-memory-*`
artifacts but none of these eight `real-e2e-evidence-*` artifacts. The retained
`e2e-results` bundle (artifact ID `11996230353`) contains no Biomni answer,
trace or scorecard. Local cache searches also found none of the eight pairs.
The worker environment has no configured `BIOMNI_JUDGE_*` variables.

Consequently there are **0/8 recovered inputs and 0/24 executed evaluations**.
No criterion noise rate, score distribution or improvement claim can be made.
The original scores reported on the issue compare different answers and are
not a repeat-grade measurement. They have not been changed on #343.

Recover the original input archive and configure the judge, then use the
[documented offline runner](README.md#offline-repeat-grading-no-research-generation).
Record input/rubric hashes, judge model, all per-repeat criterion levels and
failure counts. Only then choose and implement the separately pinned
`local-rubric-vN` clarifications. Candidate targets remain DA-13-3 criteria 4/6
and DA-14-1's unnamed 21-column set; they have **not** been rewritten without
the required measurement or an authoritative column mapping.

No research tasks were rerun. Existing upstream instructions, rubrics and pins
remain unchanged. The reporting/provenance groundwork does not complete #346;
the local rubric and actual dual evaluation remain outstanding.
