# Rubric: Overall Assessment Cross-Validation

Use this reference for the `overall` perspective after the independent activity,
stability and sustainability assessments have been checkpointed. This is the
insight aggregator's synthesis step, not a fourth independent scoring expert.

## Inputs

- Read the candidate and each checkpointed assessment artifact.
- Require the same `snapshot_hash` and `candidate_version_id` across the inputs.
  Identify missing assessments or version mismatches before drawing a conclusion.
- Retain the assessment version IDs so the synthesis can be traced to its inputs.

## Cross-Validation

1. Summarize each expert's supported strengths, weaknesses and verification gaps.
2. Compare claims about the same property. Preserve contradictory evidence and
   explain what observation could resolve it; do not silently reconcile scores.
3. Keep role-specific dimensions distinct. Catalytic activity, durability and
   environmental safety are different criteria, so their scores are not repeated
   measurements of one shared dimension.
4. Report missing evidence as uncertainty. Do not invent measurements or scores
   to fill a missing assessment.

## Score and Ranking

The server owns the final numeric score. For the water-treatment triad, the
existing weights are activity 35%, stability 35% and sustainability 30%:

```text
final_score = 0.35 × activity_overall + 0.35 × stability_overall + 0.30 × sustainability_overall
```

Reference the supplied server score rather than overriding it. Follow the selected
workflow's weights if another template is used. Rank candidates only when their
scores use the same template, scoring method and complete assessment set; otherwise
state why the comparison is incomplete.

## Output

Follow the insight aggregator's output contract: exact candidate and assessment
version IDs, supplied expert scores, consensus and divergence areas, discrepancies,
and actionable recommendations. Write a concise insight explaining the main finding,
its uncertainty and the next validation step. A high numeric score alone does not
establish experimental success or remove a reported safety or feasibility concern.
