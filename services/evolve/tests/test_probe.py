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

"""The one pre-flight check that has to spend money to answer.

Every other check reads the goal. This one runs the scoring twice, because
"can this scorecard tell a good candidate from a bad one" is not derivable from
the card — and its failure is the silent one.
"""

from __future__ import annotations

from typing import Any, List

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_evolve.probe import ProbeError, run_probe
from test_puct_engine import JUDGED_CARD, judged_spec  # noqa: F401 - shared fixtures


def judge_returning(marks: List[float], monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the probe's judge at a canned sequence of marks."""
    from sciencediscovery_evolve import probe as probe_module

    calls = {"n": 0}

    def completion(spec: Any, on_usage: Any, should_stop: Any):
        def complete(prompt: str, sink: Any = None, on_failure: Any = None,
                     on_cancelled: Any = None) -> str:
            mark = marks[min(calls["n"], len(marks) - 1)]
            calls["n"] += 1
            return str(mark)
        return complete

    monkeypatch.setattr(probe_module, "_default_completion", completion, raising=False)
    import sciencediscovery_evolve.puct_engine as engine_module
    monkeypatch.setattr(engine_module, "_default_completion", completion)


def test_the_damaged_copy_survives_the_gate_that_judges_real_candidates() -> None:
    """The probe's whole job is to compare a starting point with a worsened one.

    This used to save the original to a module-level alias before shadowing it,
    and the AST gate refuses that — a top-level assignment whose value is a name
    is not a literal constant. Every damaged copy was rejected before it ran,
    ``worsened`` came back ``None``, and ``flat`` is
    ``worsened is not None and ...`` — so the probe passed every measured
    scorecard it was ever given without measuring anything.
    """
    from sciencediscovery_evolve.probe import _CONSTANT_PREDICTOR
    from sciencediscovery_evolve.vendor.puct.program import validate_source

    baseline = (
        "import pandas as pd\n\n\n"
        "def train_and_predict(train_path, test_path):\n"
        "    return [1.0] * len(pd.read_csv(test_path))\n"
    )
    ok, why = validate_source(baseline)
    assert ok, why

    ok, why = validate_source(baseline + _CONSTANT_PREDICTOR)
    assert ok, f"the probe's damaged copy was stopped by the gate: {why}"


def test_a_scorer_that_notices_the_damage_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    # The baseline is graded first, then the deliberately empty rewrite.
    judge_returning([6] * 4 + [1] * 4, monkeypatch)
    result = run_probe(judged_spec())

    assert result["flat"] is False
    assert result["baseline"] > result["worsened"]


def test_a_scorer_that_gives_everything_the_same_mark_is_flat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The case worth two evaluations: the search would walk randomly on flat
    # terrain and nothing on the dashboard would look wrong.
    judge_returning([5] * 16, monkeypatch)
    result = run_probe(judged_spec())

    assert result["flat"] is True
    assert result["label"]


def test_a_scorer_that_barely_moves_is_still_flat(monkeypatch: pytest.MonkeyPatch) -> None:
    # Judged scorers wobble. Exact equality would pass a rubric that is flat in
    # every way that matters.
    judge_returning([5.0] * 4 + [5.02] * 4, monkeypatch)
    assert run_probe(judged_spec())["flat"] is True


def test_a_starting_point_that_will_not_score_is_refused_not_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Every score in the search is relative to the baseline, so this is a worse
    # problem than a flat scorecard and a different message.
    judge_returning([], monkeypatch)

    with pytest.raises(ProbeError) as error:
        run_probe(judged_spec(baseline_code="   "))
    assert "starting point" in str(error.value)


def test_a_damaged_copy_that_will_not_score_is_not_counted_as_a_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sciencediscovery_evolve import probe as probe_module

    # A judge that answers for the baseline and then refuses says nothing about
    # discrimination; treating that as "the check passed" would let a flat
    # scorecard through on a transient.
    marks = ["6", "6", "6", "6", "no number", "no number", "no number", "no number"]
    calls = {"n": 0}

    def completion(spec: Any, on_usage: Any, should_stop: Any):
        def complete(prompt: str, sink: Any = None, on_failure: Any = None,
                     on_cancelled: Any = None) -> str:
            reply = marks[min(calls["n"], len(marks) - 1)]
            calls["n"] += 1
            return reply
        return complete

    import sciencediscovery_evolve.puct_engine as engine_module
    monkeypatch.setattr(engine_module, "_default_completion", completion)
    monkeypatch.setattr(probe_module, "_default_completion", completion, raising=False)

    result = run_probe(judged_spec())
    assert result["worsened"] is None
    assert result["flat"] is False


def test_a_judge_that_cannot_agree_with_itself_is_not_a_broken_starting_point(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both arrive as the same ``None`` and point at opposite fixes.

    "Undecidable" means the candidate ran perfectly — several times — and the
    judge disagreed with itself. Reporting that as "the starting point does not
    run" sends the
    user to rewrite a starting point that was never the problem, and leaves the
    rubric that actually needs the work untouched.
    """
    # Marks all over the scale: the spread blows past the variance threshold and
    # the judged domain calls the candidate undecidable rather than bad.
    judge_returning([1, 9, 2, 8, 3, 7, 1, 9], monkeypatch)

    with pytest.raises(ProbeError) as caught:
        run_probe(judged_spec())

    message = str(caught.value)
    assert "unstable on its own terms" in message
    assert "does not run" not in message
    # And it names the two things that would actually help.
    assert "rubric" in message and "gradings" in message


def test_a_starting_point_already_at_the_solved_threshold_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The third useless scoring scheme, next to flat and broken — and the
    sneakiest, because everything works: the probe discriminates, the run
    starts, the seed is immediately "solved", and the search ends having done
    nothing. Seen live: a drafted evaluator whose samples were all easy scored
    the 5-point rule it was meant to improve on at 0.9999999."""
    judge_returning([9] * 20, monkeypatch)

    with pytest.raises(ProbeError) as caught:
        run_probe(judged_spec())

    assert "no slope for the search to climb" in str(caught.value)


def test_a_scoring_that_wobbles_as_much_as_the_damage_is_refused() -> None:
    """Counting shards cannot answer "is this stable"; measuring can.

    A deterministic evaluator is steady on three shards and a sampling one is
    not steady on thirty, so the probe scores the *same* starting point twice
    and compares the spread against the damage signal it already paid for.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_noisy

    # The single call this makes is the repeat; baseline and damaged are passed in.
    def evaluate(_code, _shards):
        return True, {"score": 0.55}, ""

    with pytest.raises(ProbeError) as caught:
        # baseline 0.80, damaged 0.62 → signal 0.18; the repeat moves 0.25.
        _refuse_noisy(evaluate, "def solve():\n    return 1\n", (0, 1, 2), 0.80, 0.62)

    said = str(caught.value)
    assert "0.8000" in said and "0.5500" in said  # both numbers, so it is checkable
    assert "noise" in said


def test_a_steady_scoring_is_left_alone() -> None:
    """The common case: a deterministic evaluator repeats exactly, on any size."""
    from sciencediscovery_evolve.probe import _refuse_noisy

    def evaluate(_code, _shards):
        return True, {"score": 0.80}, ""

    _refuse_noisy(evaluate, "def solve():\n    return 1\n", (0, 1, 2), 0.80, 0.62)


def test_a_flat_scoring_is_not_re_measured() -> None:
    """Already refused as flat; a second reading costs an evaluation and adds nothing."""
    from sciencediscovery_evolve.probe import _refuse_noisy

    calls = []

    def evaluate(_code, _shards):
        calls.append(1)
        return True, {"score": 0.80}, ""

    _refuse_noisy(evaluate, "code", (0,), 0.80, 0.7995)
    assert calls == []


def test_a_start_with_almost_nothing_left_to_win_is_refused() -> None:
    """Close to the threshold is as useless as past it, and quieter.

    Seen live: a SQL normaliser started at 0.8477 against a 0.999 threshold and
    finished `bestNodeIndex: 0` — four candidates, none of which beat the seed.
    Everything "worked"; there was just nothing left to win.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_thin_headroom

    class _Spec:
        scorecard = {"solvedThreshold": 0.999}

    with pytest.raises(ProbeError) as caught:
        _refuse_thin_headroom(_Spec(), 0.8477, 0.0, 0.999)

    said = str(caught.value)
    assert "0.8477" in said and "0.999" in said  # checkable numbers, not a verdict


def test_a_start_inside_the_recommended_band_is_left_alone() -> None:
    """0.3-0.7 is what the design guidance asks for; refusing it would be absurd."""
    from sciencediscovery_evolve.probe import _refuse_thin_headroom

    class _Spec:
        scorecard = {"solvedThreshold": 0.999}

    for baseline in (0.30, 0.45, 0.70):
        _refuse_thin_headroom(_Spec(), baseline, 0.0, 0.999)


def test_headroom_is_judged_against_the_scoring_s_own_resolution() -> None:
    """A high score is fine when the scoring cannot resolve much anyway.

    Judged against the damage signal rather than a second invented threshold: if
    breaking the start only moves it 0.05, then 0.099 of headroom is two real
    changes' worth, not a dead end.
    """
    from sciencediscovery_evolve.probe import _refuse_thin_headroom

    class _Spec:
        scorecard = {"solvedThreshold": 0.999}

    _refuse_thin_headroom(_Spec(), 0.90, 0.85, 0.999)


def test_a_text_candidate_is_damaged_by_replacing_it_not_by_hollowing() -> None:
    """`custom_script` does not promise the candidate is Python.

    Hollowing out functions is a no-op on prose, and the probe then reads
    baseline == worsened and calls the *scoring* flat. Seen live three times in
    a row on one run — `0.1625 vs 0.1625`, exactly equal — and the author
    rewrote a scorer that was working correctly.
    """
    from sciencediscovery_evolve.probe import _damage

    prose = "This product adopts an industry-leading advanced technical architecture, able to provide quality service to the broad user base."
    damaged, label = _damage(prose)

    assert damaged.strip() != prose.strip()
    assert "empty phrases" in label


def test_code_is_still_damaged_by_hollowing() -> None:
    from sciencediscovery_evolve.probe import _damage

    code = "def solve(f, y0, t):\n    return y0 * 2\n"
    damaged, label = _damage(code)

    assert "y0 * 2" not in damaged
    assert "def solve" in damaged        # the name survives; the answer does not
    assert "hollowed out" in label


def test_damage_labels_read_correctly_in_both_sentences() -> None:
    """One label is spliced into two different sentences.

    The refusal says "damaging the starting point ({label}) barely moved the
    score", and the run card says "{label}: 0.0000". Both need a noun phrase,
    so a label written as an instruction ("hollow out every function body")
    reads wrong in at least one of them.
    """
    from sciencediscovery_evolve.probe import _damage

    for source in ("def f():\n    return 1\n", "A piece of plain text with no functions."):
        _damaged, label = _damage(source)
        first, _, _rest = label.partition(" ")
        assert not first.endswith("ing") or first == "hollowing", label
        assert not label.endswith("."), label


def test_the_probe_measures_the_slots_the_run_gates_on() -> None:
    """One program, one starting point — not 0.7157 in the probe and 0.2218 on the card.

    The engine holds out the tail of the slot list, so every node score the run
    reports is measured on the gate slots. A probe that reads `range(gate)`
    measures the first rollout slots instead, and with one case generator per
    shard those are different problems.
    """
    from sciencediscovery_evolve.probe import _gate_slots

    class _Spec:
        scorecard = {"criteria": [{"measure": {"split": {
            "rolloutShards": 8, "gateShards": 4, "testShards": 4,
        }}}]}

    assert _gate_slots(_Spec()) == (8, 9, 10, 11)


def test_a_scoring_that_pays_for_failing_to_import_is_refused() -> None:
    """Guarding the import is easy to get structurally right and backwards.

    Seen live, and it produced a winner: `if _cand is None: return 1.0` — where
    1.0 was the best score. The search's best candidate raised at import and sat
    at a perfect 1.0000 on both the rollout and the held-out gate. Nothing looked
    wrong: the probe had passed, because a hollowed-out module still imports.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_rewarding_the_unimportable

    with pytest.raises(ProbeError) as caught:
        _refuse_rewarding_the_unimportable(
            lambda _code, _shards: (True, {"score": 1.0}, ""), (0, 1), 0.3704)

    said = str(caught.value)
    assert "1.0000" in said and "0.3704" in said   # both numbers, checkable
    assert "worst" in said                           # and what to change


def test_a_scoring_that_marks_it_worst_is_left_alone() -> None:
    from sciencediscovery_evolve.probe import _refuse_rewarding_the_unimportable

    _refuse_rewarding_the_unimportable(
        lambda _code, _shards: (True, {"score": 0.0}, ""), (0, 1), 0.3704)


def test_an_evaluator_that_dies_on_the_unimportable_one_is_left_to_its_own_message() -> None:
    """That is the other failure mode and it already has a diagnosis of its own."""
    from sciencediscovery_evolve.probe import _refuse_rewarding_the_unimportable
    from sciencediscovery_evolve.script_domain import ScriptError

    def evaluate(_code, _shards):
        raise ScriptError("the evaluator crashed on its own")

    _refuse_rewarding_the_unimportable(evaluate, (0,), 0.5)


def test_a_diagnosis_of_bare_exception_names_is_refused() -> None:
    """`type(e).__name__` satisfies "fill the error field" and says nothing.

    Seen live: six identical "IndexError"s reached the reflector, which had
    nothing to fix and re-rolled the whole approach every expansion — LZ77, then
    PPM-D, then BWT+MTF+RLE — each with a fresh bug. Five of six candidates
    scored exactly 0.000.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_nameless_diagnosis

    with pytest.raises(ProbeError) as caught:
        _refuse_nameless_diagnosis("text13: exc IndexError; text37: exc IndexError")

    assert "class name" in str(caught.value)


def test_a_diagnosis_that_carries_the_message_passes() -> None:
    from sciencediscovery_evolve.probe import _refuse_nameless_diagnosis

    for said in (
        "text13: IndexError: list index out of range",
        "vanderpol: err=3.51, score=0.0000, nfev=1999",
        "",                                    # empty is handled elsewhere
    ):
        _refuse_nameless_diagnosis(said)


def test_a_crash_report_without_a_line_number_is_refused():
    """`repr(e)` clears the nameless gate and is still unrepairable.

    Measured on a live compression run: five candidates crashed, the repair
    fired four times and landed once, and every diagnosis it worked from named
    an exception with no file and no line. Two of the five were literally the
    same one-line bug — `bytearray.append` of a value wider than a byte — found
    from scratch each time because nothing said where to look.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_locationless_diagnosis

    for said in (
        "no valid cases; case 0(prose): ValueError('byte must be in range(0, 256)')",
        "case 0(prose): error('unpack requires a buffer of 2 bytes')",
    ):
        with pytest.raises(ProbeError) as refusal:
            _refuse_locationless_diagnosis(said)
        assert "not where" in str(refusal.value)


def test_a_semantic_failure_needs_no_line_number():
    """The gate must not refuse the evaluators that report best.

    A round trip that does not match, or a budget overrun, happens at no
    particular line — there is nothing to point at, and demanding a location
    would turn the clearest diagnoses into refusals.
    """
    from sciencediscovery_evolve.probe import _refuse_locationless_diagnosis

    for said in (
        "case 0(prose): lossy round-trip (len 13641 != 13641)",
        "3 of 6 cases blew the evaluation budget; the rest are fine",
        "",
        # Already located, in either of the two shapes a traceback gives.
        'Traceback (most recent call last):\n  File "candidate.py", line 87\nValueError(1)',
        "case 1: IndexError('index out of range') at candidate.py:87",
    ):
        _refuse_locationless_diagnosis(said)      # must not raise


def test_the_location_gate_costs_no_extra_evaluation():
    """It reads the text the damaged-candidate scoring already produced.

    It has to stay free: the probe already spends seven evaluations, and a gate
    that paid for an eighth would be charging every run for a check on the run's
    own reporting.
    """
    import inspect

    from sciencediscovery_evolve import probe

    source = inspect.getsource(probe._refuse_locationless_diagnosis)
    assert "evaluate" not in source, "this gate must not run the evaluation a second time"


def test_run_probe_actually_runs_the_location_gate():
    """The tests above call the gate; this pins that the probe does.

    Removing the one wiring line left all of them passing — a gate exercised
    directly proves the gate works, never that anything reaches it. Twice
    already today a corrected condition went on passing beside a copy of
    itself; this is the same hole with the copy left out.
    """
    import inspect

    from sciencediscovery_evolve import probe

    source = inspect.getsource(probe.run_probe)
    assert "_refuse_locationless_diagnosis(" in source
    # Beside its sibling, on the text the damaged-candidate scoring produced.
    assert "_refuse_nameless_diagnosis(damaged_why)" in source
    assert "_refuse_locationless_diagnosis(damaged_why)" in source


#: A starting point the behavioural gates can wrap: Python, with one
#: module-level function, which is all they need to know about a candidate.
BASELINE_SOURCE = "def solve(values):\n    return sum(values)\n"


def test_a_scoring_that_pays_a_candidate_for_damaging_its_input_is_refused():
    """The reported exploit: a perfect score for wrecking the data being scored.

    A candidate that returns the starting point's own answer and zeroes the
    numbers it was handed must score what the starting point scores. When it
    scores better, the evaluator is validating or calculating from the
    candidate's own object — which one real evaluator did by measuring its
    baseline before the call and the candidate's total after it, from the same
    mutable list.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_input_mutation

    with pytest.raises(ProbeError) as caught:
        _refuse_input_mutation(lambda _code, _shards: (True, {"score": 1.0}, ""),
                               BASELINE_SOURCE, (0, 1), 0.5000)

    said = str(caught.value)
    assert "1.0000" in said and "0.5000" in said      # both numbers, checkable
    assert "candidate_copy" in said                    # and what to change


def test_a_scoring_that_resists_input_damage_is_left_alone():
    from sciencediscovery_evolve.probe import _refuse_input_mutation

    # Equal to the starting point: the candidate's edits never reached the data.
    _refuse_input_mutation(lambda _code, _shards: (True, {"score": 0.5}, ""),
                           BASELINE_SOURCE, (0, 1), 0.5)
    # Lower: a candidate that loses points by damaging its own input is a bad
    # candidate, not a broken measuring apparatus.
    _refuse_input_mutation(lambda _code, _shards: (True, {"score": 0.2}, ""),
                           BASELINE_SOURCE, (0, 1), 0.5)


def test_a_small_wobble_above_the_start_is_not_called_input_damage():
    """The allowance is relative to the damage signal, as for the timeout gate.

    A scoring that wobbles by a hundredth is inside what `_refuse_noisy` accepts
    against a 0.5 signal, so refusing it as "the score comes from the
    candidate's own data" would be a false accusation. The measured shape:
    `_refuse_noisy` passes 0.52 against a 0.5 baseline, so this gate must too.
    """
    from sciencediscovery_evolve.probe import _refuse_input_mutation

    _refuse_input_mutation(lambda _code, _shards: (True, {"score": 0.52}, ""),
                           BASELINE_SOURCE, (0, 1), 0.50, signal=0.5)
    # And a real inflation is still refused with the same signal in hand.
    with pytest.raises(ProbeError):
        _refuse_input_mutation(lambda _code, _shards: (True, {"score": 1.0}, ""),
                               BASELINE_SOURCE, (0, 1), 0.50, signal=0.5)


def test_an_evaluator_that_a_single_non_returning_call_takes_down_is_refused():
    """No per-call limit at all: the whole evaluation runs into the outer timeout."""
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout
    from sciencediscovery_evolve.script_domain import ScriptError

    def evaluate(_code, _shards):
        raise ScriptError("the evaluator ran for over 90s without finishing")

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(evaluate, BASELINE_SOURCE, (0, 1))

    said = str(caught.value)
    assert "never returns" in said
    assert "call_with_deadline" in said      # the fix, by name
    assert "stops waiting" in said           # and why a thread wait is not it


def test_a_timeout_that_invalidates_the_whole_run_is_refused():
    """A timed-out case is a failed case, not a failed run.

    Marking the evaluation invalid throws away every other case's score, so a
    partially-timed-out candidate is reported as no measurement at all.
    """
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(
            lambda _code, _shards: (False, {"score": float("-inf")}, "case 3: timed out"),
            BASELINE_SOURCE, (0, 1))

    assert "failed case, not a failed run" in str(caught.value)


def test_a_timeout_whose_handling_is_not_repeatable_is_refused():
    """Leftover work from a timed-out call shows up as an unstable next score."""
    from sciencediscovery_evolve.probe import ProbeError, _refuse_ineffective_timeout

    scores = iter([0.5, 0.9])

    with pytest.raises(ProbeError) as caught:
        _refuse_ineffective_timeout(lambda _code, _shards: (True, {"score": next(scores)}, ""),
                                    BASELINE_SOURCE, (0, 1))

    said = str(caught.value)
    assert "0.5000" in said and "0.9000" in said
    assert "not repeatable" in said


def test_a_repeatable_partial_score_after_a_timeout_is_left_alone():
    """The legacy shape: a daemon-thread watchdog survives and repeats.

    Existing scripts are not refused for not using the framework's facility —
    that absence is disclosed instead, because nothing outside the process can
    tell a stopped thread from a sleeping one.
    """
    from sciencediscovery_evolve.probe import _refuse_ineffective_timeout

    _refuse_ineffective_timeout(lambda _code, _shards: (True, {"score": 0.25}, ""),
                                BASELINE_SOURCE, (0, 1), [[]])


def test_the_probe_says_which_timeout_checks_it_could_not_perform(monkeypatch):
    """Not performed is not the same as passed, and saying which is the point."""
    from sciencediscovery_evolve import probe

    said: List[str] = []
    monkeypatch.setattr(probe.log, "info",
                        lambda message, *args: said.append(message % args if args else message))

    probe._report_timeout_observations([], [])           # no staged facility at all
    assert "could not be observed" in said[-1]
    probe._report_timeout_observations([{"outcome": "ok"}], [])   # the deadline never fired
    assert "never fired" in said[-1]
    probe._report_timeout_observations(
        [{"outcome": "deadline", "target": "candidate.solve"}], [])
    assert "no later candidate call completed" in said[-1]
    probe._report_timeout_observations(
        [{"outcome": "deadline", "target": "candidate.solve"}, {"outcome": "ok"}], [])
    assert "later candidate call(s) completed" in said[-1]


def test_run_probe_actually_runs_the_behavioural_gates():
    """Named wiring for the two gates #1437 needs, as for the diagnosis gates.

    They are cheap to leave out and impossible to notice: everything else in the
    probe still passes without them, and the defect they exist for only appears
    in a run.
    """
    import inspect

    from sciencediscovery_evolve import probe

    source = inspect.getsource(probe.run_probe)
    assert "_refuse_input_mutation(" in source
    assert "_refuse_ineffective_timeout(" in source
    # The timeout gate reads the records the domain collected, not a guess.
    assert "observations" in source


def test_a_small_wobble_on_a_timed_candidate_is_not_called_leftover_work():
    """The repeatability allowance is relative to what a real change is worth.

    A scoring that discriminates strongly can still wobble by a hundredth. The
    allowance is a tenth of the damage signal (never below `TOLERANCE`), so
    ordinary jitter is not mistaken for a timed-out call's leftover work — 0.02
    apart against a 0.5 signal is inside it.
    """
    from sciencediscovery_evolve.probe import _refuse_ineffective_timeout

    scores = iter([0.50, 0.52])
    _refuse_ineffective_timeout(lambda _code, _shards: (True, {"score": next(scores)}, ""),
                                BASELINE_SOURCE, (0, 1), signal=0.5)


def test_a_constraint_relative_to_the_baseline_does_not_invalidate_the_timeout_check(monkeypatch):
    """The timeout check scores a deliberately broken candidate, so it drops the card's constraints.

    Merge-time regression (#1453 vs main): the timeout check has to normalise
    against the frozen starting point, but once it does, a constraint relative to
    that baseline ("no slower than 1.5x the starting point") is legitimately
    violated by the hostile candidate the check builds. `script_domain` reports a
    violated constraint as `valid: false`, `_measure` folds that to `None`, and
    `_refuse_ineffective_timeout` then refuses with "one timed-out case turned the
    whole evaluation invalid" — a false accusation against an evaluator that does
    keep its per-call deadline. The check therefore runs on a constraint-free copy
    of the card while still using the real frozen reference.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve import script_domain as script_module
    from sciencediscovery_evolve.engine import RunSpec
    from sciencediscovery_evolve.outcome import SCORE_KEY, VIOLATED_KEY, build_outcome
    from sciencediscovery_evolve.scorecard import score_candidate
    from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability
    from test_outcome import clamp_card

    card = clamp_card(
        "score", kind="custom_script", normalize={"kind": "relative_to_baseline"},
        split={"gateShards": 1, "rolloutShards": 1, "seed": 0, "shardRows": 0, "testShards": 0},
        constraints=[{"id": "too-slow", "criterionId": "score", "op": "<=",
                      "value": {"relativeToBaseline": 1.5}}],
    )
    card["criteria"][0]["direction"] = "minimize"
    baseline_code = "def solve(x):\n    return x + 1\n"
    domains: List[Dict[str, Any]] = []

    class _Domain:
        def __init__(self, scorecard: Dict[str, Any], reference: Dict[str, float]) -> None:
            self.scorecard = scorecard
            self.reference = reference
            self.rewards: List[float] = []

        def evaluate(self, code: str, _shards: Any):
            # The starting point measures 0.6, every deliberately broken
            # candidate 1.2, and each is normalised against the reference this
            # domain was handed — the same arithmetic `script_domain` does, with
            # its constraint-to-invalid mapping on top.
            raw = {"score": 0.6 if code == baseline_code else 1.2}
            scored = score_candidate(self.scorecard, raw, self.reference or raw)
            metrics = build_outcome(raw=raw, scored=scored)
            self.rewards.append(scored.reward)
            if scored.violations:
                metrics[SCORE_KEY] = float("-inf")
                metrics[VIOLATED_KEY] = scored.violations[0].constraint_id
                return False, metrics, scored.violations[0].detail
            return True, metrics, ""

    def fake_script_domain(*, scorecard: Dict[str, Any], baseline: Dict[str, float],
                           **_kwargs: Any) -> _Domain:
        domain = _Domain(scorecard, baseline)
        domains.append({"scorecard": scorecard, "baseline": baseline, "domain": domain})
        return domain

    monkeypatch.setattr(script_module, "script_domain", fake_script_domain)
    spec = RunSpec(
        search_id="probe-custom", algorithm="puct", expansions=1, scorecard_hash="sha256:score",
        scorecard=card, statement="sort it", baseline_code=baseline_code, script="evaluator",
        sandbox=SandboxCapability(),
    )

    # Not refused: the run reaches its result, and the card itself still carries
    # the constraint the run was created with.
    result = probe_module.run_probe(spec)
    assert result["baseline"] == pytest.approx(0.5)
    assert card["constraints"], "the run's own scorecard must not be mutated"

    main_domain, timeout_domain = domains[0], domains[-1]
    # The main domain keeps the card's constraints; only the timeout check drops them.
    assert main_domain["scorecard"]["constraints"] == card["constraints"]
    assert timeout_domain["scorecard"]["constraints"] == []
    # And the timeout check still normalises against the frozen starting point:
    # 1.2 against a 0.6 baseline is 1/3, not the self-normalised 0.5 an empty
    # reference would give.
    assert timeout_domain["baseline"] == {"score": pytest.approx(0.6)}
    assert timeout_domain["domain"].rewards
    assert all(reward == pytest.approx(1 / 3) for reward in timeout_domain["domain"].rewards)


#: An evaluator with a real per-call deadline: the shape the guidance asks for,
#: and the one the timeout check must not refuse. A failed case scores zero, so a
#: candidate that hangs once and raises once measures below the starting point.
DEADLINE_EVALUATOR = '''
"""solve(shard) -> float: the score for that shard, 0.0 being worst."""
import json, os
import candidate
import evaluator_support

shards = [int(part) for part in os.environ["SCIENCE_AGENT_SHARDS"].split(",") if part != ""]
total, failures = 0.0, []
for shard in shards:
    try:
        total += float(evaluator_support.call_with_deadline(candidate.solve, shard, timeout=0.5))
    except (evaluator_support.DeadlineExceeded, evaluator_support.CallFailed) as error:
        failures.append("case %d: %s" % (shard, error))
with open(os.environ["SCIENCE_AGENT_RESULT"], "w") as handle:
    json.dump({"valid": True, "metrics": {"score": total / max(len(shards), 1)},
               "error": "; ".join(failures)}, handle)
'''

#: The starting point every case of the deadline evaluator scores 1.0 on.
DEADLINE_BASELINE = "def solve(shard):\n    return 1.0\n"


def test_a_relative_constraint_does_not_refuse_a_deadline_evaluator_in_the_real_domain():
    """The real second domain, the real evaluator: no refusal, same arithmetic.

    The unit test above pins the wiring; this one runs `script_domain` itself
    (through the `direct` backend, as `test_evaluator_support` does) on a card
    whose `relativeToBaseline` constraint the check's deliberately broken
    candidate genuinely violates. The card's constraint still rejects that
    candidate — that is what a run's own scoring is for — but the timeout check
    must not read it as an invalid run, and it must still divide by the frozen
    starting point.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve.engine import RunSpec
    from sciencediscovery_evolve.outcome import VIOLATED_KEY
    from sciencediscovery_evolve.script_domain import script_domain
    from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability
    from test_outcome import clamp_card

    card = clamp_card(
        "score", kind="custom_script", normalize={"kind": "relative_to_baseline"},
        split={"gateShards": 4, "rolloutShards": 1, "seed": 0, "shardRows": 0, "testShards": 0},
        constraints=[{"id": "no-sacrifice", "criterionId": "score", "op": ">=",
                      "value": {"relativeToBaseline": 0.8}}],
    )
    shards = (0, 1, 2, 3)
    spec = RunSpec(
        search_id="probe-custom", algorithm="puct", expansions=1, scorecard_hash="sha256:score",
        scorecard=card, statement="sort it", baseline_code=DEADLINE_BASELINE,
        script=DEADLINE_EVALUATOR, candidate_timeout_seconds=10.0,
        sandbox=SandboxCapability(backend="direct"),
    )
    observations: List[List[Dict[str, Any]]] = []

    # The run's own scoring does reject the broken candidate: it keeps two of the
    # four cases and lands at half the starting point, under the card's 0.8x
    # floor. That is the `valid: false` the timeout check must not inherit.
    with_constraints = script_domain(
        scorecard=card, script=DEADLINE_EVALUATOR, capability=SandboxCapability(backend="direct"),
        baseline_code=DEADLINE_BASELINE, candidate_timeout=10.0, baseline={"score": 1.0},
    )
    hostile = probe_module._hostile_candidate(DEADLINE_BASELINE, hang_first=True)
    assert hostile is not None
    valid, metrics, detail = with_constraints.evaluate(hostile, shards)
    assert valid is False
    assert metrics[VIOLATED_KEY] == "no-sacrifice"
    assert "does not satisfy >= 0.8" in detail

    timeout_domain, limit, bound = probe_module._timeout_check_domain(
        spec, observations, 0.0, reference={"score": 1.0},
    )
    # The check still divides by the frozen starting point: a candidate at 0.5
    # against a 1.0 baseline is 2/3, where an empty reference would read 0.5.
    worse = probe_module._score(timeout_domain.evaluate, "def solve(shard):\n    return 0.5\n", shards)
    assert worse == pytest.approx(2 / 3, abs=1e-6)
    # And a correct per-call deadline is not refused for the broken candidate's
    # quality: the check answers only "alive inside the bound, same twice".
    probe_module._refuse_ineffective_timeout(
        timeout_domain.evaluate, DEADLINE_BASELINE, shards,
        observations=observations, limit=limit, bound=bound, baseline_seconds=0.0,
    )
