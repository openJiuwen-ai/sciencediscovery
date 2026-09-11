---
name: hypothesis-tournament
description: Use this skill when the user asks to propose, generate, or evaluate research hypotheses, mechanistic explanations, or experimental ideas, or to compare multiple candidate directions ("what mechanisms could explain this", "propose a few testable hypotheses", "which of these directions is worth pursuing", "brainstorm research ideas"). Runs the full tournament loop — parallel multi-perspective generation via subagents, critic-stance review, pairwise debate with deterministic Elo ranking, evolution rewrites, diversity checks, and a meta-review. For graph-whitespace-driven research-direction debates see idea-debate (when available); for multi-generation deepening with pruning and replication see tree-search.
---

# Hypothesis Tournament

Generate, critique, and rank candidate hypotheses around a question — like a
scientific review panel. Core disciplines: **generation and review are
separated (different stances), every candidate is evidence-anchored, ranking
uses deterministic math (never hand-computed Elo), and evidence boundaries
are honestly labeled (in-KB evidence vs speculation).**

> Every step should involve tool calls. All state (goal, plan, open
> questions, ruled-out candidates) lives in the `research_state` world model
> — it survives context compaction and interruptions.

## Stage 0: Frame the question

- Clarify the user's question and the judging criteria (novelty? feasibility?
  impact? — these weight the review in stage 2).
- If a knowledge base is present (the resident summary lists KBs), ground
  candidates in graph evidence; without one, use external retrieval
  (`web_search`) and state the evidence-strength difference honestly.
- `research_state(set-goal)` to pin the question + criteria; `plan-add` the
  tournament stages.
- **Checkpoint (conversational)**: present the pinned goal and judging
  criteria to the user and wait for confirmation before generating — a wrong
  target wastes the whole tournament.

## Stage 1: Multi-perspective generation — real subagents, mandatory

**Do NOT role-play multiple perspectives in your own context.** Candidates
generated in a single context are same-source; the later Elo ranking loses
independence (measured failure mode from the original system). Dispatch
**3-5 heterogeneous perspective subagents** with the `task` tool (issue the
calls in one turn so they run concurrently), each producing 1-3 candidates.
Typical perspectives, chosen to fit the question:

- **Evidence-driven** — hypotheses from existing evidence / graph structure
  (`gap_candidates` holes/conflicts/transfers when a KB is bound).
- **Mechanistic** — causal-chain hypotheses from first principles.
- **Contrarian** — challenges the mainstream explanation.
- **Cross-domain transfer** — migrates methods/concepts from other fields.

Give each subagent a `brief` with the question, the judging criteria, its
perspective stance, and an `outputJsonSchema` for the candidate list
(`[{claim, evidence, falsifiable_test}]`) so results come back structured.

**Completion anchor (self-check)**: your trajectory contains the `task`
dispatches AND each returned a structured candidate list. If either is
missing, stage 1 has not happened — self-invented candidates do not count.

Every candidate must have: **a one-line claim + supporting evidence
(documents/data/graph structure) + a falsifiable test**. Unfalsifiable
"hypotheses" are eliminated on the spot. Register candidates and key evidence
with `evidence_ledger(add)` (a missing source is marked honestly, never
back-filled).

**Diversity check**: with >4 candidates, run `tournament_rank(action=
"divergence")` over the candidate texts — divergence < 0.6 means the
perspectives converged; solicit one genuinely different-stance candidate.

## Stage 2: Critic review (reflection)

For each candidate, review from a **critic's stance** on four dimensions
(review only — do not edit candidates):
1. **Correctness** — contradicts known evidence (in-KB / retrieval
   counter-evidence)?
2. **Evidence strength** — direct evidence, indirect inference, or pure
   speculation?
3. **Novelty** — has the literature already stated this (verify via
   retrieval, not "I haven't seen it")? With a KB bound, `novelty_check`
   gives the internal three-probe verdict; external novelty still needs
   retrieval.
4. **Feasibility** — is the proposed test actually executable?

Questions that cannot be answered on the spot go to
`research_state(question-add)`; candidates knocked out by counter-evidence
are recorded with `rule-out` and removed from the tournament (tell the user
exactly what was removed and why).

## Stage 3: Pairwise debate + Elo ranking

1. Judge surviving candidates **pairwise**: for each pair write a short
   comparison (2-4 sentences: where A is stronger, where B is stronger, who
   wins under the stage-0 criteria) and a verdict score (1 = A wins,
   0.5 = tie, 0 = A loses). With ≤6 candidates judge in the main context;
   with more, dispatch parallel judge subagents via `task`.
2. Feed all verdicts at once to `tournament_rank(action="rank")`
   (items = candidate labels, matches = verdict records) — **the Elo math is
   computed by the tool, never by hand**.
3. Archive the verdict records with `evidence_ledger` or a workspace file
   (auditable: the user can see every match's rationale).

## Stage 4: Evolution

Take the top 2-3 by Elo and **rewrite them stronger by absorbing stage-2
criticism** (close evidence gaps, tighten claim boundaries, improve test
design). Keep originals and evolved versions side by side (label `v2`). If
the evolution is substantial, run one more tournament round among the
leaders (verdicts note they judge evolved versions).

## Stage 5: Output

Final answer contains:
- **Elo table**: candidate (one-line claim), Elo, win rate, key weakness.
- **Per top candidate**: evidence anchors (documents/sources), the
  falsifiable test, evolution highlights.
- **Honest boundaries**: which judgments rest on in-KB evidence vs
  speculation; ruled-out candidates with reasons; open questions list.
- Persist the full process (perspectives, reviews, every pairwise verdict)
  as a workspace file (write via `run_python`) and register the report with
  `declare_artifact` so it appears in the artifacts panel.

## Stage 6: Meta-review (learning without backprop)

Look back over the tournament and distill **patterns, not anecdotes**:
- Which candidate types systematically won/lost (e.g. "mechanistic hypotheses
  with direct evidence anchors swept", "cross-domain transfers all died on
  feasibility")?
- Review blind spots (e.g. "twice treated indirect evidence as direct").
- Present the lessons briefly in the final answer. If a lesson points at a
  reusable improvement to a user-level skill, submit it with
  `propose_skill_library_update` (human review gate); bundled skills like
  this one cannot be self-modified — present those lessons inline instead.

## Rules

- **Real subagent generation is mandatory** — the trajectory must contain
  the `task` dispatches and their structured results; missing either means
  stage 1 did not happen.
- Elo math via `tournament_rank` only, never hand-computed.
- Novelty claims require counter-evidence retrieval; "nobody has done this"
  without it is invalid.
- Evidence grading is three-tiered: direct evidence / indirect inference /
  speculation — never blur the tiers.
- Ruled-out candidates are disclosed to the user with reasons.

## Pre-finish self-audit

Before the final answer, verify (and fix before delivering):
- [ ] Stage-1 candidates came from real `task` subagent dispatches, not
      self-invention.
- [ ] The Elo table came from a `tournament_rank` call — no hand-computed
      scores.
- [ ] Every candidate carries its evidence tier and anchor; unsupported
      claims are in the speculation zone.
- [ ] Ruled-out candidates and open questions are disclosed.
For high-stakes runs, also call `review_checkpoint` after declaring the
report artifact — it reviews the locked artifact's citations and
evidence-linked numbers (it is not a process audit).

## Boundaries and honesty

- Elo ranks *your verdict records*, not objective truth — verdict quality
  determines ranking quality; the stage-0 criteria must be explicit.
- The tournament is a heuristic tool; the winner is not "the correct answer"
  — say so in the output.
