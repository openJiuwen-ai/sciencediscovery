---
name: audit-hypothesis-tournament
description: Pre-finish audit checklist for the hypothesis-tournament skill — verify that multi-perspective generation really happened through `task` subagent dispatches (trajectory + returned structured candidate lists), that Elo ranking came from the tournament_rank tool (never hand-computed), and that evidence grading and honesty boundaries are intact. Loaded automatically by the finish gate; not for manual use.
metadata:
  audit-for: "hypothesis-tournament"
---

# Audit: hypothesis-tournament output

You are the pre-finish auditor of your own hypothesis-tournament run. The
full trajectory is in your context — audit against it, and verify every
artifact claim with tools (never from memory). If the audit reveals gaps,
**fix them first**; do not trim content to pass. Then call
`review_checkpoint` with a one-line summary of this audit (score + any
critical issues) before giving the final answer.

## Checklist

1. **Perspective generation really happened (highest priority, deterministic)**
   - Anchor A (trajectory): the run contains ≥1 `task` dispatch issuing 3-5
     heterogeneous perspective subagents for candidate generation.
   - Anchor B (results): those `task` results returned structured candidate
     lists (`[{claim, evidence, falsifiable_test}]`), not prose.
   - Both anchors missing → critical `perspective-generation-skipped`:
     candidates role-played in your own context are same-source and do not
     count (the skill forbids this). Score capped at 4.
   - Exactly one anchor holds → warning `generation-anchor-mismatch`; state
     which is missing (if compaction pruned the early trajectory, check
     `research_state(summary)` and the evidence ledger before concluding).
2. **Elo ranking source (deterministic)**
   - The trajectory contains a `tournament_rank` call and the reported Elo
     scores/order come from its output.
   - Concrete Elo numbers without a `tournament_rank` call → critical
     `elo-hand-computed` (the numbers are fabricated).
3. **Candidate content (read the actual artifacts with file tools)**
   - **Evidence grading**: every head candidate labels its support as
     direct evidence / indirect inference / speculation — mixed or missing
     labels → warning `evidence-grading-missing`.
   - **Falsifiability**: every candidate carries a falsifiable test; an
     unfalsifiable "hypothesis" that survived → warning
     `unfalsifiable-candidate`.
   - **Honesty boundary**: ruled-out candidates with reasons are presented;
     in-KB evidence vs speculation is distinguished; open questions are
     listed. Missing → warning `boundary-not-presented`.
   - **Hallucination signal**: cited documents/data do not exist in the
     workspace artifacts and have no corresponding retrieval call in the
     trajectory → critical `hallucinated-evidence`.
4. **Score 0-10**: 10 = both anchors present, Elo from tournament_rank,
   three-tier evidence labels, honest boundaries. −2 per critical,
   −0.5 per warning; capped at 4 when anchor 1 fails.

## Output

Report the audit compactly in the `review_checkpoint` reason:
`score=N; critical: [...]; warning: [...]`. Issue vocabulary:
perspective-generation-skipped (critical) / generation-anchor-mismatch /
elo-hand-computed (critical) / hallucinated-evidence (critical) /
evidence-grading-missing / unfalsifiable-candidate / boundary-not-presented.

## Discipline

- Verify with tools only — `research_state(summary)`, `evidence_ledger(query)`,
  and file reads of the actual artifacts; never judge from impression.
- A check you cannot complete (e.g. trajectory compacted away) is a warning
  with the reason stated, never a fabricated critical.
- When the output is genuinely complete and trustworthy, say so and score
  high — do not invent problems.
