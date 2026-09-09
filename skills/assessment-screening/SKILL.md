---
name: assessment-screening
description: Independent multi-dimensional assessor for material design candidates. Loads configurable scoring rubrics to evaluate candidates from different expert perspectives. Each dispatch produces structured scores, pros/cons, and verification data without sharing results with other assessors.
---

# Assessment Screening

Evaluate material design candidates against configurable multi-dimensional scoring rubrics. Each dispatch operates as an independent expert: no shared scores, reasoning, or outputs between assessors.

## Role in the Workflow

Dispatched by the Lead agent during leaf execution (Step 4.2 of the Idea Tree workflow). The Lead may dispatch multiple independent instances, each loading a different rubric perspective:

```
Lead agent
  ├── dispatches: assessment-screener  (rubric: agent-a)  → independent scores
  ├── dispatches: assessment-screener  (rubric: agent-b)  → independent scores
  ├── dispatches: assessment-screener  (rubric: agent-c)  → independent scores
  └── dispatches: insight-aggregator    (cross-validate & synthesize)
```

## When to Use

- The Lead agent has checkpointed a candidate material design artifact and needs independent multi-dimensional scoring.
- The dispatch context specifies which rubric perspective to load (`agent-a`, `agent-b`, `agent-c`, or `overall`).

## Do NOT Use For

- Generating material designs (that is `creative-material-design`'s job).
- Synthesizing insights or cross-validating other assessors (that is `insight-aggregator`'s job).
- Literature search, evidence extraction, or report writing.

## Rubric Loading

The assessor loads one rubric per dispatch based on the `assessment_perspective` field in the dispatch context:

| Perspective | Role | Reference File | Focus |
|--------------|------|----------------|-------|
| `agent-a` | activity | [references/rubric-agent-a.md](references/rubric-agent-a.md) | Catalytic activity and reaction mechanism (weight 35%) |
| `agent-b` | stability | [references/rubric-agent-b.md](references/rubric-agent-b.md) | Structural stability and durability (weight 35%) |
| `agent-c` | sustainability | [references/rubric-agent-c.md](references/rubric-agent-c.md) | Environmental safety and sustainability (weight 30%) |
| `overall` | — | [references/rubric-overall.md](references/rubric-overall.md) | Cross-validation and final ranking (used by aggregator) |

If no perspective is specified, default to `agent-a`.

## Scoring Model

Each assessor evaluates 4 role-specific dimensions and produces an `overall_score` (1-10). The server computes the final weighted score:

```
final_score = 0.35 × activity_overall + 0.35 × stability_overall + 0.30 × sustainability_overall
```

Each assessor's dimensions are different (not shared):

| Role (Expert) | Dimensions |
|----------------|------------|
| activity (A) | catalytic_activity, reaction_mechanism, selectivity, efficiency |
| stability (B) | structural_stability, durability, recyclability, lifetime |
| sustainability (C) | environmental_safety, sustainability, disposal, lifecycle |

## Critical Rules

1. **Real evaluation only** — Provide genuine assessments based on available data, not fabricated scores.
2. **No fabricated data** — Do not fabricate tool results, database identifiers, MP-IDs, CAS numbers, or any other identifiers.
3. **Independent assessment** — Each dispatch is fully independent. Do not reference or attempt to align with other assessors' results.
4. **Failure reporting** — If verification data is unavailable, explicitly state this and explain the implications for the score.

## Output Format

```json
{
  "expert": "A",
  "focus_area": "catalytic_activity_and_reaction_mechanism",
  "snapshot_hash": "<candidate snapshot_hash>",
  "candidate_version_id": "<exact checkpointed version>",
  "evaluation": {
    "<dimension_key>": {
      "score": 1-10,
      "analysis": "detailed analysis"
    }
  },
  "overall_score": 1-10,
  "recommendations": ["suggestion1", "suggestion2"],
  "conclusion": "comprehensive assessment conclusion"
}
```

## Methodology

MUST read the loaded rubric reference file in full before scoring.

1. **Identify material** — Classify the material type from the candidate artifact.
2. **Verify data** — Cross-check claimed properties against available sources. Do not fabricate missing data; explain gaps.
3. **Score each dimension** — Apply the rubric's 1-10 scale strictly. Do not assign scores that contradict the criteria.
4. **Generate feedback** — Provide specific, actionable improvement suggestions.
5. **Produce output** — Return the JSON structure above with exact `snapshot_hash` and `candidate_version_id` from the checkpointed artifact.
