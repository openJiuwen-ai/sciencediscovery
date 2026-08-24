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
