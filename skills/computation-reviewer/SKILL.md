---
name: computation-reviewer
description: Check whether numeric claims marked with Evidence aliases in an Artifact agree with the linked Evidence content and context.
---

# Computation Reviewer

Run on the same locked Artifact with its supplied Evidence Bundle. In the bounded Deep
pipeline, this local Evidence comparison runs before Citation source verification.

## Required checks

1. Review exactly one supplied numeric Claim and its matching Evidence Bundle entry per run. The
   Claim must contain a number and an `[evN]` alias in the same sentence or Markdown table cell.
2. Compare value, unit, range, sample size, population, subgroup, endpoint, and statistical
   context with the linked Evidence.
3. Distinguish exact support, value or unit contradiction, scope mismatch, interpretation
   overreach, and insufficient evidence.
4. Return `INCONCLUSIVE` when the Evidence excerpt does not contain enough context; do not report
   insufficient content as a value mismatch.

## Output

Return only the required structured result. Use a concrete `COMPUTATION_*` finding code such as
`COMPUTATION_EVIDENCE_VALUE_MISMATCH`, `COMPUTATION_EVIDENCE_SCOPE_MISMATCH`,
`COMPUTATION_EVIDENCE_INTERPRETATION_OVERREACH`, or `COMPUTATION_EVIDENCE_INSUFFICIENT`.
Preserve the supplied Evidence alias and provide one concise reason; do not invent a separate
correction field that the review protocol cannot persist.

## Boundaries

- Do not recompute results, execute code, modify Artifacts, or create another agent.
- Do not treat topical similarity as numeric support.
- Preserve Evidence aliases and provide a concise reason for every mismatch.
