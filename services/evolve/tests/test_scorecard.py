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

"""Scoring a candidate, and refusing one that broke a constraint.

The first test is the one that keeps this honest: the same formulas exist in
TypeScript for the wizard, and a shared fixture makes a divergence a failing
test rather than two answers to "what is this candidate worth".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sciencediscovery_evolve.scorecard import (
    aggregate,
    evaluate_constraints,
    normalize,
    score_candidate,
)

_GOLDEN = Path(__file__).resolve().parents[3] / "packages/schema/fixtures/scorecard-golden.json"


def _golden_cases():
    return json.loads(_GOLDEN.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _golden_cases(), ids=lambda case: case["name"])
def test_python_and_typescript_score_a_candidate_identically(case) -> None:
    """One card, one answer.

    The control plane scores for the wizard's preview and this side scores the
    run; if they disagree, a user is shown a number the search does not use.
    """
    result = score_candidate(case["scorecard"], case["raw"], case["baseline"])
    expected = case["expected"]

    assert result.reward == pytest.approx(expected["reward"], abs=1e-9)
    assert sorted(v.constraint_id for v in result.violations) == expected["violations"]
    for criterion_id, value in expected["criteria"].items():
        assert result.criteria[criterion_id] == pytest.approx(value, abs=1e-9)


def test_every_normalisation_produces_higher_is_better() -> None:
    identity = {"id": "a", "direction": "maximize", "normalize": {"kind": "identity"}}
    assert normalize(identity, 0.8, 0.5) > normalize(identity, 0.6, 0.5)

    reciprocal = {"id": "a", "direction": "minimize", "normalize": {"kind": "reciprocal"}}
    assert normalize(reciprocal, 0.2, 1.0) > normalize(reciprocal, 2.0, 1.0)

    relative = {"id": "a", "direction": "minimize", "normalize": {"kind": "relative_to_baseline"}}
    assert normalize(relative, 150, 300) > normalize(relative, 400, 300)


def test_the_reference_is_the_baseline_and_nothing_else() -> None:
    """A drifting reference would make yesterday's 0.8 and today's 0.8 different
    numbers, pollute the acceptance prior, and make a replay score differently."""
    runtime = {"id": "runtime", "direction": "minimize", "normalize": {"kind": "relative_to_baseline"}}
    assert normalize(runtime, 200, 200) == 0.5
    assert normalize(runtime, 200, 100) == 1 / 3


def test_beating_the_baseline_keeps_improving_rather_than_pinning_at_one() -> None:
    """The bug this replaced: ``clamp(baseline / raw)`` hit its bound the moment
    a candidate was better, so every improvement tied — and with the default
    solved threshold the baseline itself scored 1.0 and the search stopped
    before its first expansion. Seen on a real run."""
    runtime = {"id": "runtime", "direction": "minimize", "normalize": {"kind": "relative_to_baseline"}}
    scores = [normalize(runtime, raw, 200) for raw in (400, 200, 100, 50, 20)]

    assert scores == sorted(scores)
    assert len(set(scores)) == len(scores)
    # Bounded, and never at the bound: a better candidate always outranks a good
    # one, and nothing counts as solved for merely beating the start.
    assert scores[-1] < 1.0


def test_junk_measurements_clamp_rather_than_escape() -> None:
    identity = {"id": "a", "direction": "maximize", "normalize": {"kind": "identity"}}
    assert normalize(identity, float("nan"), 0.5) == 0.0
    assert normalize(identity, float("inf"), 0.5) == 0.0
    assert normalize(identity, None, 0.5) == 0.0


def test_an_unmeasured_criterion_cannot_violate_a_constraint() -> None:
    card = {
        "criteria": [{"id": "runtime", "direction": "minimize", "normalize": {"kind": "identity"}, "weight": 1}],
        "constraints": [{"id": "too-slow", "criterionId": "runtime", "op": "<", "value": 300}],
    }
    # Unknown is not failure. Refusing a run whose criteria cannot be measured
    # is the validator's job, and it happens before any of this.
    assert evaluate_constraints(card, {}, {}) == []


def test_weights_that_do_not_sum_to_one_are_used_as_fractions() -> None:
    card = {
        "aggregate": "weighted_sum",
        "criteria": [
            {"id": "a", "direction": "maximize", "normalize": {"kind": "identity"}, "weight": 3},
            {"id": "b", "direction": "maximize", "normalize": {"kind": "identity"}, "weight": 1},
        ],
    }
    assert aggregate(card, {"a": 1.0, "b": 0.0}) == 0.75


# --- the acceptance policy --------------------------------------------------


class _Candidate:
    def __init__(self, content_hash: str) -> None:
        self.content_hash = content_hash


class _Inner:
    """Stands in for `DefaultAcceptance`: records whether it was consulted."""

    def __init__(self) -> None:
        self.calls = 0

    def accept(self, ctx):
        from agentdescent.policies import AcceptDecision

        self.calls += 1
        return AcceptDecision(accept=True, category="", detail="inner said yes")


def _ctx(candidate):
    class _Ctx:
        pass

    ctx = _Ctx()
    ctx.candidate = candidate
    return ctx


CARD = {
    "aggregate": "weighted_sum",
    "criteria": [
        {"id": "f1", "direction": "maximize", "normalize": {"kind": "identity"}, "weight": 0.7},
        {"id": "runtime", "direction": "minimize", "normalize": {"kind": "relative_to_baseline"}, "weight": 0.3},
    ],
    "constraints": [{"id": "too-slow", "criterionId": "runtime", "op": "<", "value": 300}],
}


def test_the_veto_does_not_change_what_a_candidate_is_worth() -> None:
    """The whole reason the veto is not "score 0": every violating candidate
    would tie, and the tree's exploitation term reads ranks — the tie would
    flatten exactly the signal the search steers by."""
    baseline = {"f1": 0.6, "runtime": 200}
    slow_but_good = score_candidate(CARD, {"f1": 0.9, "runtime": 412}, baseline)
    fast_and_ok = score_candidate(CARD, {"f1": 0.71, "runtime": 180}, baseline)

    assert slow_but_good.violations, "it is illegal"
    assert slow_but_good.reward > 0, "and it still has a score"
    assert slow_but_good.criteria["f1"] > fast_and_ok.criteria["f1"]
