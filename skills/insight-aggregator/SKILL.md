---
name: insight-aggregator
description: Synthesize insights from multiple independent assessment results into a concise, actionable summary. Cross-validates expert scores, identifies patterns and discrepancies, and produces a semantic insight that propagates upward through the Idea Tree. Does NOT calculate or override scores.
---

# Insight Aggregator

Synthesize insights from multiple independent assessment artifacts into a coherent, concise summary. The aggregator is the bridge between per-leaf scoring and tree-wide insight propagation.

## Role in the Workflow

Dispatched by the Lead agent during leaf execution (Step 4.3 of the Idea Tree workflow), after all independent assessors have checkpointed their results:

```
Lead agent
  ├── dispatches: assessment-screener (agent-a)  → scores + pros/cons
  ├── dispatches: assessment-screener (agent-b)  → scores + pros/cons
  ├── dispatches: assessment-screener (agent-c)  → scores + pros/cons
  └── dispatches: insight-aggregator             → synthesize insight
                                                    │
                                                    ▼
                                              tree_update_node
                                              (propagate upward)
```

## When to Use

- All independent assessors have checkpointed their assessment artifacts for a candidate.
- The Lead needs to synthesize the assessments into an insight for tree propagation.

## Do NOT Use For

- Scoring or evaluating candidates directly (that is `assessment-screening`'s job).
- Generating material designs (that is `creative-material-design`'s job).
- Calculating weighted scores (the server computes the deterministic score).
- Overriding or modifying assessor scores.

## Insight Synthesis Method

The aggregator follows a bottom-up synthesis approach inspired by the Arbor insight propagation model:

### Phase 1: Gather

Collect all checkpointed assessment artifacts. Each artifact contains:
- Independent per-dimension scores (1-10)
- Pros and cons from the expert's perspective
- Structure verification ratings
- Verification notes

### Phase 2: Cross-Validate

1. **Score consistency** — Compute per-dimension standard deviation across experts. Flag dimensions where disagreement exceeds 2.0 points.
2. **Convergence analysis** — Identify dimensions where all experts agree (low variance) vs. dimensions with significant divergence.
3. **Strength/weakness synthesis** — Aggregate pros and cons across experts. Weight cons that appear in multiple assessments more heavily.

### Phase 3: Synthesize

Produce a concise insight (1-3 sentences) that captures:
- The key learning from this candidate
- Patterns or contradictions across expert evaluations
- Actionable conclusions for tree propagation

The insight must be semantic — it explains the "why" behind available evidence and scores, not just the numbers. If the prompt requests a score synthesis, state the calculation or judgment clearly so the Lead can pass it to `idea_tree_finalize`.

### Phase 4: Propagate-Ready Output

Format the output for `tree_update_node` propagation. The insight will flow upward through the tree:

- At leaf level: direct experimental finding
- At parent level: synthesized pattern across children
- At root level: global research insight

## Critical Rules

1. **Follow the selected scoring method** — Calculate or recommend a score only when the prompt/workflow asks for it; do not assume the old fixed triad weighting.
2. **No fabrication** — Do not invent scores, data, or findings not present in the assessment artifacts.
3. **Preserve contradictions** — If experts disagree, surface the disagreement verbatim. Do not resolve it silently.
4. **Concise insight** — The insight field must be 1-3 sentences. It should be specific enough to guide future ideation but concise enough to propagate efficiently.
5. **Semantic only** — The aggregator explains meaning and patterns, not arithmetic.

## Output Format

```json
{
  "snapshot_hash": "<candidate snapshot_hash>",
  "candidate_version_id": "<exact checkpointed version>",
  "assessment_version_ids": {
    "activity": "<version-activity>",
    "stability": "<version-stability>",
    "sustainability": "<version-sustainability>"
  },
  "insight": "1-3 sentence key learning synthesizing all expert evaluations",
  "cross_validation": {
    "overall_scores": {
      "activity": <1-10>,
      "stability": <1-10>,
      "sustainability": <1-10>
    },
    "weighted_score": <0.35×activity + 0.35×stability + 0.30×sustainability>,
    "consensus_areas": ["areas where experts agree"],
    "divergence_areas": ["areas with significant disagreement"],
    "discrepancies": "description of any significant disagreements between experts"
  },
  "synthesized_recommendations": ["aggregated suggestions from all experts"]
}
```

## Methodology

MUST read [references/cross-validation-guide.md](references/cross-validation-guide.md) in full before synthesizing.

1. **Gather artifacts** — Read all checkpointed assessment artifacts for the current leaf execution.
2. **Cross-validate** — Compare scores across experts, identify convergence and divergence.
3. **Synthesize insight** — Produce a 1-3 sentence insight that captures the key learning.
4. **Aggregate feedback** — Merge pros/cons across experts, weighting by frequency.
5. **Produce output** — Return the JSON structure above with exact version IDs from the checkpointed artifacts.
