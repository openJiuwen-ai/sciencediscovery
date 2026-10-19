---
name: idea-debate
description: Use this skill when the user wants to discover research directions from a knowledge base — find field gaps, brainstorm innovation points grounded in the ingested literature, or debate "what's next" for a domain ("what else can be done in this field", "find research gaps", "brainstorm new ideas from these papers", "where is the next breakthrough in X"). Runs deterministic graph-whitespace analysis for candidates, a real multi-perspective subagent debate to evaluate and elaborate them, and deterministic Elo ranking of the resulting proposals. For general hypothesis generation/critique without the graph-whitespace focus see hypothesis-tournament; for multi-generation deepening see tree-search.
metadata:
  pre-finish-audit: "true"
---

# Idea Debate (graph-whitespace-driven research directions)

A knowledge engine's value is not only summarizing what is known but spotting
what the graph implies yet the literature never states. Discipline: **gap
candidates come from deterministic graph analysis (never your intuition),
evaluation is a real multi-agent debate, ranking is deterministic Elo, and
every proposal separates in-graph evidence from extrapolation.**

> Every step should involve tool calls. Pin the goal and plan with
> `research_state`; it survives compaction and interruptions.

## Stage 1: Deterministic gap candidates

Call `gap_candidates` ({kbId}, optional signals/topN) for three structural
candidate classes:

- **holes** — entity pairs sharing ≥3 neighbors with no direct edge:
  relationships the literature implies but never states. Cross-community
  holes are the strongest structural signal.
- **conflicts** — high-support contradicts/contrasts_with edges: the most
  evidenced open controversies.
- **transfers** — method M is used on A; B shares A's context but never used
  M: graph-implied transfer opportunities.

**PU principle**: candidates are structural signals, not conclusions. A
missing edge means unknown (possibly just not extracted) — it does not prove
a gap. A gap claim that has not passed the falsification pass (stage 2) is
invalid.

Also useful: `concept_explore` on the seed entities for neighborhood context,
`evidence_ledger(add)` to register each candidate with its structural
evidence.

## Stage 2: Real multi-perspective debate — subagents, mandatory

**Do NOT simulate the perspectives yourself.** Same-context perspectives make
the later Elo ranking non-independent (measured failure mode). Dispatch **5
heterogeneous perspective subagents** with the `task` tool in one turn (they
run concurrently), each with the candidate JSON in its brief and an
`outputJsonSchema` for structured handback:

- **transfer** — technical feasibility and expected payoff of transfer
  candidates; check with web retrieval whether the migration was already done
  outside the KB (duplication risk).
- **counterexample** — for each candidate, hunt in-KB refuting evidence with
  `deep_dive`/`concept_explore` and the strongest external opposing evidence
  with web retrieval.
- **gap-locator** — are holes/conflicts real gaps (not extraction misses) and
  worth solving; verify with web retrieval whether recent out-of-KB work
  already filled the gap (the most common failure mode for gap proposals).
- **cross-discipline** — analogies across fields (life science ↔ chemistry ↔
  ML), inspiration beyond the graph.
- **critic** — check every proposal's graph evidence; run `validate_entities`
  on named entities; label each claim "in-graph evidence" vs "extrapolated
  hypothesis"; score evidence strength 0-1 per proposal; spot-check key
  external facts.

### External-evidence discipline (when web tools are on)

The graph is the **primary anchor**; external retrieval is **corroboration
and falsification**, never proposal stuffing:

1. **In-KB screen**: `kb_search` for the entity pair + mechanism terms; a hit
   means `deep_dive` to judge whether the relation is already studied in-KB
   (if so, downgrade honestly: extraction miss, not a gap).
2. **Out-of-KB check**: 1-3 targeted queries per candidate; zero results is
   corroborating evidence, but phrase it "not seen in-KB + not found in
   retrieval", never "absent from the literature".
- Label everything external as **"external evidence (not in KB)" + source**
  (title / author-year / DOI / URL); never disguise it as graph evidence.
- A gap found already filled is not deleted but **downgraded with the filling
  citation noted** — that itself is a valuable survey result.

## Stage 3: Aggregate + deterministic Elo ranking

1. Read each perspective's structured output; merge into 3-5 proposals.
2. **Anti-hallucination pass**: `validate_entities` on every named entity;
   unknowns are corrected to graph entities or labeled "new concept outside
   the graph".
3. **Pairwise judging** over all proposal pairs (i, j), six weighted
   dimensions (score ∈ [0,1], weighted mean):
   novelty 0.25 (truly "graph-implied but unstated", non-trivial) ·
   feasibility 0.25 · evidence strength 0.2 (Critic's scores; proposals
   falsified or already-filled lose here) · hallucination control 0.1
   (entities/citations validated and anchored) · uncertainty calibration 0.1
   (honest evidence vs speculation split) · impact 0.1.
4. **Elo via the `tournament_rank` tool — never hand-computed**:
   items = proposal labels, matches = every (i, j) verdict (a=i, b=j,
   scoreA = score(i,j)); the tool returns the Elo-ordered ranking with win
   rates. Also ask it for divergence — near-identical proposals signal
   same-source generation (go back and diversify).

## Output

One report, three visible parts:

- **Debate summary** — each perspective's core positions and key evidence
  chains (entity → relation → entity, doc:name).
- **Elo ranking table** — rank / Elo / win rate / proposal / candidate class
  (hole|conflict|transfer) / evidence count / risk.
- **Per-proposal cards** — core idea (1-2 sentences), in-graph evidence chain
  with source docs, external evidence (or "none found"), critic's objections
  (kept, not smoothed over), a concrete validation path, and an explicit
  "established vs speculation" split.

Write the full report to the workspace (`run_python`) and `declare_artifact`
it as `debate-report-{kbId8}-{date}.md`; the final answer carries the ranking
table and the top proposals in full — not just a pointer to the file.

## Rules

- Gap candidates come only from `gap_candidates` output; never invent them
  from memory. Missing edge = unknown, not disproven.
- The debate is real `task` subagents; self-simulated perspectives void the
  ranking's independence.
- Every proposal separates in-graph evidence / external evidence (sourced) /
  extrapolation.
- Filled gaps are downgraded with the filling citation, never deleted.
- Critic and counterexample objections survive into the final output.
- Elo is computed by `tournament_rank` only; the six judging dimensions are
  fixed.
- Before finishing, this skill's declared pre-finish audit runs: re-check
  that every proposal's claims trace to the debate record, then call
  `review_checkpoint`.
