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

from typing import Any, Dict, List

import pytest

from sciencediscovery_evolve.probe import ProbeError, run_probe
from test_era_engine import JUDGED_CARD, judged_spec  # noqa: F401 - shared fixtures


def judge_returning(marks: List[float], monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the probe's judge at a canned sequence of marks."""
    from sciencediscovery_evolve import probe as probe_module

    calls = {"n": 0}

    def completion(spec: Any, on_usage: Any, should_stop: Any):
        def complete(prompt: str, sink: Any = None, on_failure: Any = None) -> str:
            mark = marks[min(calls["n"], len(marks) - 1)]
            calls["n"] += 1
            return str(mark)
        return complete

    monkeypatch.setattr(probe_module, "_default_completion", completion, raising=False)
    import sciencediscovery_evolve.era_engine as engine_module
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
    from sciencediscovery_evolve.vendor.era.program import validate_source

    baseline = (
        "import pandas as pd\n\n\n"
        "def train_and_predict(train_path, test_path):\n"
        "    return [1.0] * len(pd.read_csv(test_path))\n"
    )
    ok, why = validate_source(baseline)
    assert ok, why

    ok, why = validate_source(baseline + _CONSTANT_PREDICTOR)
    assert ok, f"探针的坏副本被门挡了：{why}"


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
    assert "起点" in str(error.value)


def test_a_damaged_copy_that_will_not_score_is_not_counted_as_a_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sciencediscovery_evolve import probe as probe_module

    # A judge that answers for the baseline and then refuses says nothing about
    # discrimination; treating that as "the check passed" would let a flat
    # scorecard through on a transient.
    marks = ["6", "6", "6", "6", "没有数字", "没有数字", "没有数字", "没有数字"]
    calls = {"n": 0}

    def completion(spec: Any, on_usage: Any, should_stop: Any):
        def complete(prompt: str, sink: Any = None, on_failure: Any = None) -> str:
            reply = marks[min(calls["n"], len(marks) - 1)]
            calls["n"] += 1
            return reply
        return complete

    import sciencediscovery_evolve.era_engine as engine_module
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
    judge disagreed with itself. Reporting that as "起点本身就跑不起来" sends the
    user to rewrite a starting point that was never the problem, and leaves the
    rubric that actually needs the work untouched.
    """
    # Marks all over the scale: the spread blows past the variance threshold and
    # the judged domain calls the candidate undecidable rather than bad.
    judge_returning([1, 9, 2, 8, 3, 7, 1, 9], monkeypatch)

    with pytest.raises(ProbeError) as caught:
        run_probe(judged_spec())

    message = str(caught.value)
    assert "这套评分自己就不稳" in message
    assert "跑不起来" not in message
    # And it names the two things that would actually help.
    assert "细则" in message and "次数" in message


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

    assert "没有坡可以爬" in str(caught.value)


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
    assert "噪声" in said


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

    prose = "本产品采用了业界领先的先进技术架构，能够为广大用户提供优质服务。"
    damaged, label = _damage(prose)

    assert damaged.strip() != prose.strip()
    assert "空话" in label


def test_code_is_still_damaged_by_hollowing() -> None:
    from sciencediscovery_evolve.probe import _damage

    code = "def solve(f, y0, t):\n    return y0 * 2\n"
    damaged, label = _damage(code)

    assert "y0 * 2" not in damaged
    assert "def solve" in damaged        # the name survives; the answer does not
    assert "掏空" in label


def test_damage_labels_read_correctly_in_both_sentences() -> None:
    """One label is spliced into "把起点{label}之后" and into "{label}后 0.0000".

    The first spelling used to start with 把 itself, so the refusal read
    "把起点把每个函数体掏空之后" — two 把 in a row, in the one sentence whose
    whole job is to be read and acted on.
    """
    from sciencediscovery_evolve.probe import _damage

    for source in ("def f():\n    return 1\n", "一段纯文本，没有任何函数。"):
        _damaged, label = _damage(source)
        assert not label.startswith("把")


def test_the_probe_measures_the_slots_the_run_gates_on() -> None:
    """One program, one 起点 — not 0.7157 in the probe and 0.2218 on the card.

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
    assert "最差" in said                            # and what to change


def test_a_scoring_that_marks_it_worst_is_left_alone() -> None:
    from sciencediscovery_evolve.probe import _refuse_rewarding_the_unimportable

    _refuse_rewarding_the_unimportable(
        lambda _code, _shards: (True, {"score": 0.0}, ""), (0, 1), 0.3704)


def test_an_evaluator_that_dies_on_the_unimportable_one_is_left_to_its_own_message() -> None:
    """That is the other failure mode and it already has a diagnosis of its own."""
    from sciencediscovery_evolve.probe import _refuse_rewarding_the_unimportable
    from sciencediscovery_evolve.script_domain import ScriptError

    def evaluate(_code, _shards):
        raise ScriptError("评测脚本自己崩了")

    _refuse_rewarding_the_unimportable(evaluate, (0,), 0.5)
