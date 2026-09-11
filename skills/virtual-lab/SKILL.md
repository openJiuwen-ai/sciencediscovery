---
name: virtual-lab
description: Use this skill when the user poses a complex open question that needs repeated deliberation across multiple expert perspectives and conclusions hardened under sustained criticism (plan reviews, major decisions with multi-party trade-offs, "organize an expert panel to discuss this", "pressure-test this plan over several rounds"). Provides the Virtual-Lab meeting protocol — a PI (you) chairing heterogeneous expert agents in lab-meeting rounds with a standing Critic, optional individual meetings for deep dives, semantic convergence signals instead of fixed round counts, and a resolution with a point-by-point Critic-response table. For generate-then-rank tournaments see hypothesis-tournament; for dependency-ordered pipelines see robin-chain; for multi-generation deepening see tree-search.
metadata:
  pre-finish-audit: "true"
---

# Virtual Lab (meeting-style multi-agent organization)

After the Virtual Lab (2025): a PI agent chairs, a heterogeneous expert team
is assembled per question, rounds of **lab meetings** (plenary deliberation)
drive progress, a **standing Critic** finds flaws every round, and
**individual meetings** (single-expert deep dives) happen as needed; the user
gives only high-level direction feedback. You (the main agent) play the PI.

Core disciplines: **real multi-agent deliberation (never simulate the
perspectives yourself), the Critic is standing and every criticism gets a
pointed response, convergence is judged by semantic signals not fixed round
counts, and expert roles are assembled per question — never preloaded.**

> Every phase should involve tool calls. Agendas, round progress, and open
> criticisms live in the `research_state` world model — recoverable after
> compaction or interruption.

## Stage 0: Agenda and team assembly (PI duties)

- Clarify the deliberation goal and the **resolution form** (what the final
  output is: a plan, a decision list, a set of conditioned conclusions).
- `research_state(set-goal)` pins the agenda; `plan-add` breaks out the
  deliberation stages.
- Assemble **3-5 heterogeneous expert roles** per the question: each has a
  distinct expertise dimension and stance tendency (e.g. conservative
  verification vs aggressive extrapolation vs engineering feasibility vs
  data evidence). Perspectives must genuinely diverge — not one stance in
  five phrasings.
- Add a **standing Critic**: never proposes; its only job is finding
  flaws — methodological defects, evidence gaps, overclaims, unconsidered
  alternative explanations.
- Briefly tell the user the agenda and team composition (the user can
  redirect at any time — the Virtual Lab's "human ~1% feedback" channel).
  **Checkpoint (conversational)**: wait for the user's go-ahead before the
  first meeting round.

## Stage 1: Lab-meeting rounds (plenary deliberation)

Each round has **one explicit agenda item** (set by you — e.g. "initial
positions on the draft" → "methodology risk cross-examination" → "resource
and feasibility check"). Dispatch the full panel with the `task` tool (all
calls in one turn so they run concurrently):

- One `task` per expert + the Critic (each with isolated context and its own
  stance in `brief`).
- Each expert's brief carries: this round's agenda, the previous round's
  resolution summary and open criticisms, their role stance, and evidence
  requirements (anchor in-KB evidence when a KB is bound; label external
  sources when web tools are available).
- The Critic's brief demands a **classified criticism list**: each criticism
  categorized as "methodological defect / evidence gap / overclaim /
  alternative explanation", pointing at a specific claim — vague "looks fine
  overall" remarks are not accepted.
- **Never play an expert or the Critic yourself** — same-context simulated
  perspectives are same-source and the deliberation loses independent
  friction.
- **Cross-examination round**: after collecting the positions, dispatch a
  second round where each participant's brief includes the other members'
  position summaries, asking them to absorb omissions, address
  disagreements, and strengthen their position while staying in role.

## Stage 2: PI synthesis + point-by-point Critic response

After the round's results return, two mandatory outputs:

1. **Round synthesis**: each side's core positions, friction points, partial
   consensus reached.
2. **Critic-response table** (hard requirement): every single Critic
   criticism gets a disposition —
   - **Accepted**: what changed because of it (which claim was modified);
   - **Rebutted**: the reason (counter-evidence, the criticism rests on a
     misunderstanding, cost trade-off).
   - Silently ignoring a Critic point is this pattern's cardinal sin.

**Convergence judgment** (semantic signals, not round counting):
- A round produced **no new substantive positions** (parties repeating
  established stances) AND the Critic raised **no new criticisms** (only
  restating already-answered ones) → converge, go to stage 4.
- Otherwise → set the next round's agenda (it must follow from open
  criticisms and friction points, not re-open the previous round), back to
  stage 1. Register each round's agenda and open criticisms with
  `research_state(question-add / plan-update)` so compaction cannot lose
  the thread.

## Stage 3 (as needed): Individual meetings

When an issue needs one role's depth (a technical detail check, a data
feasibility confirmation), skip the plenary — deep-dive with that expert via
a single `task` dispatch:

- The brief states: background (deliberation progress so far), the specific
  question to resolve, and the expected output form.
- For structured conclusions, set `brief.outputJsonSchema` (validated,
  fail-open — inspect failures manually before adopting).
- Bring the outcome into the next lab meeting's agenda context, or merge it
  into the resolution directly (noting the source).

## Stage 4: Resolution

- **Resolution section** in the final answer: the final resolution, each
  claim's support/opposition points, the Critic-response table
  (point-by-point), and unresolved disagreements listed honestly.
- **Full minutes** persisted as a workspace file (agendas per round,
  position evolution, criticisms and responses, the resolution and leftover
  issues — the process is part of the deliverable); register it with
  `declare_artifact`.
- Key claims' evidence anchors are registered in `evidence_ledger(add)`
  (in-KB evidence labeled with document names, external evidence labeled
  with source + "not in KB").

## Rules

- Experts and the Critic must be real independent subagents (`task`
  dispatches); the PI never speaks for them or pre-writes their conclusions.
- Critic criticisms enter the response table unfiltered; the PI may rebut
  but must give reasons.
- No fixed round count; the convergence signal is "one full round with no
  new substantive positions and no new criticisms"; the user's mid-course
  redirection always takes precedence.
- Expert roles are assembled per question — this skill preloads no domain
  roles; role count scales with question complexity.
- Unresolved disagreements are never force-merged — present each side's
  position and evidence side by side.

## Pre-finish self-audit

- [ ] Every participant's positions came from real `task` results.
- [ ] The Critic-response table covers every criticism, each with a
      disposition and reason.
- [ ] Unresolved disagreements are presented, not smoothed over.
For high-stakes resolutions, call `review_checkpoint` after declaring the
minutes artifact — it reviews the locked artifact's citations and
evidence-linked numbers (it is not a process audit).
