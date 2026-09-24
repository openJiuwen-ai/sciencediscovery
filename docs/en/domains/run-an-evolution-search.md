# Run an evolution search

How to drive `/evolve-design` from a session: proposing a search, sizing it, watching it, and reading
what comes back. For what a search is and when it works at all, see
[Program evolution](../core/evolve.md); for a first run you can complete end to end, see
the [tutorial](evolve-a-solution.md).

## Before you start

- A task model configured through [Quick Start's model setup](../getting-started/quick-start.md#3-configure-a-task-model).
- Sandboxed execution available — candidates are evaluated in bubblewrap, so a stack started with
  `--skip-sandbox-check` cannot run a search.
- Something to start from, and something that can score it. Both are designed with you during
  the proposal; neither has to exist beforehand.

## 1. Propose the search

Say what you want improved and what "better" means, in the composer:

```text
/evolve-design Write a compress/decompress pair for text. Lossless round-trip is
required, stdlib only, no zlib/lzma/bz2. Score is the compression ratio.
```

`/evolve-design` is optional — describing the goal in plain language reaches the same skill — but
typing it brings up the algorithm picker.

![Choosing PUCT or OpenEvolve before the proposal is written](../../images/evolve/choose-algorithm-en.png)

| Algorithm | Keeps | Choose it for |
|---|---|---|
| **PUCT** (default) | A tree of candidates | Refining one starting point |
| **OpenEvolve** | A multi-island MAP-Elites archive with ring migration | Wide search spaces that converge too early |

You can also state it inline: `/evolve-design --algorithm openevolve …`.

## 2. Answer the four checkpoints

The skill designs the search with you, stopping four times. Each stop is a few lines to wave
through, not a form.

1. **What "better" means** — the measurable criterion, what is frozen, and the starting point.
2. **The scoring** — the evaluator is written and run once against the starting point, and you
   are shown what it scored plus one sentence on what the scoring rewards. This is the checkpoint
   worth reading carefully: it is where a criterion that measures the wrong thing gets caught.
   Ask yourself what a candidate could do to score higher, and whether that is what you want.
3. **The size of the run** — units, shard sizes, expansion budget.
4. **The result of starting it** — the probe's numbers and what the search will do.

Saying "you decide" or "just go" makes the skill state its remaining choices in one message and
run them without stopping.

### Sizing, if you want to steer it

| Knob | Guidance |
|---|---|
| One unit | Whatever one measurement consumes. Big enough that the same candidate scores the same twice — a unit holding a single item makes the score binary and wastes budget, because the search skips proposing on a unit it already solves. |
| `gate` shard | The largest of the three. 8–12 units for deterministic scoring, 16–24 with any randomness. This is the only number the search ranks on. |
| `rollout` shard | Four or more, never one, and no more than the gate. |
| `test` shard | 4–8. It never takes part; it buys confidence in the final number. |
| `expansions` | At least `4 × workers`. By distance to travel: 4–6 for a known defect, 12–20 for swapping approach, 20+ for writing from scratch. |

If the total will not fit in your budget, shrink each unit rather than cutting the gate.

### Choosing a starting point

The seed must **contain the mechanism the search is meant to improve**, in working form.
Candidates edit what is in front of them; a seed with no mechanism forces every one of them to
invent it from nothing, and a from-scratch implementation fails far more often than an edit does.

Two measured runs make the point. A cache task seeded with a working LRU climbed 0.2218 → 0.9396,
its candidates swapping in ARC, LIRS and TinyLFU on top of a policy that was already there. A
compression task seeded with identity encoding — which "works" and compresses nothing, so there
was nothing to edit — spent ten expansions on whole compressors written from scratch, seven of
which did not run at all, and finished at 0.226.

What the seed also needs is **headroom**: aim for a starting point scoring roughly **0.3–0.7**.
Zero leaves nothing to build on, and a solved task leaves nothing to climb.

## 3. Watch it

![Score chart, search tree and candidate stream during a run](../../images/evolve/live-panel-en.png)

- **Score chart** — one point per candidate, a step line for the best so far, a dashed baseline at
  the starting point, and the held-out `test` figure once the run finishes. Candidates that failed
  to run are marked, not hidden.
- **Search tree / graph** — which candidate came from which.
- **Candidate stream** — every version with its parent, change summary and score.

OpenEvolve runs add a **grid** view of the archive — one column per island, ★ for the global best,
↔ for a migrated candidate, and each cell's complexity/diversity coordinates.

The run continues in the background. Closing the panel does not stop it; the session can carry on
with other work while it runs.

## 4. Read the result

![The starting point and the winner as two versions of one artifact](../../images/evolve/result-versions-en.png)

The starting point and the winner are two versions of the same artifact, so the result is a diff.
A further search can be started from either version.

![Diffing the starting point against the winner](../../images/evolve/result-diff-en.png)

**Read the held-out `test` number, not the best `gate` number.** The gate figure steered the
search and is optimistic by construction; the test shard never took part. A large gap between the
two means the search fitted the shards it could see.

With [ScienceMemory](../developer-docs/science-memory.md) enabled, the run is also in the graph:
the search node links to its starting point with an `input` edge and to its result with
`produces`, and its detail carries the baseline and held-out figures.

## When it does not work

| What you see | What it means | What to do |
|---|---|---|
| The proposal is rejected before the search starts | The discrimination probe found the scoring cannot separate a working program from a corrupted one, the starting point has no headroom, repeated evaluation is unstable, or failure diagnostics carry no location | Fix what the rejection names. This is the cheap failure — it costs no budget |
| A flat run: every candidate near the same score | The scoring does not discriminate, or the units are too small | Widen the units, check the cases reward what you care about |
| Many candidates "did not run" | The seed has no mechanism to edit, so candidates rewrite everything from scratch | Reseed with a working version of the mechanism the search is meant to improve |
| Nothing beats the starting point | A result: on this scoring, these variations do not win | Reconsider the scoring, not the approach you wanted candidates to take |
| Best gate score far above the test score | The search fitted its visible shards | Enlarge the gate shard and re-run |

## Related

- [Program evolution](../core/evolve.md) — what a search is, the shards, the probe, freezing.
- [Evolve a solution](evolve-a-solution.md) — a worked first run.
- [Sandbox execution](../developer-docs/sandbox-execution.md) — where candidates are evaluated.
