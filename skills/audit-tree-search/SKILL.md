---
name: audit-tree-search
description: Pre-finish audit checklist for the tree-search skill — verify that branch expansion really happened through `task` subagents, that research_state [TREE] plan items match the tree/ workspace artifacts one-to-one, that replication aggregates carry mean±variance, that the final ranking came from a held-out tournament_rank call (never internal scores), and that the budget was honored or honestly labeled. Loaded automatically by the finish gate; not for manual use.
metadata:
  audit-for: "tree-search"
---

# Audit: tree-search output

You are the pre-finish auditor of your own tree-search run. The full
trajectory is in your context; verify every state and artifact claim with
tools (`research_state`, `read_file`, `list_files`) — never from memory.
Fix gaps before finishing; do not trim content to pass. Then call
`review_checkpoint` with a one-line audit summary (score + critical issues).

## Checklist

1. **Anchor 1 — real branch expansion (deterministic)**
   - The trajectory contains ≥1 `task` dispatch for multi-branch expansion.
     Missing → critical `branch-expansion-skipped` (self-role-played branches
     do not count); score capped at 4.
   - If early trajectory was compacted away, check `research_state(summary)`
     for `[TREE ` entries before concluding.
2. **Anchor 2 — node/artifact consistency (deterministic)**
   - Read `research_state(summary)` for the `[TREE Nxx ...]` plan items; list
     the workspace `tree/` artifacts with `list_files`/`read_file`.
   - Every non-dropped `[TREE ` item needs a matching `tree/Nxx.md`; every
     artifact needs a matching plan item. Ghost nodes or ghost artifacts →
     critical `tree-artifact-mismatch` (list the nodeIds).
   - No `[TREE ` items in the plan at all → critical `world-model-unused`
     (the skill declares research_state; tree state must live there). Score
     capped at 4.
3. **Anchor 3 — evidence grading three tiers**
   - Spot-read surviving node artifacts: each labels support as direct
     evidence / indirect inference / speculation. Missing or mixed →
     warning `evidence-grading-missing`. Cited material that exists nowhere
     in artifacts and has no retrieval call → critical
     `hallucinated-evidence`.
4. **Anchor 4 — ablation replication**
   - A `op=replicate` node exists and its aggregate carries **mean±variance**,
     or the output honestly reports why stage 3 was skipped (<2 head nodes /
     budget exhausted). Neither → warning `replication-missing`; replicate
     nodes without variance → warning `replication-no-variance`.
5. **Anchor 5 — final ranking source (deterministic)**
   - The final ordering comes from a `tournament_rank` call on held-out
     signals. No call but a final ranking → critical
     `final-rank-hand-computed`. Internal stage-2 scores presented as the
     conclusion → critical `internal-score-as-final`.
   - This call is designed to happen LAST — if compaction pruned it, verify
     via artifacts/`research_state` before judging. If it is genuinely
     missing, the critical stands regardless of how clean the other anchors
     are; score capped at 4.
6. **Anchor 6 — budget compliance**
   - Node count / max depth / debug-chain length / contraction of
     no-hard-signal branches against the pinned budget. Overrun honestly
     labeled → no deduction; overrun unlabeled → warning `budget-overrun`.
7. **Score 0-10**: −2 per critical, −0.5 per warning; capped at 4 when
   anchor 1 fails.

## Output

Report compactly in the `review_checkpoint` reason:
`score=N; critical: [...]; warning: [...]`. Issue vocabulary:
branch-expansion-skipped (critical) / tree-artifact-mismatch (critical) /
world-model-unused (critical) / hallucinated-evidence (critical) /
final-rank-hand-computed (critical) / internal-score-as-final (critical) /
evidence-grading-missing / replication-missing / replication-no-variance /
budget-overrun / vague-quantifier / number-mismatch.

## Discipline

- Verify with tools only; never guess paths or state.
- Unverifiable checks are warnings with reasons, never fabricated criticals.
- Exact counts only: any count in the output (branches, replications,
  budget figures) comes from a tool or artifact read — "several/many/about
  N" for anything countable is a warning `vague-quantifier`.
- Numbers verbatim: a digit, unit, or magnitude that differs from its
  artifact or ledger source is a finding (`number-mismatch`), never a
  paraphrase.
- Score honestly — do not invent problems for a clean run.
