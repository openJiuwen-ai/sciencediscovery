---
name: tree-search
description: Use this skill when the user asks to deeply explore multiple research paths, iteratively improve/debug/cross hypotheses along branches, and systematically backtrack with replication checks ("explore several directions and pick the best", "deepen these directions generation by generation", "search research plans like a tree", "compare several technical routes in depth and verify stability"). Runs budget-pinned agentic tree search — multi-perspective initial branches via subagents, greedy best-first expansion (improve/debug/crossover operators), pruning, ablation replication, and a held-out-signal final tournament. For flat generate-then-rank see hypothesis-tournament; for graph-whitespace-driven debates see idea-debate (when available).
---

# Agentic Tree Search over Hypotheses

Organize research exploration as a **persistent hypothesis tree**: generate
initial branches from the root question with multiple perspectives, deepen
along branches generation by generation with explicit operators
(improve/debug/crossover), select expansion targets greedy best-first, prune
continuously, and finish with ablation replication plus a final tournament on
held-out signals. Core disciplines: **budget pinned before searching (a
target cap; overrun switches to endgame and is honestly labeled), expansion
goes through real subagents (no self-role-played perspectives), soft-scored
branches contract (no deep exploration without hard verification signals),
and the final ranking uses only held-out endgame signals (internal scores
guide search, they are never the conclusion).**

> Every expansion round should involve tool calls. All tree state (nodes,
> scores, prune archive, open questions) lives in the `research_state` world
> model — it survives context compaction and interruptions.

## Data structure: the tree encoding convention

All tree state lives in `research_state`; full node artifacts live in
workspace files; the two are linked by nodeId:

- **Plan item = tree node**, one-line format:
  `[TREE N07 parent=N03 op=improve depth=2 score=7.5] one-line hypothesis :: tree/N07.md`
- **nodeId** is self-assigned: N00 is the root (the research question),
  N01… increments by creation order — **always reference nodes with the
  zero-padded two-digit id** (`N07`, not `N7`), otherwise substring lookup
  mismatches N70/N71…
- **op ∈ draft | improve | debug | crossover | replicate**: draft = initial
  branch; improve = criticism-absorbing rewrite; debug = repair against a
  falsification point; crossover = hybridize two same-generation high
  scorers; replicate = reproduction node.
- **score**: 0-10, or `-` (unscored). A search-guidance signal, never a
  conclusion.
- **Status mapping**: `pending` = frontier awaiting expansion;
  `in_progress` = being expanded this round (normally ≤2); `done` =
  expanded; `dropped` = pruned (note records the prune reason).
- **ruledOut = falsified/eliminated branch archive**: `what` carries the
  `[TREE Nxx]` prefix, `why` is the evidence pointer (document/retrieval
  result), `source` the review or replication node — dead branches must not
  resurrect.
- **triedActions = operator dedup**: action text like
  `expand N03 improve: <improvement keywords>`; `check-tried` before
  expanding; the same node + operator + improvement point never runs twice.
- **questions = cross-branch open questions**.
- **Node artifacts**: each node's full content (hypothesis + evidence chain +
  analysis) is written to `tree/Nxx.md` in the session workspace (write with
  `run_python`, read with `read_file`); `tree/index.md` maintains the ASCII
  overview tree (score/status per node), rewritten after every round.

## Stage 0: Framing and budget pinning

- Clarify the exploration goal and judging criteria (novelty? feasibility?
  evidence strength? — these weight expansion and endgame verdicts).
- `research_state(set-goal)` pins: goal text + budget parameters + start
  timestamp (ISO); `plan-add` the root node N00
  (`[TREE N00 parent=- op=draft depth=0 score=-]`).
- User overrides in the request (e.g. "budget: 20 nodes / 90 minutes") are
  parsed into the goal note; defaults otherwise:

| Budget parameter | Default | Notes |
|---|---|---|
| Total nodes | ≤12 (incl. root/replication) | Target cap: near it, switch to endgame and label honestly |
| Max depth | ≤4 | Branches without hard verification signals ≤2 |
| Initial width W | 3-4 | Perspective count |
| Expansion branching factor b | 1-2 | Children per node per round |
| Debug chain | ≤2 consecutive | Beyond that, force a prune evaluation |
| Replication seeds | 2-3 | Aggregation must include mean ± variance |
| Wall clock | 60 min | Soft: self-check via summary each round; overrun switches to endgame, not a hard interrupt |

- **Checkpoint (conversational)**: present the goal + budget to the user and
  wait for confirmation before generating initial branches — this is the
  main human-steering entry point.

## Stage 1: Initial branches + feasibility gate

**Mandatory real subagents**: dispatch **3-4 heterogeneous perspective
subagents** with the `task` tool (one turn, concurrent), each producing one
initial branch — **never role-play perspectives in your own context**
(same-context "multi-perspective" output is same-source; all later deepening
loses independence). Give each subagent a `brief` with goal, perspective
stance, and an `outputJsonSchema` for the branch (claim / evidence chain /
falsifiable test / self-assessed risks).

Typical perspectives: evidence-driven (from `gap_candidates` structural
holes/conflicts), mechanistic (causal chains), contrarian (challenges the
mainstream), cross-domain transfer.

Each initial branch passes a **feasibility gate**: `novelty_check`
counter-evidence (when a KB is bound) + cheap evidence verification
(`kb_search`/`web_search` spot-checks of key premises). Gate failures get
`rule-out` + `dropped` (reason recorded); survivors enter the frontier
(`pending`) with a score.

**Completion anchor (self-check)**: the trajectory contains the `task`
dispatches AND `tree/` holds ≥3 `Nxx.md` node artifacts (verify with
`list_files`). Missing either means stage 1 did not happen — self-invented
branches do not count.

## Stage 2: Expansion loop (greedy best-first)

Strictly four steps per round, **exactly one node expanded per round**:

1. **select**: `research_state(summary)` first — check budget (node count vs
   cap, now vs start timestamp, frontier remaining). Pick the highest-score
   `pending` `[TREE` item. Ties break deterministically: shallower depth
   first, then smaller nodeId — **do not call tournament_rank here**; its
   first use is reserved for the endgame so search-time guidance and endgame
   judgment stay strictly separated.
2. **expand**: apply one operator to the selected node — improve (absorb
   criticism into a stronger rewrite) / debug (repair against the
   falsification point) / crossover (hybridize two same-generation high
   scorers into a shared child). `check-tried` first for dedup; dispatch
   1-2 subagents via `task` to produce the full artifact, then write
   `tree/Nxx.md` and `plan-add` the new node (parent/op/depth all set).
3. **evaluate**: **hard verification signals first** — executable analyses
   (statistical checks, data cross-checks via `run_python`) produce hard
   scores; without a hard signal use critic-review soft scores, and **that
   branch contracts to width ≤2 and depth ≤2** (deep soft-scored branches
   invite reward hacking: review scores self-inflate with depth). Write the
   score back to the node and the artifact header.
4. **prune**: nodes below threshold or falsified become `dropped` +
   `rule-out` (note the reason); **a debug chain failing twice in a row
   forces pruning**; after expansion completes, set the parent `done` to
   free the active slot; rewrite `tree/index.md`.

**Termination** (any): node budget exhausted / wall clock exhausted /
frontier empty. If ≥2 high-score nodes remain, go to stage 3; otherwise
straight to stage 4 (a single node needs no ablation comparison — say so in
the output).

## Stage 3: Ablation and replication (the rigor floor)

For each of the top K=2-3 nodes, dispatch **replication nodes**
(op=replicate: rerun the same analysis with a different seed/sample) via
parallel `task` subagents; aggregate in the main context into an aggregation
node whose artifact **must include mean ± variance**.

Branches whose replication fails (excessive variance / flipped conclusion)
are downgraded and labeled `[unstable]` — recorded in the node note and the
final output. Instability is never hidden.

## Stage 4: Endgame selection (held-out signals only)

Head nodes are judged pairwise on **held-out signals**: data slices not used
during search, literature sources not yet consulted, confirmatory
re-tests — **never stage-2 internal scores** (search-time scores are
overfit by the search process itself; internally high-reward nodes do not
necessarily win under independent evaluation).

Feed all verdicts at once to `tournament_rank(action="rank")` (items = head
node labels, matches = pairwise verdicts) — ranking math by the tool, never
by hand. Archive the verdicts in `evidence_ledger` or a workspace file
(auditable).

**Pinned rule: the final ranking is produced only by this stage's held-out
verdicts; stage-2 internal scores guide search and must not be cited as the
final basis.**

## Stage 5: Output + meta-review

Final answer contains:
- **ASCII overview tree**: node ids / operators / scores / statuses (pruned
  branches marked).
- **Endgame table**: head nodes (one-line claim), final ranks, replication
  stability (mean ± variance / `[unstable]`).
- **Honest boundaries**: the internal-score vs held-out-signal distinction;
  pruned branches with reasons; open questions.
- Node artifacts are persisted under `tree/` in the workspace with
  `index.md` as the entry point; register the final report with
  `declare_artifact`.

Then distill **patterns, not anecdotes** (which operators yielded the most
gain, which branch types systematically die at which depth, whether the
budget split was right) into the final answer; reusable lessons targeting a
user-level skill go through `propose_skill_library_update` (human review
gate). Bundled skills like this one cannot be self-modified.

## Rules

- Every expansion round must have `task` dispatches in the trajectory and a
  corresponding new node artifact under `tree/` (checkable via `list_files`)
  — missing either means the round did not happen; redo it.
- **Every round starts with `research_state(summary)` budget self-check** —
  on overrun switch to endgame immediately; never keep expanding.
- **No self-role-played perspectives** — initial generation and every
  expansion's subtasks come from real `task` subagents.
- **Branches without hard verification signals contract to width ≤2, depth
  ≤2**; debug chains failing twice are force-pruned.
- **The final ranking comes only from stage-4 held-out verdicts** — internal
  scores guide search only; `tournament_rank`'s first call is reserved for
  the endgame.
- Node-artifact one-to-one correspondence: every `[TREE` plan item has its
  `tree/Nxx.md` — no ghost nodes, no missing artifacts.
- Pruned/falsified branches are disclosed to the user — what was cut and
  why (the rule-out archive prevents resurrection).

## Pre-finish self-audit

Before the final answer, verify (and fix before delivering):
- [ ] Node–artifact consistency both directions (plan `[TREE` items ↔
      `tree/Nxx.md` files).
- [ ] The final ranking came from a `tournament_rank` call on held-out
      verdicts — no hand-computed scores, no internal scores cited as final.
- [ ] Replication aggregates include mean ± variance; `[unstable]` labels
      present where due.
- [ ] Budget compliance stated; overruns labeled.
For high-stakes runs, also call `review_checkpoint` after declaring the
report artifact — it reviews the locked artifact's citations and
evidence-linked numbers (it is not a process audit).

## Boundaries and honesty

- Tree search is systematic exploration; the endgame champion is not "the
  correct answer" — it is the best branch under the given budget and
  held-out signals. Say so in the output.
- Internal (soft) scores are search heuristics that drift with reviewer
  stance; only hard verification signals and endgame held-out signals may
  ground conclusions.
- Replication failures, `[unstable]` downgrades, and budget overruns are
  always shown — never hidden for a prettier picture.
- Evidence grading is three-tiered: direct evidence / indirect inference /
  speculation — never blur the tiers.
