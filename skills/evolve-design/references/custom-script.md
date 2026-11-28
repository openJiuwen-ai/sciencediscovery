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

## Per-call limits and the score's inputs

Two things an evaluator cannot get right with threads, and both were measured on one Windows
desktop experiment. The framework stages `evaluator_support.py` in the scratch directory beside the
evaluator, so `import evaluator_support` needs no installation and no path juggling.

**A per-call deadline that actually stops the call.** `queue.get(timeout=…)` and
`thread.join(timeout=…)` end the *wait*; the worker keeps running, keeps its CPU, its handles and
its memory, and keeps competing with the next case. Three scored candidates in that run carried
per-case timeout errors while their timed-out threads were still alive in the same process.
`call_with_deadline` runs the call in a child process and kills and reaps it when the deadline
passes, before it raises:

```python
import evaluator_support

try:
    answer = evaluator_support.call_with_deadline(candidate.solve, values, timeout=1.0)
except evaluator_support.DeadlineExceeded:
    failures.append(f"case {i}: no answer within its 1s limit")   # that case fails, the run goes on
except evaluator_support.CallFailed as error:
    failures.append(f"case {i}: {error}\n{error.traceback}")       # a line number for the next author
```

- The deadline covers **interpreter startup, the candidate's import and the call**. It is an
  end-to-end bound, not a bound on the call alone, so leave headroom rather than setting it to
  exactly how long the call takes.
- `candidate.solve` has to be a module-level function, and its arguments and return value have to be
  picklable. A return value that cannot cross the process boundary is reported as such, with the
  remedy, instead of hanging.
- A timed-out case is a **failed case**, never an invalid run: keep the score the other cases
  earned. The probe refuses an evaluator that turns one non-returning call into `valid: false`, and
  one that cannot finish at all.
- What the deadline cannot promise: a process the *candidate itself* starts is killed with the child
  on Linux (`POSIX` session) but not on Windows, where only the direct child is terminated. The same
  asymmetry holds when the call ends for another reason: the child notices that the evaluator which
  started it is gone and, on Linux, takes its own process group with it, whereas on Windows only that
  child ends — a candidate that started grandchildren leaves them there.

**Locally, stage the file once.** The sandbox does this for you; `run_shell` does not, and a local
run that imports `evaluator_support` without it fails with `ModuleNotFoundError`. Copy it from the
installed package before the rehearsal:
`python -c "import shutil, sciencediscovery_evolve.evaluator_support as s; shutil.copy(s.__file__, '.')"`.
If the package is not importable there either, run the local check without the deadline and let the
probe exercise it.

**Inputs the candidate may damage but not change the score.** `call_with_deadline` already sends the
arguments over a process boundary, so the candidate owns only a copy. Where data stays in your own
process, split it deliberately: `pristine(...)` is the copy you validate and calculate from,
`candidate_copy(...)` is the one you hand over. One evaluator computed the baseline before the call
and the candidate's makespan after it from the same mutable lists, and a candidate that replaced the
workloads with zeros scored 1.0 with an empty error. The probe scores a candidate that does exactly
that — returns the starting point's own answer while zeroing its input — and refuses an evaluator
whose score moves.

**Do not raise `valid: false` because one case failed.** Per-case zero and partial scores are
legitimate results; the search ranks them. `valid: false` means "this candidate produced no
measurement", and it throws away every case that did work.

### What the probe checks, and what it says it could not check

It spends seven evaluations, in this order: the starting point, a damaged copy of it, a candidate
that cannot be imported, one that damages the inputs it was given, one whose first call never
returns — twice, because the handling of a timed-out case has to be the same both times — and the
starting point again, which the repeat-noise check compares against. Each call `call_with_deadline`
makes is recorded in `evaluator_support.jsonl` in the scratch directory, and those records are what
let the probe see a deadline fire and a later case still score.

The per-call check runs on the same gate shards. Its bound is the run's own whole-evaluation
`candidateTimeoutSeconds` (not a per-call budget) capped at a 15-second floor, and scaled up by the
starting point's own evaluation time: `min(candidateTimeoutSeconds, max(15, baseline + 15))`. The
probe times that starting-point evaluation itself, so the scale cannot be forged by a record the
script writes. A script a non-returning call can hold open — no per-call limit, one too large for the
bound, or ordinary cases that leave no room — is refused when the bound expires, with the number and
the measured starting-point time in the message; a slow starting point is no reason to skip the
refusal. A limit of about a second per call is the pattern to aim for: it ends the hung case at its
own deadline. A script that limits each call by *waiting* — `queue.get(timeout=…)`,
`thread.join(timeout=…)` — is not refused when its whole evaluation fits the scaled bound; its state
after a timeout cannot be observed from outside, so the probe says that cleanup was not checked
instead of pretending it was.

The input-damage check has one limit worth knowing: it can only change values that are mutable and
addressable — lists, dicts, arrays — and mutable values *inside* a tuple or frozenset, since a tuple
argument usually carries the real data. An immutable scalar — a number, a string — cannot be
changed, so a candidate whose only argument is one of those cannot be exercised this way and the
check says nothing either way; the timeout and output checks still apply.

A script that does not import `evaluator_support` is not refused for that: existing evaluators keep
working. But whether a legacy watchdog's abandoned work really stopped is not observable from
outside the process, so the probe does not claim to have checked it — it checks that the run
survives the non-returning call and that the score repeats, and says the cleanup itself was not
observed. Migrating to `call_with_deadline` is what makes that check possible.

## How it runs

As a script, with `__name__ == "__main__"` (`runpy.run_path`), and the scratch directory first on
`sys.path`. Top-level code runs, an `if __name__ == "__main__":` guard runs, and `import candidate`
resolves. You do not need to reverse-engineer this.

## The evaluator runs alone and reads nothing

It gets a scratch directory containing itself and the candidate — not the workspace, not the file
you read while designing, and there is no way to ship it one at run time. A shard is an *index*,
and what index `i` means is the evaluator's choice: it **builds** case `i` — an equation with a
known analytic solution, a generated input, a corpus drawn from a fixed seed, a property to check.
Anything it opens by path fails on every candidate. If the material genuinely lives in a file, that
is `dataset_metric`, which owns the splitting as well.

## Handing the script over: `evaluatorSource` or `evaluatorPath`

The script itself travels one of two ways. `evaluatorSource` carries it verbatim in the tool call,
which is the ordinary case. When the script is **too big to write in one call** — a frozen truth
table of thousands of points, where retyping it costs more tokens than most turns have — write it to
a workspace file with `run_shell`, run that file once to check it, and pass `evaluatorPath` instead.
The control plane reads the file **once**, at the moment `create_evolve_run` is called, checks the
contract above against its contents, and stores and freezes those bytes; editing the file afterwards
does not change the run. Exactly one of the two fields, never both.

The size ceiling is the same either way (200,000 characters). If the table alone is past it, the
evaluator still has to **build** each case from the shard index rather than carry the table — the
profile is not the exception to "reads nothing".
