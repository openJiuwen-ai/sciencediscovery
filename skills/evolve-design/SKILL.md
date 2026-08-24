---
name: evolve-design
description: Use when the user wants to improve something by repeated search rather than one edit — a program, a prompt, a document, a pipeline, a configuration, an experimental protocol. Triggers on `/evolve`, "把这个做得更好", "搜索一个更好的方案", or any request to optimise against a measurable target. Walks through agreeing what "better" means, verifies the scoring can rank candidates, then calls `create_evolve_run`. Not for a single fix, a refactor, or a question about existing code.
metadata:
  version: 2.0.0
---

# Designing an evolution search

A search rewrites a candidate dozens of times and keeps what scores higher. The candidate can be
anything text-shaped: a function, a whole program, a prompt, a report section, a config file, a
protocol. It succeeds or fails on whether the scoring can tell a good candidate from a bad one —
scoring that cannot shows up as a flat run, not as an error.

**Work in steps.** Ask, write files, run them, then decide the numbers. Do not design the whole
thing in one thinking pass: a turn spent planning it all produces no candidate and no result.

## 1. Ask

Read what is free first — this conversation, the workspace, science memory. Then say back what
you understood and ask for what is missing, all at once. If the user says "you decide", decide
and state the defaults.

1. **What "better" means, measurably.** "More accurate" — which error measure? "Less
   AI-sounding" — which specific tic? "Cleaner protocol" — fewer steps, or fewer failure modes?
   The criterion must separate the complaint from its opposite. "Well-structured and readable"
   fails: it is true of any document.
2. **What must not change.** Inputs unavailable at the time the thing actually runs, files that
   define the score, hard limits (budget, runtime, memory, safety constraints).
3. **The starting point.** Use what is in the workspace. Otherwise write **the most boring thing
   that works** — a dozen lines, no tuning, no edge cases. A strong seed is not an advantage: it
   spends the search space before the search begins.

## 2. Verify the scoring with `run_python`

Before calling `create_evolve_run`:

| Check | How | Failure |
|---|---|---|
| It runs | Score the starting point | Raises, missing dep |
| It discriminates | Score a **deliberately broken** copy (gut the logic, return a constant, replace the text with filler) | Same score twice |
| There is slope | Look at the starting score | 0 is a floor, solved is a ceiling. **Aim 0.3–0.7** |

The server runs the same probe and refuses on failure, so skipping this only delays the finding
until after the budget is spent.

The evaluator must survive bad candidates: wrap each case in try/except and count it wrong. If
the script itself crashes, nothing runs.

## 3. Size it

1. **What is one unit?** Whatever one measurement consumes: rows, a test case, a document
   section, one input scenario, one grading pass.
2. **How big must one be to be stable?** Enough that the same candidate scores the same twice.
   Averaged measures get noisier as units shrink; a unit holding a single item is almost always
   too small.
3. **How many held out?** Deterministic scoring 4–6 units; anything with randomness 8–12. Too
   few misreads noise as improvement — silently, for the whole run.
4. **Does the candidate learn from data?** If it fits before it produces, the fitting volume
   must match the evaluation volume. Skip when nothing is fitted.

If the total will not fit, shrink each unit — do not cut held-out or fitting data.

`expansions` must be at least `4 × workers`, or the first sweep forks only the root and the tree
is flat. Expansions by search space: a known defect 4–6; swapping approach or restructuring
12–20; writing something from scratch 20+.

**Thinking off unless asked** — with it on, one whole-candidate rewrite can exceed the proxy
limit and return nothing.

## 4. Pick a scoring mode

By what you have to judge with, not by what the task resembles:

- **A table of known answers and a number to improve** → `dataset_metric`. Deterministic and
  cheapest. Metrics: accuracy / mae / r2 / rmse / seconds; larger-is-better after normalisation.
- **Correctness defined by a test command** → `test_gate`. `frozenGlobs` **must** include the
  test paths, or the shortest path to a higher score is to weaken the tests. Shards ≤ half the
  case count.
- **Deterministic, but no table and no test suite** → `custom_script`, which you write. This is
  the general case and covers most non-tabular work: simulations, parsers, generated
  configuration, anything you can check by running it. Contract: import the candidate as
  `candidate`; score only the shards in `SCIENCE_AGENT_SHARDS` (comma-separated); write
  `{"valid": true, "metrics": {"score": 0.83}}` to the path in `SCIENCE_AGENT_RESULT` (a file,
  not stdout — the candidate prints too); score 0–1, larger-is-better. The module docstring is
  the contract the search sees when rewriting candidates. Write the `error` field even when
  valid — it is the feedback channel to the improving model.
- **Only another model can judge it** → `llm_judge`. For prose, explanations, and anything whose
  quality is a reading. Most gameable and the only non-deterministic option; ask once whether it
  could be a `custom_script` instead.

**Score on a gradient, not a cliff.** For hard limits prefer "stop and score what you have" over
"violation scores zero" — zeroing lands every failure on the same 0 and leaves nothing to climb.

**Never reward a property the candidate can fake.** Rewarding "gives specific numbers" produces
invented numbers; reward agreement with the given source instead.

## 5. Environment

Candidates get numpy / pandas / scipy / sklearn and the standard library. Anything else goes in
`packages` — **bare names only** (optionally `==version`), no paths, URLs, or pip options. Your
`run_python` environment and the candidate sandbox are not the same.

## 6. Call it, then report

`howScored` is **one sentence** for the user: what it measures, how much is held out.

`risks`: at most two, only ones that change a decision. Empty is fine.

After the tool returns, say the result in the conversation: the probe's two numbers and how the
search will proceed. The search is asynchronous; when the user asks later, call `get_evolve_run`
and report actual numbers rather than promising an improvement.

A refusal is design feedback. "Cannot discriminate" means the scoring needs harder cases or a
more mechanical rubric; "no slope" means the starting point is too strong. Fix it and call again
— do not hand the user the server's refusal text as a work order.
