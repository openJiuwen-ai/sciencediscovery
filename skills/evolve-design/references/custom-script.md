# Writing a `custom_script` evaluator

Read this before writing the evaluator for mode `custom_script`. The mode is the fallback: use it
only when neither `dataset_metric` nor `test_gate` fits, because here you own the measuring
apparatus and the framework does none of the splitting or freezing for you.

## Contract

- Import the candidate as `candidate`.
- Score only the shards listed in `SCIENCE_AGENT_SHARDS` (comma-separated indices).
- Write `{"valid": true, "metrics": {"score": 0.83}}` to the path in `SCIENCE_AGENT_RESULT`. It is
  a file, not stdout, because the candidate prints too.
- The score is 0–1, larger is better.
- The module docstring is the contract the search sees when it rewrites candidates, so say there
  what the candidate must expose.

## The `error` field is the feedback channel

Whatever the evaluator puts in `error` is what the model writing the next candidate reads. For a
crash it has to say **where**, not just what: use a trimmed `traceback.format_exc()`, so the text
carries a file and a line. **The probe refuses an evaluator that reports an exception without
one.** `type(e).__name__` says nothing, and even `repr(e)` — a real message like
`ValueError('byte must be in range(0, 256)')` — leaves the next author hunting 200 lines for which
of a dozen appends it was, so it discards the whole approach and re-rolls with a fresh bug.
Measured: five candidates crashed in one run, the repair pass fired four times and landed once, and
two of the five were the same one-line bug found from scratch each time.

A *semantic* failure needs no line — "round trip does not match", "budget exhausted on 3 of 6" —
and the gate does not ask for one. Write the field even when the candidate is valid; that is how
the next one learns to stop.

## How it runs

As a script, with `__name__ == "__main__"` (`runpy.run_path`), and the scratch directory first on
`sys.path`. Top-level code runs, an `if __name__ == "__main__":` guard runs, and `import candidate`
resolves. You do not need to reverse-engineer this.

## The evaluator runs alone and reads nothing

It gets a scratch directory containing itself and the candidate — not the workspace, not the file
you read while designing, and there is no way to ship it one. A shard is an *index*, and what index
`i` means is the evaluator's choice: it **builds** case `i` — an equation with a known analytic
solution, a generated input, a corpus drawn from a fixed seed, a property to check. Anything it
opens by path fails on every candidate. If the material genuinely lives in a file, that is
`dataset_metric`, which owns the splitting as well.
