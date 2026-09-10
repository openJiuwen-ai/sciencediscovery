# Cross-Validation Guide

Detailed methodology for cross-validating multiple independent expert assessments and synthesizing actionable insights for tree propagation.

## Bottom-Up Insight Propagation Model

Inspired by the Arbor idea tree insight propagation system, insights flow upward through the tree:

```
Leaf (direct finding)
  → Parent (pattern across children)
    → Grandparent (higher-level synthesis)
      → Root (global research insight)
```

At each level, the insight is synthesized from all children's insights. The aggregator produces the leaf-level insight; the Lead agent propagates it upward via `tree_update_node`.

## Cross-Validation Methodology

### Step 1: Score Aggregation

For each of the 5 dimensions, compute:

- **Average score** across all experts (A, B, C)
- **Standard deviation** across all experts
- **Min/Max range** to identify outlier scores

```text
avg_d = sum(expert_scores_d) / num_experts
sd_d = sqrt(sum((score - avg_d)^2) / num_experts)
```

### Step 2: Consistency Classification

| SD Range | Classification | Action |
|----------|---------------|--------|
| SD <= 1.0 | Strong consensus | Report as convergent dimension |
| 1.0 < SD <= 2.0 | Moderate agreement | Report with minor caveats |
| SD > 2.0 | Significant disagreement | Flag as divergent; explain in discrepancies field |

### Step 3: Pattern Identification

Look for cross-dimensional patterns:

1. **Uniformly strong** — All dimensions score high with low variance. Insight: strong candidate with broad expert support.
2. **Uniformly weak** — All dimensions score low with low variance. Insight: fundamental design flaw; consider pruning.
3. **Mixed profile** — Some dimensions strong, others weak. Insight: targeted improvement needed; identify which dimensions are fixable.
4. **Expert divergence** — High variance on specific dimensions. Insight: uncertain assessment; note what additional data would resolve the disagreement.

### Step 4: Insight Synthesis

Write the insight as 1-3 sentences following these principles:

- **Lead with the key finding** — What is the most important takeaway?
- **Quantify when possible** — Reference specific dimension scores or averages.
- **Be actionable** — What should the Lead agent do next? (Expand this direction, prune it, try a variant, etc.)

**Examples:**

- Strong candidate: "High catalytic performance (avg 8.3) with strong structural validity (avg 8.7) and expert consensus. Economic viability is moderate (avg 6.0) due to moderately priced precursors. Promising direction for PMS activation — expand with cost-reduction variants."

- Weak candidate: "Low structural validity (avg 3.0, strong consensus) and weak catalytic support (avg 3.3). Fundamental structural issues make this direction unpromising — consider pruning."

- Mixed profile: "Strong catalytic potential (avg 7.7) but significant expert disagreement on environmental friendliness (SD 2.5). Structural validity is good (avg 7.3). Environmental risk assessment needs additional data before this direction can be confidently pursued."

### Step 5: Feedback Aggregation

Merge pros and cons across experts:

1. **Deduplicate** — Remove identical or near-identical points.
2. **Weight by frequency** — A con mentioned by 2/3 experts is more significant than one mentioned by 1/3.
3. **Preserve contradictions** — If Expert A lists something as a pro and Expert B lists it as a con, include both perspectives.

## Score Calculation

The server computes the final weighted score using role weights. The aggregator should reference them in the insight when relevant:

| Role (Expert) | Weight | Focus |
|----------------|--------|-------|
| activity (A) | 35% | Catalytic activity and reaction mechanism |
| stability (B) | 35% | Structural stability and durability |
| sustainability (C) | 30% | Environmental safety and sustainability |

```
weighted_score = 0.35 × activity_overall + 0.35 × stability_overall + 0.30 × sustainability_overall
```

## Propagation Context

When writing the insight, consider that it will be read at three levels:

1. **Parent node** — The Lead synthesizes insights from all children (including this leaf) to decide whether to expand or prune siblings.
2. **Ancestor nodes** — Higher-level synthesis identifies patterns across multiple branches.
3. **Root node** — The global research insight summarizes the entire exploration.

The leaf insight should be specific enough to inform parent-level synthesis but not so verbose that it clutters higher-level aggregation.
