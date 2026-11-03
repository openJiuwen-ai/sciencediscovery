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

"""Whether a finished run's gate result is evidence of anything.

`bestTestScore` is one evaluation of one candidate. Without the baseline on the
same cases there is nothing to pair it against, so the number cannot say whether
the difference is real. These tests pin the paired statistic and the event that
carries it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_evolve import events
from sciencediscovery_evolve.acceptance import paired_evidence
from sciencediscovery_evolve.completion import CompletionUsage
from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.puct_engine import PuctEngine
from sciencediscovery_evolve.test_gate_domain import TestGateError
from sciencediscovery_evolve.vendor.puct.domain import Domain
from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability


def _cases(wins: int, losses: int, ties: int = 0) -> Tuple[Dict[str, bool], Dict[str, bool]]:
    """`(baseline, candidate)` with the requested win/loss/tie counts."""
    baseline: Dict[str, bool] = {}
    candidate: Dict[str, bool] = {}
    for index in range(wins):
        baseline[f"win-{index}"] = False
        candidate[f"win-{index}"] = True
    for index in range(losses):
        baseline[f"loss-{index}"] = True
        candidate[f"loss-{index}"] = False
    for index in range(ties):
        baseline[f"tie-{index}"] = True
        candidate[f"tie-{index}"] = True
    return baseline, candidate


# --- the statistic ------------------------------------------------------------


def test_eight_wins_and_no_losses_is_established() -> None:
    baseline, candidate = _cases(8, 0)
    evidence = paired_evidence(baseline, candidate, alpha=0.05)

    assert (evidence["wins"], evidence["losses"], evidence["ties"], evidence["n"]) == (8, 0, 0, 8)
    # Two-sided exact p with 8 decided cases: 2 * (1/2)**8.
    assert evidence["pValue"] == pytest.approx(0.0078125)
    assert evidence["alpha"] == 0.05
    assert evidence["verdict"] == "established"


def test_seven_of_eight_is_not_established() -> None:
    baseline, candidate = _cases(7, 1)
    evidence = paired_evidence(baseline, candidate)

    # 2 * (C(8,0) + C(8,1)) / 256 = 0.0703125, above alpha: the gate can speak
    # and it does not support the claim.
    assert evidence["pValue"] == pytest.approx(0.0703125)
    assert evidence["verdict"] == "not established"


def test_three_and_three_is_insufficient() -> None:
    baseline, candidate = _cases(3, 3)
    evidence = paired_evidence(baseline, candidate)

    assert evidence["n"] == 6
    assert evidence["pValue"] == pytest.approx(1.0)
    # Six decided cases, but no direction at all: the exact p is 1.0 by
    # construction and more cases of this shape could not move it.
    assert evidence["verdict"] == "insufficient"


def test_no_paired_cases_is_insufficient_rather_than_established() -> None:
    evidence = paired_evidence({}, {})

    assert (evidence["wins"], evidence["losses"], evidence["ties"], evidence["n"]) == (0, 0, 0, 0)
    assert evidence["pValue"] == pytest.approx(1.0)
    assert evidence["verdict"] == "insufficient"


@pytest.mark.parametrize("losses", [6, 8])
def test_a_significant_regression_is_never_established(losses: int) -> None:
    # The p-value is two-sided: 0-6 (p=0.03125) and 0-8 (p=0.0078125) are as
    # extreme as 6-0 and 8-0, only in the other direction. `established` is a
    # claim about improvement, so a candidate that lost every case must not be
    # reported as the strongest possible evidence of progress.
    baseline, candidate = _cases(0, losses)
    evidence = paired_evidence(baseline, candidate)

    assert evidence["pValue"] <= 0.05
    assert evidence["wins"] < evidence["losses"]
    assert evidence["verdict"] == "not established"


def test_five_wins_and_three_losses_is_not_established() -> None:
    baseline, candidate = _cases(5, 3)
    evidence = paired_evidence(baseline, candidate)

    # 2 * (C(8,0)+C(8,1)+C(8,2)+C(8,3)) / 256 = 0.7265625: the candidate is
    # ahead on the point estimate and the gate still cannot support "improved".
    assert evidence["pValue"] == pytest.approx(0.7265625)
    assert evidence["verdict"] == "not established"


def test_fewer_than_six_decided_cases_can_never_establish() -> None:
    # Five clean wins would be tempting to call an improvement; the smallest
    # attainable two-sided p at n=5 is 0.0625, so the gate is silent instead.
    baseline, candidate = _cases(5, 0)
    evidence = paired_evidence(baseline, candidate)

    assert evidence["verdict"] == "insufficient"


def test_cases_only_one_side_ran_do_not_pad_the_sample() -> None:
    baseline, candidate = _cases(6, 0)
    candidate["candidate-only"] = True
    baseline["baseline-only"] = False

    evidence = paired_evidence(baseline, candidate)

    # The unpaired ids are dropped rather than counted as ties or wins.
    assert evidence["n"] == 6
    assert evidence["wins"] == 6
    assert evidence["verdict"] == "established"


# --- the event ----------------------------------------------------------------


def test_search_finished_reports_paired_gate_evidence() -> None:
    # The probe from #721, now with the evidence the gate can supply. The field
    # is optional on the wire on purpose (see the absent-case test below), so
    # the channel is exercised by handing it the paired result the engine
    # computes; before this change there was no argument and no field at all.
    event = events.search_finished(
        "completed", 3, 12, best_test_score=0.625,
        gate_evidence={"wins": 5, "losses": 3, "ties": 0, "n": 8,
                       "pValue": 0.7265625, "alpha": 0.05,
                       "verdict": "not established"},
        stop_reason="budget", expansions_planned=20)
    assert "gateEvidence" in event, sorted(event)


def test_gate_evidence_rides_on_the_finish_event() -> None:
    evidence = {"wins": 8, "losses": 0, "ties": 0, "n": 8, "pValue": 0.0078125,
                "alpha": 0.05, "verdict": "established"}
    event = events.search_finished("succeeded", 3, 12, best_test_score=1.0,
                                   gate_evidence=evidence)

    assert event["gateEvidence"] == evidence
    # A copy, so a later mutation by the engine cannot rewrite an emitted event.
    assert event["gateEvidence"] is not evidence


def test_a_finish_event_with_no_evidence_carries_no_field() -> None:
    event = events.search_finished("succeeded", 3, 12, best_test_score=0.5)

    # Absent, not zero-filled: "the gate could not tell" must not read as
    # "the gate looked and found nothing".
    assert "gateEvidence" not in event


# --- the engine ---------------------------------------------------------------

BASELINE = '''"""Baseline."""


def train_and_predict(train_path, test_path):
    return [0.0]
'''

CANDIDATE = '''```python
"""Switched to gradient boosting."""


def train_and_predict(train_path, test_path):
    return [1.0]
```'''

SCORECARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "maximize", "id": "acc", "name": "accuracy",
        "measure": {
            "datasetCas": ["sha256:d"], "kind": "dataset_metric",
            "metric": {"direction": "maximize", "name": "accuracy"},
            "split": {"gateShards": 4, "rolloutShards": 4, "seed": 0,
                      "shardRows": 4, "testShards": 2, "trainRows": None},
            "target": "y",
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:card", "schemaVersion": 1, "solvedThreshold": 0.999,
}


def _spec(**overrides: Any) -> RunSpec:
    base: Dict[str, Any] = {
        "algorithm": "puct", "expansions": 1, "scorecard": SCORECARD,
        "scorecard_hash": "sha256:card", "search_id": "run-1",
        "statement": "Push the accuracy up", "dataset_dir": "/staged",
        "baseline_code": BASELINE, "workers": 1,
        "llm_url": "http://127.0.0.1:4310/x", "llm_token": "run-token",
        "sandbox": SandboxCapability(backend="seatbelt"),
        "options": {"mode": "serial"},
    }
    base.update(overrides)
    return RunSpec(**base)


class GateHarness:
    """A fake model over a gate whose cases the test controls."""

    def __init__(self, baseline_cases: Dict[str, bool], candidate_cases: Dict[str, bool],
                 test_shards: Tuple[int, ...] = (8, 9),
                 baseline_error_in_finish: bool = False) -> None:
        self.baseline_cases = baseline_cases
        self.candidate_cases = candidate_cases
        self.test_shards = test_shards
        self.baseline_error_in_finish = baseline_error_in_finish
        self.events: List[Dict[str, Any]] = []

    def completion_factory(self, _spec: RunSpec, _usage: Any, _stop: Any):
        def complete(prompt: str, sink: Any = None, on_failure: Any = None) -> str:
            if sink is not None:
                sink(CompletionUsage(total=100, completion=20, capped=False))
            return CANDIDATE
        return complete

    def domain_factory(self, **_kwargs: Any) -> Domain:
        def evaluate(code: str, shards: Sequence[int]) -> Tuple[bool, Dict[str, Any], str]:
            if "[0.0]" in code:
                if (self.baseline_error_in_finish
                        and tuple(shards) == tuple(self.test_shards)):
                    # Only the finish() re-score of the starting program hits
                    # the test shards; the seed runs on the gate shards. A gate
                    # that cannot produce a JUnit report there raises instead of
                    # returning invalid, and that must not fail a finished run.
                    raise TestGateError("the test result is not parsable JUnit XML: no report")
                cases, score = self.baseline_cases, 0.375
            else:
                cases, score = self.candidate_cases, 0.625
            return True, {"acc": score, "score": score, "caseResults": dict(cases)}, ""

        return Domain(
            name="test-gate", entrypoint="train_and_predict", metric_key="acc",
            metric_better="higher", initial_program=BASELINE,
            initial_summary="the baseline program",
            evaluate=evaluate,
            reward=lambda metrics: max(0.0, min(1.0, float(metrics.get("score") or 0.0))),
            prompt=lambda program: f"improve this program: {program.change_summary}",
            task_prompt=lambda shard: f"shard {shard}",
            test_shards=self.test_shards,
        )

    def run(self, run_spec: Optional[RunSpec] = None) -> List[Dict[str, Any]]:
        engine = PuctEngine(
            completion_factory=self.completion_factory,
            domain_factory=self.domain_factory,
            store_root=Path(self._store),
        )
        engine.run(run_spec or _spec(), self.events.append, lambda: False)
        return self.events

    _store = "/tmp"

    def finished(self) -> Dict[str, Any]:
        return [event for event in self.events if event["type"] == "search_finished"][-1]

    def logs(self) -> List[str]:
        return [event["message"] for event in self.events if event["type"] == "log"]


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Nothing outside this file: no candidate runtime, no staged dataset."""
    from sciencediscovery_evolve import puct_engine
    from sciencediscovery_evolve.measurement import CriterionPlan, Dataset, Shard

    shards = tuple(
        Shard(index=index, role=role, train=tmp_path / "t.csv",
              test=tmp_path / "x.csv", truth=(1.0,))
        for index, role in [(0, "rollout"), (1, "rollout"), (2, "rollout"), (3, "rollout"),
                            (4, "gate"), (5, "gate"), (6, "gate"), (7, "gate"),
                            (8, "test"), (9, "test")]
    )
    dataset = Dataset((CriterionPlan("acc", "accuracy", shards),))
    monkeypatch.setattr(puct_engine, "load_dataset", lambda root, card: dataset)
    monkeypatch.setattr(puct_engine, "missing_candidate_runtime", lambda: [])
    GateHarness._store = str(tmp_path / "candidates")


def test_a_positive_point_estimate_with_five_of_eight_says_not_established() -> None:
    # The candidate wins 5 of 8 gate cases, which is exactly the case the point
    # estimate alone gets wrong: it prints 0.625 and sounds like progress.
    baseline_cases = {f"case{index}": index >= 5 for index in range(8)}
    candidate_cases = {f"case{index}": index < 5 for index in range(8)}
    harness = GateHarness(baseline_cases, candidate_cases)

    harness.run()

    finished = harness.finished()
    assert finished["bestTestScore"] == pytest.approx(0.625)
    evidence = finished["gateEvidence"]
    assert (evidence["wins"], evidence["losses"], evidence["ties"], evidence["n"]) == (5, 3, 0, 8)
    assert evidence["pValue"] == pytest.approx(0.7265625)
    assert evidence["verdict"] == "not established"


def test_a_run_with_no_test_shards_leaves_the_field_absent_and_says_why() -> None:
    baseline_cases = {f"case{index}": index >= 5 for index in range(8)}
    candidate_cases = {f"case{index}": index < 5 for index in range(8)}
    harness = GateHarness(baseline_cases, candidate_cases, test_shards=())

    harness.run()

    finished = harness.finished()
    assert "bestTestScore" not in finished
    assert "gateEvidence" not in finished, finished
    assert any("no test shards" in message for message in harness.logs()), harness.logs()


def test_when_the_gate_reports_no_cases_the_field_is_absent_and_says_why() -> None:
    # Exposed at n=0 rather than filled with zeros.
    harness = GateHarness({}, {})

    harness.run()

    finished = harness.finished()
    assert "gateEvidence" not in finished, finished
    assert any("no per-case results" in message for message in harness.logs()), harness.logs()


def test_a_baseline_evaluation_that_raises_does_not_fail_the_finished_run() -> None:
    # Regression: a gate that raises on the starting program (no JUnit report,
    # a failed setup, unparsable XML) must not escape finish(), where server.py
    # would turn a completed search into `search_finished("failed", None, 0)`.
    baseline_cases = {f"case{index}": index >= 5 for index in range(8)}
    candidate_cases = {f"case{index}": index < 5 for index in range(8)}
    harness = GateHarness(baseline_cases, candidate_cases, baseline_error_in_finish=True)

    harness.run()

    finished = harness.finished()
    assert finished["status"] != "failed", finished
    # The held-out score the search did earn is still reported; only the
    # baseline half of the pairing is missing.
    assert finished["bestTestScore"] == pytest.approx(0.625)
    assert "gateEvidence" not in finished, finished
    assert any("could not be scored" in message for message in harness.logs()), harness.logs()
