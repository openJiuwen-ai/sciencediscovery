# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The one prompt this engine sends: mutate a parent program into a child.

**This is not upstream's prompt.** `examples/era` wraps its calls in a preamble
tuned for one Kaggle task; the objective here comes from the user's scorecard,
so the prompt has to state that objective instead. Written fresh, and labelled
as such rather than inheriting a fidelity claim it cannot support.

Everything in it earns its place by preventing a specific failure:

* **The gate's rules are stated up front.** The AST gate refuses ``open``, a
  forbidden import or a stray top-level statement, and a refusal is recorded as
  a failed candidate — so a model that was never told the rules produces a run
  full of failures that look like it cannot code.
* **The entrypoint's exact signature is given.** The runner calls
  ``train_and_predict(train_path, test_path)`` and expects one prediction per
  test row. A model that invents ``fit``/``predict`` classes fails at load with
  a message about a missing function.
* **The scorecard is spelled out, direction included.** "Improve the program" is
  not an objective; a candidate cannot be aimed at a metric it was not told
  about, and a *minimised* metric described without its direction gets
  optimised the wrong way.
* **A constraint is presented as a wall, not a cost.** Constraints refuse a
  merge outright, so a model told "prefer fast" will trade accuracy for speed it
  did not need to buy and be refused anyway.
* **The objective is the score, and the cost of failing is stated.** Upstream
  says "generate a NEW, IMPROVED function" and gets away with it because its task
  is a twenty-line sklearn pipeline. Asked the same way about a codec, every
  candidate replaced the whole mechanism and ten of eleven did not run. What the
  model was never told is that not running scores zero — worse than leaving the
  parent alone, with the expansion spent either way. Stated as that reason rather
  than as a ban on changing the approach: which approach wins is the search's
  question, not the prompt's. See ``_HOW_TO_CHANGE``.
* **The reply format is one fenced block whose docstring opens with the change.**
  ``extract_program`` takes the longest fenced block and reads the first
  docstring line as the change summary; that summary is what the user reads in
  the search graph, and without it every node is labelled with nothing.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional, Sequence

from .vendor.puct.program import available_imports_text

#: The closing instruction every code-shaped template ends on.
#:
#: One block rather than a line per template, because the three drifted: the
#: measured template said "make one substantive change" and the other two said
#: only "output a complete runnable program", which reads as an invitation to
#: write one from scratch. A live
#: compression run showed what that costs — a working RLE+Huffman seed of 6571
#: characters, and eleven candidates that every one of them *replaced the whole
#: mechanism* ("replaced the RLE+Huffman scheme", "restructured as LZ77
#: dictionary matching"), reaching
#: 15824 characters and implementing arithmetic coding or LZ77 from nothing in a
#: single reply. Ten of the eleven did not run. The tree stayed flat at depth 1
#: because no candidate ever beat the seed.
#:
#: The asymmetry is the part the model was never told: a candidate that does not
#: run scores zero, which is *worse than leaving the parent alone*, and the
#: expansion is spent either way. Upstream gets away without saying this
#: because its task is a twenty-line sklearn pipeline, where a rewrite is cheap
#: and rarely broken; a codec is not.
_HOW_TO_CHANGE = """## How to change it

**The only goal is to raise the score.** Whether to swap the approach, and which
algorithm to use, follow from that one thing. No approach is right or wrong in
itself.

There is one thing to keep in mind: **a program that does not run scores 0,
which is worse than the one you were given, and the attempt is spent either
way.** So work from the current version and leave what still works as it is —
not because swapping the approach is forbidden, but because rewriting the whole
thing from nothing in a single reply usually does not run, and that scores
nothing. If a part genuinely has to be replaced, replace that one part and let
the code around it keep running unchanged.

"Leave it as it is" has one exception: **the first line of the module docstring
must be rewritten every time**, saying in one sentence what changed. Copy the
previous version's first line and every node in the search tree ends up with the
same name, and nobody reading the graph can tell them apart.

Work out which part of the current version is weakest against the scoring, then
change that part."""

_TEMPLATE = """You are improving a Python program so that it scores higher against the scoring scheme below.

## Goal

{statement}

## Scoring

{criteria}
{constraints}
## Current program

How it does on the held-out shards: {parent_score}. Best in this search so far: {best_score}.

```python
{parent_code}
```

{history}
## Requirements

1. It must define `train_and_predict(train_path, test_path)`: read those two
   CSVs and return a one-dimensional sequence of predictions whose length equals
   the number of test rows (a list or a numpy array, either is fine).
2. You may import only: {imports}.
3. No reading or writing any file other than those two arguments, no network, no
   `open`/`eval`/`exec`/`__import__`, no subprocesses. At module level only
   imports, function/class definitions and literal assignments are allowed.
4. Output **one** ```python block containing the complete runnable program (not
   a patch, not a fragment).
5. The first line of the program's module docstring says in one sentence what
   changed this time — it is shown to the user as this node's label.

{how_to_change}
"""


def mutation_prompt(
    *,
    statement: str,
    scorecard: Mapping[str, Any],
    parent_code: str,
    parent_score: Optional[float],
    best_score: Optional[float],
    frozen: Sequence[str] = (),
    recent: Sequence[str] = (),
    rubric: str = "",
    script_contract: str = "",
    feedback: str = "",
) -> str:
    """Build the prompt for one expansion.

    ``rubric`` switches this from rewriting a program to rewriting *text*: when
    a scorecard is graded by a model there is nothing to execute, so none of the
    program contract applies and the rubric is what the candidate is aimed at.
    """
    if frozen:
        # The first of the two freezing layers: stop the model *proposing* a
        # change to the thing that marks it. The second — restoring every frozen
        # path before the suite runs — is in `test_gate_domain`, and it is the
        # one that cannot be skipped, because a candidate is executed.
        return _TEST_TEMPLATE.format(
            statement=statement.strip() or "Make all the tests pass.",
            parent_code=parent_code.strip(),
            parent_score=_score(parent_score),
            best_score=_score(best_score),
            feedback=_feedback(feedback),
            history=_history(recent),
            frozen=", ".join(frozen),
            imports=available_imports_text(),
            how_to_change=_HOW_TO_CHANGE,
        )
    if script_contract:
        # A scripted search's contract is whatever its evaluator calls, and the
        # evaluator is the only place that knows. Falling through to the
        # measured-mode template told every candidate to define
        # `train_and_predict(train_path, test_path)` — watched a Gaussian-
        # integral run do exactly that: candidates bolted on CSV readers and
        # LightGBM regressors "to match the scoring requirements", the integral
        # function never changed, and all nine scores came out identical to ten
        # decimal places. The search finished "succeeded" having learned nothing.
        return _SCRIPT_TEMPLATE.format(
            statement=statement.strip() or "Make the evaluator report a higher score.",
            contract=script_contract.strip(),
            parent_code=parent_code.strip(),
            parent_score=_score(parent_score),
            best_score=_score(best_score),
            feedback=_feedback(feedback),
            history=_history(recent),
            imports=available_imports_text(),
            how_to_change=_HOW_TO_CHANGE,
        )
    if rubric:
        return _TEXT_TEMPLATE.format(
            statement=statement.strip() or "Improve it against the rubric below.",
            rubric=rubric.strip(),
            parent_text=parent_code.strip(),
            parent_score=_score(parent_score),
            best_score=_score(best_score),
            history=_history(recent),
        )
    return _TEMPLATE.format(
        statement=statement.strip() or "Achieve a reportable improvement against the scoring below.",
        criteria=_criteria(scorecard),
        constraints=_constraints(scorecard),
        parent_score=_score(parent_score),
        best_score=_score(best_score),
        parent_code=parent_code.strip(),
        history=_history(recent),
        imports=available_imports_text(),
        how_to_change=_HOW_TO_CHANGE,
    )


_TEST_TEMPLATE = """You are rewriting an implementation so that it passes more tests.

## Goal

{statement}

## Current implementation

Pass rate: {parent_score}. Best so far: {best_score}.
{feedback}
```python
{parent_code}
```

{history}## Requirements

1. **Do not touch these paths**: {frozen}. They are what decides the score, and
   changing them counts for nothing — they are restored to the original before
   every run. Put the effort into the implementation.
2. You may import only: {imports}.
3. Output **one** ```python block containing the complete runnable
   implementation (not a patch, not a fragment).
4. The first line of the module docstring says in one sentence what changed.

{how_to_change}
"""

_SCRIPT_TEMPLATE = """You are rewriting a program that is scored by a **fixed evaluator script**.

## Goal

{statement}

## What the evaluator requires of a candidate

{contract}

The evaluator does `import candidate` and calls it through the interface above.
**An interface that does not match scores zero** — do not add functions the
evaluator never asked for (`train_and_predict`, for instance); that is not this
run's contract.

## Current program

Its score: {parent_score}. Best so far: {best_score}.
{feedback}
```python
{parent_code}
```

{history}## Requirements

1. Write to the interface the evaluator requires — every function name and
   argument exactly as it expects them.
2. You may import only: {imports}.
3. Output **one** ```python block containing the complete runnable program (not
   a patch, not a fragment).
4. The first line of the module docstring says in one sentence what changed.

{how_to_change}
"""

_TEXT_TEMPLATE = """You are rewriting a piece of writing so that it scores higher against the rubric below.

## Goal

{statement}

## Rubric

{rubric}

## Current version

Its score: {parent_score}. Best so far: {best_score}.

```
{parent_text}
```

{history}## Output format

Start with one line saying what changed this time, then give the **complete**
new version inside a single ``` block (not a patch, not a fragment, no
explanation). That first line is shown to the user as this node's label.
"""


def _feedback(text: str) -> str:
    """The evaluator's own diagnosis of the parent, as a prompt section.

    This existed all along — the failing test names, the "3 of 6 cases blew the
    evaluation budget"
    — stored on the node and shown in the UI, and never put in front of the one
    reader who could act on it. A real ODE run showed the cost: six candidates
    scored exactly 0, each a reasonable adaptive method that burst the eval
    budget, and the reflector, told only "score 0", kept trying new variants of
    the same overspend because nothing said *why* the last one died.
    """
    if not text.strip():
        return ""
    return f"\nWhat the evaluator said about it: {text.strip()[:500]}\n"


def _criteria(scorecard: Mapping[str, Any]) -> str:
    lines = []
    for criterion in scorecard.get("criteria") or []:
        measure = criterion.get("measure") or {}
        metric = (measure.get("metric") or {}).get("name", "")
        direction = "larger is better" if criterion.get("direction") == "maximize" else "smaller is better"
        weight = criterion.get("weight")
        weight_text = f", weight {weight}" if isinstance(weight, (int, float)) else ""
        lines.append(f"- **{criterion.get('name', criterion.get('id'))}** ({metric}, {direction}{weight_text})")
    return "\n".join(lines) or "- (no criteria given)"


def _constraints(scorecard: Mapping[str, Any]) -> str:
    constraints = scorecard.get("constraints") or []
    if not constraints:
        return ""
    lines = []
    for constraint in constraints:
        value = constraint.get("value")
        if isinstance(value, Mapping):
            threshold = f"{value.get('relativeToBaseline')}x the baseline"
        else:
            threshold = str(value)
        lines.append(
            f"- **{constraint.get('name', constraint.get('id'))}**: "
            f"{constraint.get('criterionId')} must be {constraint.get('op')} {threshold}"
        )
    # Named as a wall rather than a cost: a violated constraint refuses the
    # merge outright, so trading score for headroom below it buys nothing.
    return ("\n## Vetoes (crossing one fails the candidate outright — it is not a\n"
            "deduction)\n\n" + "\n".join(lines) + "\n")


def _history(recent: Sequence[str]) -> str:
    if not recent:
        return ""
    # What was already tried, so the search does not spend three expansions
    # rediscovering the same idea.
    lines = "\n".join(f"- {item}" for item in recent if item)
    return f"## Changes already tried in this search\n\n{lines}\n\n" if lines else ""


def _score(value: Optional[float]) -> str:
    return "not measured yet" if value is None else f"{value:.4f}"


def repair_prompt(code: str, error: str) -> str:
    """Ask for the one bug this candidate has, not for a different candidate.

    A candidate that failed usually failed for something visible in its own
    traceback — an import that raises, an index off by one, a type that is not
    what the line assumed. Discarding it means the next expansion writes the
    whole program again from the parent, and on a live compression run seven of
    ten candidates never ran at all: each a fresh design with a fresh bug.

    Deliberately narrow. It carries this candidate's code and this candidate's
    failure and nothing else — no statement of the goal, no scorecard, no other
    candidate — because a wider prompt invites a redesign, and a redesign is
    what the ordinary expansion already does.
    """
    return (
        # Not "it does not run": it may well run. A candidate reaches here
        # whenever it scored nothing at all, and "every case came out wrong" is
        # as common a way to get there as a traceback — telling it the program
        # does not run when the error says the round trip does not match points
        # the repair at the wrong thing.
        "The program below did not pass a single case. Fix only the problem it "
        "reports: do not redesign it, and do not tidy anything else along the "
        "way. Get it running correctly and leave the rest as it is.\n\n"
        # "Do not change the approach" used to be in the sentence above, and it
        # forbade the one repair available: when the error says `cannot import
        # name 'cwt'`, the missing thing *is* the approach. In one peak-detection
        # search three candidates reached for scipy.signal.cwt/ricker (removed in
        # SciPy 1.15); the repair fired three times and saved none of them.
        "If the error says something does not exist — a failed import, a missing "
        "attribute, a function that was removed — then replacing that one thing "
        "with an equivalent the current version actually has **is** the minimal "
        "fix. Leave everything else alone.\n\n"
        "## What it reported\n\n"
        f"{error.strip()[:1500] or '(the evaluator gave no reason)'}\n\n"
        # The environment, because "replace it with an equivalent that exists" is
        # not actionable without knowing what is there. Three candidates in one
        # run reached for `scipy.signal.cwt`, removed in SciPy 1.15; the repair
        # was told to replace it and given no way to know what with.
        "## What this environment has\n\n"
        f"You may import only: {available_imports_text()}\n\n"
        "## Current program\n\n"
        "```python\n"
        f"{code}\n"
        "```\n\n"
        "Output only the fixed complete program, in a single ```python block.\n"
    )
