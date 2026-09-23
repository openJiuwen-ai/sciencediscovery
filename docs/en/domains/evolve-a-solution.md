# Evolve a solution

**About 15 minutes of your attention, plus the search's own running time.**

In this tutorial you start a program-evolution search, answer the four design checkpoints, watch
it run, and judge whether the result is real. You will end with two versions of one artifact — the
starting point and a better version of it — and a held-out number that says how much better.

Before starting: finish the [Quick Start](../getting-started/quick-start.md), configure a task model, and use a
stack with sandboxed execution available (not `--skip-sandbox-check`).

## 1. Ask for a search

Open a Session and type this in the composer:

```text
/evolve-design Write a compress/decompress pair for text: compress(text) -> bytes and
decompress(bytes) -> str. The round-trip must be exact. Standard library only — no
zlib, lzma or bz2. Score is how much smaller the compressed form is.
```

Typing `/evolve-design` brings up the algorithm picker. Take **PUCT**, the default: one starting
point refined repeatedly is exactly the tree's case.

![Picking the search algorithm](../../images/evolve/choose-algorithm.png)

This task is chosen because it fails and succeeds visibly: a compressor either round-trips or it
does not, and the ratio is a single honest number.

## 2. Checkpoint 1 — what "better" means

The agent reads the conversation and comes back with three things: the measurable criterion (the
compression ratio), what is frozen (the round-trip requirement and the standard-library limit),
and a starting point.

**Look at the starting point.** It should already contain the mechanism the search will improve —
a working run-length encoder, say, rather than an identity function that returns its input
unchanged. An identity seed "works" and compresses nothing, so there is nothing for a candidate to
edit and each one has to invent a compressor from scratch; a measured run that made this mistake
spent ten expansions that way, seven of which did not run at all, and finished at 0.226.

The other thing it needs is room to improve. If the proposed seed already scores near the
ceiling, say so — there is nothing left for the search to win.

## 3. Checkpoint 2 — the scoring

The agent writes the evaluator, runs it once against the starting point, and reports one number
plus a sentence on what the scoring rewards.

This is the checkpoint to read carefully. Ask yourself: **what could a candidate do to score
higher that I would not actually want?** For compression the answer is "lose data", which is why
the exact round-trip is frozen. If the criterion were "produce readable output", nothing would
separate a good candidate from a bad one and the run would come back flat.

A starting point scoring roughly **0.3–0.7** is the target. Zero is a floor and a solved task is a
ceiling; both leave the search nothing to climb.

## 4. Checkpoint 3 — the size of the run

You will be shown units and shard sizes. For a first run the defaults are fine. The one number
worth understanding is the **gate** shard: every candidate's rank comes from it, so it should be
the largest of the three. The `test` shard is small and never takes part — it exists to give you
an honest final number.

Answering "you decide" here is reasonable for a first run.

## 5. Checkpoint 4 — it starts

The server runs its discrimination probe first — four sandboxed evaluations checking that the
scoring can actually tell candidates apart — and then the search begins. You get the probe's
numbers and the budget.

If the probe rejects the proposal, that is the cheapest possible failure: it costs no search
budget and the rejection says what to fix.

## 6. Watch it

![The live panel during a run](../../images/evolve/live-panel.png)

Open the evolution panel and watch three things:

- **The step line** climbing above the dashed baseline. Each step is a new best.
- **The scatter below it** — candidates that did not improve. Plenty of them is normal.
- **The stream on the right** — each version's parent, what it changed, and its score.

A real run of this task went from **0.46 to 0.97** over 20 expansions. Your numbers will differ;
what matters is the shape — steps upward, not a flat line.

The search runs for minutes and continues in the background. You can close the panel and keep
working.

## 7. Read the result

![Starting point and winner as two versions of one artifact](../../images/evolve/result-diff.png)

When it finishes, the starting point and the winner are two versions of the same artifact. Open
the diff and read what actually changed — this is the part worth your time, because it tells you
*how* the score was won.

Then find the **held-out test score**. In that real run it was **0.9682**, against a best gate
score of 0.9674 — close together, which is what you want. A test score far below the best gate
score means the search fitted the shards it could see, and the honest number is the lower one.

## What you have learned to look for

- A seed that contains the mechanism the search will improve, with headroom left above it.
- A criterion that separates good from bad — and the habit of asking what a candidate could do to
  score higher that you would not want.
- The difference between the gate score (steers the search, optimistic) and the test score (never
  took part, honest).
- That a run finding nothing above the starting point is a *result*, not a failure: on this
  scoring, these variations do not win.

## Next

- [Run an evolution search](run-an-evolution-search.md) — sizing, the other scoring
  modes, and what to do when a run goes wrong.
- [Program evolution](../core/evolve.md) — the two engines, the three shards, the probe,
  and why the scorer is frozen.
