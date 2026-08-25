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
3. **The starting point.** Use what is in the workspace. Otherwise write **the simplest thing
   that already does the job badly** — a dozen lines, no tuning, no edge cases. A strong seed is
   not an advantage: it spends the search space before the search begins.

   But "simplest" means simplest *of the right kind*: the seed has to contain the mechanism the
   search is supposed to improve, in its feeblest form. A seed with no mechanism forces every
   candidate to invent one from nothing, and a from-scratch implementation fails far more often
   than an edit does. Measured on two real runs: a cache task seeded with a working LRU climbed
   0.2218 → 0.9396, its candidates swapping in ARC, LIRS and TinyLFU on top of a policy that was
   already there; a compression task seeded with identity encoding — which "works" and compresses
   nothing — spent ten expansions on whole compressors written from scratch, seven of which did
   not run at all, and finished at 0.226. Seed the RLE, not the identity function.

   **The seed is necessary and not sufficient**, so do not treat this as solved by a good one.
   A later compression run seeded with a working RLE-plus-Huffman at 0.62 still drew eleven
   candidates that each replaced the whole mechanism — arithmetic coding, LZ77, range coding,
   written from nothing in one reply — and ten did not run. The half that was missing was in
   the prompt, not the seed, and is fixed there now.

   **Do not fix it by naming the mechanism.** "Add a longer match window to the existing RLE"
   reads like a helpful narrowing and is the search's own job taken away from it: the human
   picks the algorithm and the run is left tuning it. The objective is the score, always — the
   task says what "better" is measured as, never which approach to reach it by. If a run comes
   back with nothing above the seed, that is a *result*: on this scoring, these variations do
   not beat the starting point. What is legitimately yours to reconsider is the **scoring** —
   whether the cases actually reward what you care about, whether the corpus is wide enough to
   separate approaches — not the approach you would like the candidates to take.

> **Checkpoint 1.** Say back, in a few lines: what will be measured, what is frozen, and what
> the starting point is. Ask only for what you genuinely could not infer — all of it at once.

## Step 2 — Build the scoring; the probe proves it

Write the starting point and the evaluator, then run the evaluator **once**, against the
starting point, with `run_python`. You are checking that the thing you just wrote executes and
emits a number — a typo, a missing import, a result file never written. That is authoring
hygiene, and it is the whole of the local check.

**Do not score a broken copy locally.** The server's discrimination probe does exactly that, on
the real shards, in the real sandbox, and hands you both numbers when the run starts. Doing it
yourself as well buys nothing and costs something real: your `run_python` environment and the
candidate sandbox are different places, and your shard indices are not the ones the run uses, so
the two numbers can legitimately differ. Watched one session where they did — local 0.3853,
server 0.0000 — and the turn went into reconciling them instead of into the search.

**When your local number and the server's disagree, the server's is the one that is true.** It
measured the real thing. Do not investigate the gap; read the server's two numbers and act on
those.

Aim for a starting point in **0.3–0.7**: 0 is a floor and solved is a ceiling. That is a design
target for the seed, not a local measurement to defend — the probe reports where it actually
landed.

**The evaluator must survive bad candidates — including at import.** Most candidates in a search
are broken, and the probe deliberately scores a broken one, so this is the normal path rather
than an edge case. Guard two places: `import candidate` itself (a hollowed-out module can leave
a module-level name as `None` or raise outright, and that happens *before* any case, where a
per-case `try/except` cannot reach it — on failure score every shard **worst**, which on a
larger-is-better scale means 0.0 and not 1.0; a guard written the right shape with the score
inverted makes the search converge on candidates that do not load, and one live run's winner was
exactly that, at a perfect 1.0000), and each individual call. It is the evaluator that has to be robust, never the
candidate: being broken is what the probe's damaged copy is for. If the script itself crashes, nothing
runs and the whole run is refused.

**You are checking the ruler, not looking for the answer.** Do not go looking for a candidate
that beats the starting point — "let me first confirm a better heuristic exists" is the search's
entire job, done by hand, at the cost of the turn. And succeeding is worse than failing: you then
either throw the answer away or seed it, and a strong seed spends the search space before the
search begins. A starting point that no obvious variation beats is a *good* starting point, not a
problem to solve first.

A probe refusal costs four sandbox evaluations and no model calls, so it is cheap to be wrong
here — cheaper than a second local check that can disagree with it.

> **Checkpoint 2.** Show one number — what the starting point scored — plus whether the evaluator
> ran, and one sentence on what the scoring rewards. This is where a criterion that measures the
> wrong thing gets caught, so make it easy to disagree with: name what a candidate could do to
> score higher, and let the user say whether that is actually what they want.

## Step 3 — Size the run

1. **What is one unit?** Whatever one measurement consumes: rows, a test case, a document
   section, one input scenario, one grading pass.
2. **How big must one be to be stable?** Enough that the same candidate scores the same twice.
   Averaged measures get noisier as units shrink; a unit holding a single item is nearly always
   too small.

   A single item is worse than noisy — it makes the unit's score **binary**, and that quietly
   costs expansions. The search skips proposing on a unit it already solves, so every unit
   scoring full marks spends a slot of the run's budget and produces no candidate. Measured: a
   record-matching run whose units held one record each scored 0 or 1 with nothing between,
   eleven of sixteen came out at 1.0, and a run planned for 20 expansions made 5. Put enough in
   one unit that a good candidate lands *between* the floor and the ceiling — a few dozen items
   averaged, not one.
3. **How many in the gate — and make it the biggest of the three.** Every candidate's score,
   the one the tree ranks and selects on, is measured on the **gate** units. Nothing else decides
   which candidate wins. So the gate is where a shortage hurts most: too few and the tree ranks
   on noise, silently, for the whole run, and the improvement it reports does not survive a
   re-run. Deterministic scoring 8–12 units; anything with randomness 16–24. More is better here
   in a way it is not elsewhere.

   Rollout comes next — it drives the search's own trajectory, and one unit means every
   comparison rests on a single measurement. Observed: five candidates, all exactly 0.6000,
   budget spent, no signal. Four or more, never one, and no more than the gate.

   Test is what never takes part at all, read once at the end. 4–8 is plenty; it buys confidence
   in the final number, not progress during the run.
4. **Does the candidate learn from data?** If it fits before it produces, the fitting volume
   must match the evaluation volume. Skip when nothing is fitted.

If the total will not fit, shrink each unit — do not cut the gate. A run that measures a few
units carefully beats one that measures many units badly, and cutting the gate is cutting the
only number the search actually steers by.

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

> **Checkpoint 4.** Report what came back — the probe's two numbers and what the search will do
> — and then **end the turn**. Do not wait for it, do not call `get_evolve_run` to check on it,
> do not loop until it finishes. The search runs for minutes to hours; its card appears in the
> session and the panel behind that card streams live progress, which is where the user watches
> it. Sitting on the turn shows them nothing they cannot already see and burns the run's own
> budget.
>
> `get_evolve_run` is for **later**, when the user asks how it went — then read it and report the
> actual numbers, never an improvement you have not read.

A refusal is design feedback, not an error. "Cannot discriminate" means the scoring needs harder
cases or a more mechanical rubric; "no slope" means the starting point is too strong. Fix it and
call again — do not hand the user the server's refusal text as a work order.

---

## Choosing a scoring mode (during step 2)

Work down this list and take the first that fits. **`custom_script` is the fallback, not the
default** — it is the one where you write and maintain the measuring apparatus yourself, so
every mistake in it is yours. The two above it are cheaper to get right because the framework
already handles the splitting and the freezing.

Judge by what the task *is*, not by what you happen to have in the workspace right now: "there
is no table yet" is not a reason to skip `dataset_metric` when the task is to predict a column —
write the table, then use it.

- **Cases with known answers, and a number to minimise or maximise** → `dataset_metric`.
  Deterministic and cheapest, and the framework owns the split so you cannot get it wrong.
  Metrics: accuracy / mae / r2 / rmse / seconds; larger-is-better after normalisation. Generate
  the data if it does not exist yet — that is still this mode.
- **Correctness pinned down by tests** → `test_gate`. Take it whenever the user says "write
  tests", "make these cases pass", or describes behaviour case by case. The failure text is the
  learning signal, which is richer than a number, and `frozenGlobs` **must** include the test
  paths, or the shortest path to a higher score is to weaken the tests. Shards ≤ half the case
  count.
- **Neither fits** → `custom_script`, which you write. Simulations, optimisation heuristics,
  anything whose quality is a computation with no natural table and no test suite. Contract: import the candidate as `candidate`; score only the shards in
  `SCIENCE_AGENT_SHARDS` (comma-separated); write `{"valid": true, "metrics": {"score": 0.83}}`
  to the path in `SCIENCE_AGENT_RESULT` (a file, not stdout — the candidate prints too); score
  0–1, larger-is-better. The module docstring is the contract the search sees when rewriting
  candidates. **The `error` field is the feedback channel to the model writing the next
  candidate, and for a crash it has to say *where*, not just what.** Use a trimmed
  `traceback.format_exc()`, so the text carries a file and a line — **the probe refuses an
  evaluator that reports an exception without one.** `type(e).__name__` says nothing at all;
  even `repr(e)`, a real message like `ValueError('byte must be in range(0, 256)')`, leaves the
  next author hunting 200 lines for which of a dozen appends it was, so it discards the whole
  approach and re-rolls with a fresh bug. Measured: five candidates crashed in one run, the
  repair pass fired four times and landed once, and two of the five were the same one-line bug
  found from scratch each time. A *semantic* failure needs no line — "round trip does not
  match", "budget exhausted on 3 of 6" — and the gate does not ask for one. Write the field
  even when the candidate is valid; that is how the next one learns to stop.

  **How it runs:** as a script, with `__name__ == "__main__"` (`runpy.run_path`), and the
  scratch directory first on `sys.path`. So top-level code runs, a `if __name__ == "__main__":`
  guard runs, and `import candidate` resolves. You do not need to reverse-engineer this.

  **The evaluator runs alone and reads nothing.** It gets a scratch directory containing itself
  and the candidate — not the workspace, not the file you read while designing, and there is no
  way to ship it one. A shard is an *index*, and what index `i` means is the evaluator's choice:
  it **builds** case `i` — an equation with a known analytic solution, a generated input, a
  corpus drawn from a fixed seed, a property to check. Anything it opens by path fails on every
  candidate. If the material genuinely lives in a file, that is `dataset_metric`, which owns the
  splitting as well.
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
