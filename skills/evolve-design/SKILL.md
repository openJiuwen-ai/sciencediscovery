---
name: evolve-design
description: Use when the user wants to improve something by repeated search rather than one edit — a program, a prompt, a document, a pipeline, a configuration, an experimental protocol. Triggers on `/evolve`, "把这个做得更好", "搜索一个更好的方案", or any request to optimise against a measurable target. Runs a short checkpointed design conversation, verifies the scoring can rank candidates, then calls `create_evolve_run`. Not for a single fix, a refactor, or a question about existing code.
metadata:
  version: 1.0.0
---

# Designing an evolution search

A search rewrites a candidate dozens of times and keeps what scores higher. The candidate can be
anything text-shaped: a function, a whole program, a prompt, a report section, a config file, a
protocol. It succeeds or fails on whether the scoring can tell a good candidate from a bad one —
scoring that cannot shows up as a flat run, not as an error.

## How to run this

Four checkpoints. **Do the work for a step, show the result, wait for the user, then go on.**

A checkpoint is a glance, not a form. Show a few lines they can wave through — never a list of
fields to fill in. Recommend a default for every open question so "looks right" is always a
valid answer. Do the work between checkpoints yourself; do not narrate it.

If the user says "you decide" or "just go", state your choices for the remaining steps in one
message and run them without stopping. If they correct something, apply it and re-show that
step only.

Do not design the whole thing in one thinking pass. Ask, write files, run them, then decide the
numbers — a turn spent planning it all produces no candidate and no result.

---

## Step 1 — Agree what "better" means

Read what is free first: this conversation, the workspace, science memory.

Settle three things:

1. **The measurable criterion.** "More accurate" — which error measure? "Less AI-sounding" —
   which specific tic? "Cleaner protocol" — fewer steps, or fewer failure modes? It must separate
   the complaint from its opposite. "Well-structured and readable" fails: true of any document.
2. **What must not change.** Inputs unavailable when the thing actually runs, files that define
   the score, hard limits (budget, runtime, memory, safety).
3. **The starting point.** Use what is in the workspace. Otherwise write **the most boring thing
   that works** — a dozen lines, no tuning, no edge cases. A strong seed is not an advantage: it
   spends the search space before the search begins.

> **Checkpoint 1.** Say back, in a few lines: what will be measured, what is frozen, and what
> the starting point is. Ask only for what you genuinely could not infer — all of it at once.

## Step 2 — Build and prove the scoring

Write the starting point and the evaluator, then use `run_python` to check three things:

| Check | How | Failure |
|---|---|---|
| It runs | Score the starting point | Raises, missing dep |
| It discriminates | Score a **deliberately broken** copy (gut the logic, return a constant, replace the text with filler) | Same score twice |
| There is slope | Look at the starting score | 0 is a floor, solved is a ceiling. **Aim 0.3–0.7** |

The evaluator must survive bad candidates: wrap each case in try/except and count it wrong. If
the script itself crashes, nothing runs.

The server runs the same probe and refuses on failure, so skipping this only moves the discovery
to after the budget is spent.

> **Checkpoint 2.** Show the three numbers — starting point, broken copy, and whether it ran —
> and one sentence on what the scoring rewards. This is where a criterion that measures the
> wrong thing gets caught, so make it easy to disagree with: name what a candidate could do to
> score higher, and let the user say whether that is actually what they want.

## Step 3 — Size the run

1. **What is one unit?** Whatever one measurement consumes: rows, a test case, a document
   section, one input scenario, one grading pass.
2. **How big must one be to be stable?** Enough that the same candidate scores the same twice.
   Averaged measures get noisier as units shrink; a unit holding a single item is nearly always
   too small.
3. **How many held out?** Deterministic scoring 4–6 units; anything with randomness 8–12. Too
   few misreads noise as improvement — silently, for the whole run.
4. **Does the candidate learn from data?** If it fits before it produces, the fitting volume
   must match the evaluation volume. Skip when nothing is fitted.

If the total will not fit, shrink each unit — do not cut held-out or fitting data.

`expansions` must be at least `4 × workers`, or the first sweep forks only the root and the tree
is flat. By search space: a known defect 4–6; swapping approach or restructuring 12–20; writing
something from scratch 20+.

**Thinking off unless asked** — with it on, one whole-candidate rewrite can exceed the proxy
limit and return nothing.

> **Checkpoint 3.** Show the shape in a few lines: what one unit is, how much is held out, how
> many expansions with how many workers, and roughly what that costs in time and model calls.
> This is the last point before real money is spent — say so plainly, and default to the smaller
> option when unsure.

## Step 4 — Start it, then report

Call `create_evolve_run`.

`howScored` is **one sentence** for the user: what it measures, how much is held out.
`risks`: at most two, only ones that change a decision. Empty is fine.

> **Checkpoint 4.** Report what came back: the probe's two numbers and how the search will
> proceed. The search is asynchronous and its card appears in the session. When the user asks
> later, call `get_evolve_run` and report the actual numbers — never promise an improvement you
> have not read.

A refusal is design feedback, not an error. "Cannot discriminate" means the scoring needs harder
cases or a more mechanical rubric; "no slope" means the starting point is too strong. Fix it and
call again — do not hand the user the server's refusal text as a work order.

---

## Choosing a scoring mode (during step 2)

By what you have to judge with, not by what the task resembles:

- **A table of known answers and a number to improve** → `dataset_metric`. Deterministic and
  cheapest. Metrics: accuracy / mae / r2 / rmse / seconds; larger-is-better after normalisation.
- **Correctness defined by a test command** → `test_gate`. `frozenGlobs` **must** include the
  test paths, or the shortest path to a higher score is to weaken the tests. Shards ≤ half the
  case count.
- **Deterministic, but no table and no test suite** → `custom_script`, which you write. The
  general case: simulations, parsers, generated configuration, anything you can check by running
  it. Contract: import the candidate as `candidate`; score only the shards in
  `SCIENCE_AGENT_SHARDS` (comma-separated); write `{"valid": true, "metrics": {"score": 0.83}}`
  to the path in `SCIENCE_AGENT_RESULT` (a file, not stdout — the candidate prints too); score
  0–1, larger-is-better. The module docstring is the contract the search sees when rewriting
  candidates. Write the `error` field even when valid — it is the feedback channel to the
  improving model.
- **Only another model can judge it** → `llm_judge`. For prose, explanations, anything whose
  quality is a reading. Most gameable and the only non-deterministic option; ask once whether it
  could be a `custom_script` instead.

**Score on a gradient, not a cliff.** For hard limits prefer "stop and score what you have" over
"violation scores zero" — zeroing lands every failure on the same 0 and leaves nothing to climb.

**Never reward a property the candidate can fake.** Rewarding "gives specific numbers" produces
invented numbers; reward agreement with the given source instead.

## Environment

Candidates get numpy / pandas / scipy / sklearn and the standard library. Anything else goes in
`packages` — **bare names only** (optionally `==version`), no paths, URLs, or pip options. Your
`run_python` environment and the candidate sandbox are not the same.
