---
name: evolve-design
description: Use when the user wants to improve something by repeated search rather than one edit — a program, a prompt, a document, a pipeline, a configuration, an experimental protocol. Triggers on `/evolve-design`, "把这个做得更好", "搜索一个更好的方案", or any request to optimise against a measurable target. Runs a short checkpointed design conversation, verifies the scoring can rank candidates, then calls `create_evolve_run`. Not for a single fix, a refactor, or a question about existing code.
metadata:
  version: 1.3.0
---

# Designing an evolution search

A search rewrites a candidate dozens of times and keeps what scores higher. The candidate can be
anything text-shaped: a function, a whole program, a prompt, a report section, a config file, a
protocol. It succeeds or fails on whether the scoring can tell a good candidate from a bad one —
scoring that cannot shows up as a flat run, not as an error.

## How to run this

**Algorithm first.** The user's `/evolve-design` command may carry `--algorithm puct` or
`--algorithm openevolve`; if unset, ask. PUCT ranks candidates over a tree, OpenEvolve over
MAP-Elites islands. The four steps and the four scoring modes are identical for both, so design
the scorecard, the split and the starting point the same way and only set `algorithm` in
`create_evolve_run`.

**Pace second.** The command may carry `--no-confirm`, which means the user has chosen to let the
design and the launch run in one pass: do steps 1–4 yourself, without stopping for a reply between
them, and set `checkpointMode: "auto"` in `create_evolve_run`. Still show each checkpoint's result
as it happens — its card, marked `pace: auto` — because the user is watching the conversation
and will read them; you just do not wait. Checkpoint 3's cost summary is not skipped:
say what the run will spend before you spend it. Absolute blockers still stop and ask: a dataset
that is missing, a goal no default can settle, an approval you cannot give on the user's behalf.
If the user says stop or asks a question mid-run, stop at the next step and answer. Without the
flag, confirm at every checkpoint as described below.

Read the command's flags as the run of them directly after `/evolve-design`. A goal that itself
begins with `--` is written on its own line, after a line break: the break ends the flags, and
everything after it is the goal, dashes included.

**Isolation last, and never assumed.** Windows has neither bubblewrap nor Seatbelt. There, the
desktop can run candidates unconfined, but only for a run the user approved: the command then
carries `--allow-direct`, written by the setup dialog when the user turned the warning on. Pass
`allowUnisolated: true` **only** when the command carries it. Without it the server refuses the
run — correctly, because the candidate would run with the user's own file and network access.
Never add it to make a refusal go away, and never say the run is sandboxed when it is not.

Four checkpoints, numbered 1 to 4. **Do the work for a step, show the result, wait for the user,
then go on.** A checkpoint is a glance, not a form: a few lines they can wave through, with a
recommended default for every open question so "looks right" is always a valid answer. Do the work
between checkpoints yourself; do not narrate it. Each step is shown exactly once, in order: a
confirmed step is behind you, and re-emitting it asks a question the user has already answered —
two cards with the same number, and neither of them clearly the live one.

## How a checkpoint is written

Every checkpoint is one card, not prose. The card is a fenced block tagged `evolve-checkpoint`
— exactly that tag, not the skill's name `evolve-design` — with a short header, a `---` line,
then the checkpoint's own words. It is the **last** thing in the message, in place of the lines
it describes.

```evolve-checkpoint
step: 1
total: 4
pace: confirm
title: 什么算“更好”
---
**度量：** 压缩比 …

**冻结：** …

**起点：** …
```

- `step` and `total` number the four checkpoints. The card prints them, so do not repeat
  "Checkpoint 1" in the title.
- `title` is the question this step is asking, in one line, in the user's language.
- `pace` is `confirm` when you are waiting for a reply, and `auto` when the command carried
  `--no-confirm`. In auto the card records a step that did not wait; there is no reply to read.
  **Checkpoint 4 is always `auto`**, whatever pace the command asked for: by the time that card
  is written the search is already running, and buttons there ask the user to confirm something
  that has already happened.
- The prose after `---` is the checkpoint itself — the few lines described below, in Markdown.
  Keep it to what they must read to answer; the work behind it is not narrated.
- Never open a bare fence inside the card. If the body needs a code block, give it an info string
  (`text`, `yaml`, `json`) and close it with its own fence **before** the card's closing fence.
  Two fences close a block, three close a block and the card. An untagged fence ends the card
  early: the reader sees half a card, a stray code block, and raw `**` from everything after it.
- Nothing may follow the fence in that message. A partial or malformed block is shown as a code
  block instead of a card, and text after a card reads like an afterthought. In auto, the card
  closes that message and you go on with the next step.
- Do not also write the checkpoint as prose. A client that does not draw cards shows this block
  as code — header and all — which is why it is plain `key: value` lines over readable prose
  rather than JSON.

Write the card once, when the step is done — not while you are still working on it.

The card's confirm button answers with the step it confirms: 「确认检查点 N/4，继续。」 or, when the
client's language is English, "Confirm checkpoint N/4, continue." Treat that as an answer to that
step and nothing else — continue from it, and do not show the step again.

In auto the client keeps the flow moving: when a turn ends on an auto card before step 4, it sends
「继续步骤 N/4。」 or "Continue with step N/4.". That is not a new instruction and not a
confirmation — the step is recorded and the next one is due. Continue from it, do not show that
card again, and do not answer it as if the user had asked something. Better still, do not end a
turn on an auto card at all: do the next step's work in the same turn whenever you can.

Both sentences are the client's, not the user's, and they come in the **client's** language, which
need not be the conversation's: a Chinese conversation can receive the English form. Read them by
their step number — the only part that is fixed — and continue in the language you have been
writing in.

If the user says "you decide" or "just go", state your choices for the remaining steps in one
message and run them without stopping. If they correct something, apply it and re-show that step
only, with `修订：` at the start of its title, so the second card reads as a revision rather than a
step that came back.

Do not design the whole thing in one thinking pass. Ask (when confirming), write files, run them,
then decide the numbers — a turn spent planning it all produces no candidate and no result. Auto
changes only whether you wait between steps, never whether the work between them happens.

---

## Step 1 — Agree what "better" means

Read what is free first: this conversation, the workspace, science memory. Settle three things:

1. **The measurable criterion.** "More accurate" — which error measure? "Less AI-sounding" —
   which specific tic? It must separate the complaint from its opposite: "well-structured and
   readable" fails, because it is true of any document.
2. **What must not change.** Inputs unavailable when the thing actually runs, files that define
   the score, hard limits (budget, runtime, memory, safety).
3. **The starting point.** Use what is in the workspace. Otherwise write **the simplest thing that
   already does the job badly** — a dozen lines, no tuning, no edge cases. A strong seed spends
   the search space before the search begins.

   But simplest *of the right kind*: the seed must contain the mechanism the search is meant to
   improve, in its feeblest form. A seed with no mechanism makes every candidate invent one from
   nothing, and from-scratch code fails far more often than an edit. Measured: a compression task
   seeded with identity encoding spent ten expansions on whole compressors written from scratch,
   seven of which did not run; seed the RLE, not the identity function. A good seed is necessary,
   not sufficient — candidates may still replace the whole mechanism.

   **Do not steer by naming the mechanism.** "Add a longer match window to the existing RLE" takes
   the search's own job away and leaves the run tuning your algorithm. The task says what "better"
   is measured as, never which approach reaches it. A run that finds nothing above the seed is a
   *result*. What is yours to reconsider is the **scoring** — do the cases reward what you care
   about, is the corpus wide enough to separate approaches — not the approach you would like.

> **Checkpoint 1** (`step: 1`). Say back, in the card: what will be measured, what is frozen, and
> what the starting point is. Ask only for what you genuinely could not infer — all of it at once.

## Step 2 — Build the scoring; the probe proves it

Write the starting point and the evaluator, then run the evaluator **once**, against the starting
point, with `run_shell` (for example `python evaluator.py`, selecting a Python-capable
`environment_id`). You are checking that it executes and emits a number — a typo, a missing
import, a result file never written. That is the whole of the local check.

**Do not score a broken copy locally.** The server's discrimination probe does exactly that, on
the real shards in the real sandbox, and hands you both numbers when the run starts. Your
`run_shell` environment and the candidate sandbox are different places with different shard
indices, so the numbers can legitimately differ (one session saw local 0.3853, server 0.0000, and
spent the turn reconciling them). **When they disagree, the server's is true** — do not
investigate the gap. A probe refusal costs four sandbox evaluations and no model calls, so it is
cheap to be wrong here.

Aim for a starting point in **0.3–0.7**: 0 is a floor, solved is a ceiling. The probe reports
where it actually landed.

**The evaluator must survive bad candidates — including at import.** Most candidates are broken,
and the probe deliberately scores a broken one. Guard `import candidate` itself (a hollowed-out
module can leave a name as `None` or raise before any per-case `try/except` can reach it) and
each individual call. On an import failure score every shard **worst**: 0.0 on a larger-is-better
scale, not 1.0 — an inverted guard made one live run's winner a module that does not load, at a
perfect 1.0000. It is the evaluator that must be robust, never the candidate. If the script
itself crashes, nothing runs and the whole run is refused.

**You are checking the ruler, not looking for the answer.** Do not go looking for a candidate that
beats the starting point — that is the search's entire job, done by hand at the cost of the turn,
and succeeding is worse than failing: you then throw the answer away or seed it, and a strong seed
spends the search space. A starting point no obvious variation beats is a *good* one.

> **Checkpoint 2** (`step: 2`). Show one number — what the starting point scored — plus whether
> the evaluator ran, and one sentence on what the scoring rewards. This is where a criterion that
> measures the wrong thing gets caught, so make it easy to disagree: name what a candidate could
> do to score higher, and let the user say whether that is what they want.

## Step 3 — Size the run

1. **What is one unit?** Whatever one measurement consumes: rows, a test case, a document
   section, one input scenario, one grading pass.
2. **How big must one be to be stable?** Enough that the same candidate scores the same twice.
   A single item is worse than noisy: it makes the unit **binary**, and the search skips proposing
   on a unit it already solves, so every unit at full marks spends an expansion and yields no
   candidate (measured: one record per unit, eleven of sixteen at 1.0, a run planned for 20
   expansions made 5). Put enough in one unit that a good candidate lands between the floor and
   the ceiling — a few dozen items averaged, not one.
3. **How many in the gate — and make it the biggest of the three.** Every candidate's score, the
   one the tree ranks and selects on, is measured on the **gate**. Too few and the tree ranks on
   noise for the whole run, and the reported improvement does not survive a re-run. Deterministic
   scoring 8–12 units; anything with randomness 16–24. **Rollout** drives the search's own
   trajectory: four or more, never one (five candidates all scoring exactly 0.6000 was one), and
   no more than the gate. **Test** never takes part and is read once at the end: 4–8.
4. **Does the candidate learn from data?** If it fits before it produces, the fitting volume must
   match the evaluation volume. Skip when nothing is fitted.

If the total will not fit, shrink each unit — do not cut the gate, which is the only number the
search steers by.

`expansions` must be at least `4 × workers`, or the first sweep forks only the root and the tree
is flat. By search space: a known defect 4–6; swapping approach or restructuring 12–20; writing
something from scratch 20+. **Thinking off unless asked** — with it on, one whole-candidate
rewrite can exceed the proxy limit and return nothing.

**`search` — leave it out unless this task argues against the defaults.** They are upstream's and
usually right; the parameter descriptions on `create_evolve_run` carry the ranges and what each
does. Set one only for a reason you can give in a line:

- `cPuct` — lower when the gate is large enough to trust and the budget is small; higher when the
  score is noisy or coarse or candidates keep tying. A coarse score is a *scoring* problem first:
  widen the gate before reaching for it.
- `priorExponent` — when the failure you expect is a whole-mechanism rewrite (five of eighteen
  compression candidates replaced a working RLE+Huffman with a from-scratch arithmetic coder, and
  each scored 0). It cannot move the reported score; that comes from held-out shards.

> **Checkpoint 3** (`step: 3`). Show the shape in the card: what one unit is, how much is held
> out, how many expansions with how many workers, and roughly what that costs in time and model
> calls.
> Call `get_evolve_budget` first and read the money line off it — the per-call token ceiling you
> will actually get, times the expansion count, against the run's total token cap. Call it rather
> than guessing: the ceiling depends on whether this endpoint can turn thinking off at all, and
> an endpoint that cannot is priced as a thinking run (96k per call for puct, 128k for
> openevolve) however the run is configured. If the reply says thinking is `enabled` with a note,
> say that to the user in the checkpoint instead of promising "thinking off" — they are approving
> the budget, not the setting. Mention `search` only if you set it, in one line saying why;
> otherwise leave it out. This is the last point before real money is spent — say so plainly, and
> default to the smaller option when unsure. In auto, say it and go on; it is the one checkpoint
> whose numbers the user still sees before the spend, even though it no longer waits for an
> answer.

## Step 4 — Start it, then report

Call `create_evolve_run`. Set `algorithm` to what the user chose, and `checkpointMode` to the pace
the command carried — `"auto"` for `--no-confirm`, `"confirm"` otherwise. Set
`allowUnisolated: true` only when the command carried `--allow-direct`; leave it out otherwise.
`howScored` is **one sentence** for the user: what it measures, how much is held out. `risks`: at
most two, only ones that change a decision; empty is fine.

> **Checkpoint 4** (`step: 4`, `pace: auto`). Report what came back — the probe's two numbers and
> what the search will do — in the card, and then **end the turn**. Do not wait for it, do not call
> `get_evolve_run` to check on it, do not loop. The search runs for minutes to hours; its card
> streams live progress, and sitting on
> the turn shows the user nothing they cannot already see and burns the run's own budget.
> `get_evolve_run` is for **later**, when the user asks how it went — then report the actual
> numbers, never an improvement you have not read.
>
> After this card the design is over. If a message from the user arrives after it, they are asking
> about the run, not restarting the design: call `get_evolve_run` **first** and answer from its
> numbers. Never reopen a step — 3, 2 or 4 — once the run has started; the search is already doing
> what it was going to do, and another card asks for a decision that changes nothing.

A refusal is design feedback, not an error. "Cannot discriminate" means the scoring needs harder
cases or a more mechanical rubric; "no slope" means the starting point is too strong. Fix it and
call again — do not hand the user the server's refusal text as a work order.

---

## Choosing a scoring mode (during step 2)

Take the first that fits. **`custom_script` is the fallback, not the default**: you write and
maintain the measuring apparatus yourself, so every mistake in it is yours. Judge by what the task
*is*, not by what is in the workspace right now — "there is no table yet" is not a reason to skip
`dataset_metric` when the task is to predict a column; write the table, then use it.

- **Cases with known answers, and a number to move** → `dataset_metric`. Deterministic and
  cheapest, and the framework owns the split so you cannot get it wrong. Metrics: accuracy / mae /
  r2 / rmse / seconds.
- **Correctness pinned down by tests** → `test_gate`. Take it whenever the user says "write
  tests", "make these cases pass", or describes behaviour case by case. The failure text is the
  learning signal, and `frozenGlobs` **must** include the test paths, or the shortest way to a
  higher score is to weaken the tests. Shards ≤ half the case count.
- **Neither fits** → `custom_script`, which you write: simulations, optimisation heuristics,
  anything whose quality is a computation with no natural table and no test suite. **Read
  `references/custom-script.md` before writing the evaluator** — it holds the contract, how it
  runs, and the `error` rule the probe enforces (a crash must say *where*, not just what).
- **Only another model can judge it** → `llm_judge`. For prose and explanations, anything whose
  quality is a reading. The most gameable and the only non-deterministic mode; ask once whether it
  could be a `custom_script` instead.

**Score on a gradient, not a cliff.** For hard limits prefer "stop and score what you have" over
"violation scores zero": zeroing lands every failure on the same 0 and leaves nothing to climb.

**Never reward a property the candidate can fake.** Rewarding "gives specific numbers" produces
invented numbers; reward agreement with the given source instead.

## Environment

Candidates get numpy / pandas / scipy / sklearn and the standard library. Anything else goes in
`packages` — **bare names only** (optionally `==version`), no paths, URLs, or pip options. Your
`run_shell` environment and the candidate sandbox are not the same.
