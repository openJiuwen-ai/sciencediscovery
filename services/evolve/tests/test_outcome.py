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

"""A criterion may be called `score` — the raw number must survive the aggregate.

These are the regression tests for #1458. They are written against the number
the report used: a criterion literally named `score`, a raw 0.6, and a clamp to
[0, 2] whose normalised 0.3 is also legitimate. Both must be available, and the
baseline reference `relative_to_baseline` divides by must be the raw 0.6 — not
the aggregate that used to replace it, which left the reference empty and every
candidate normalised against itself (0.5/0.5/0.5 instead of 0.5/0.333/0.667).

Each test fails on the previous shape in a specific way:

* the domain tests: ``metrics == {"score": 0.3}``, raw 0.6 gone;
* the reporter tests: ``criteria == {}``, because the reporter filtered `score`
  out of the payload it published;
* the reference tests: the reference stays empty, so every candidate is
  normalised against itself. On the old flat shape a candidate whose metrics
  held no other numeric key scored 0.5; when it did hold other numeric keys the
  seeding code put those in the reference instead and the colliding criterion
  scored 0.0. Neither is the 0.333/0.667 the raw values imply.

The constraint assertion in the first test is a guard, not a discriminator: it
pins that constraints keep reading raw values now that `score` is no longer
overwritten. The engine-level test drives the real PUCT search, so reverting its
seeding line to `baseline.update(metrics)` turns it red.

No sandbox is used: the transport seams the domains call (`_run_evaluator`,
`measure_shards`, `_run_suite`) are substituted, so these pin the arithmetic and
the payload, not the process isolation, which has tests of its own.
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional, Tuple
from unittest.mock import MagicMock

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_evolve import scorecard_domain as scorecard_domain_module
from sciencediscovery_evolve import script_domain as script_domain_module
from sciencediscovery_evolve import test_gate_domain as test_gate_domain_module
from sciencediscovery_evolve.measurement import Measurement
from sciencediscovery_evolve.outcome import (
    SCORE_KEY,
    build_outcome,
    normalized_criteria,
    raw_measurements,
)
from sciencediscovery_evolve.scorecard_domain import scorecard_domain
from sciencediscovery_evolve.script_domain import script_domain
from sciencediscovery_evolve.test_gate_domain import test_gate_domain as build_gate_domain
from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability


def clamp_card(
    criterion_id: str = "score",
    *,
    kind: str = "identity",
    normalize: Optional[Dict[str, Any]] = None,
    constraints: Optional[List[Dict[str, Any]]] = None,
    split: Optional[Dict[str, Any]] = None,
    case_split: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One-criterion card, shaped like the ones the control plane writes."""
    measure: Dict[str, Any] = {"kind": kind}
    if split is not None:
        measure["split"] = split
    if case_split is not None:
        measure["caseSplit"] = case_split
    return {
        "aggregate": "weighted_sum",
        "constraints": constraints or [],
        "criteria": [{
            "direction": "maximize",
            "id": criterion_id,
            "measure": measure,
            "name": criterion_id,
            "normalize": normalize or {"kind": "identity"},
            "weight": 1.0,
        }],
        "hash": "sha256:" + criterion_id,
        "schemaVersion": 1,
        "solvedThreshold": 0.999,
    }


def raw_clamp() -> Dict[str, Any]:
    """A non-identity map: raw 0.6 becomes 0.3, so the two cannot be confused."""
    return {"kind": "clamp", "lo": 0.0, "hi": 2.0}


SPLIT = {"gateShards": 1, "rolloutShards": 1, "seed": 0, "shardRows": 0, "testShards": 0}


# --- the three executable domains --------------------------------------------


def test_custom_script_keeps_the_raw_measurement_of_a_criterion_named_score(monkeypatch):
    card = clamp_card(
        "score", kind="custom_script", normalize=raw_clamp(), split=SPLIT,
        constraints=[{"id": "floor", "criterionId": "score", "op": ">=", "value": 0.5}],
    )
    monkeypatch.setattr(
        script_domain_module, "_run_evaluator",
        lambda *_args, **_kwargs: {"valid": True, "metrics": {"score": 0.6}, "error": ""},
    )
    domain = script_domain(scorecard=card, script="anything", capability=SandboxCapability())

    valid, metrics, error = domain.evaluate("candidate", (0,))

    # 0.6 is the measurement; 0.3 is its normalised form. Neither replaces the
    # other, and the aggregate the tree ranks on is still the normalised one.
    assert valid, error
    assert raw_measurements(metrics)["score"] == pytest.approx(0.6)
    assert normalized_criteria(metrics)["score"] == pytest.approx(0.3)
    assert metrics[SCORE_KEY] == pytest.approx(0.3)
    # Constraints read raw, so a 0.6 measurement satisfies a >= 0.5 floor even
    # though its normalised value is 0.3. Checking the aggregate would veto it.
    assert "violated" not in metrics


def test_dataset_metric_keeps_the_raw_measurement_of_a_criterion_named_score(monkeypatch, tmp_path):
    card = clamp_card("score", normalize=raw_clamp(), split=SPLIT)
    monkeypatch.setattr(scorecard_domain_module, "shard_indices", lambda *_args: (0,))
    monkeypatch.setattr(
        scorecard_domain_module, "measure_shards",
        lambda *_args, **_kwargs: Measurement(ok=True, values={"score": 0.6}, seconds=1.5),
    )
    domain = scorecard_domain(
        scorecard=card, dataset=None, capability=SandboxCapability(),  # type: ignore[arg-type]
    )

    valid, metrics, error = domain.evaluate("candidate", (0,))

    assert valid, error
    assert raw_measurements(metrics)["score"] == pytest.approx(0.6)
    assert normalized_criteria(metrics)["score"] == pytest.approx(0.3)
    assert metrics[SCORE_KEY] == pytest.approx(0.3)
    # The reserved auxiliary name still means what it says.
    assert metrics["seconds"] == pytest.approx(1.5)


def test_test_gate_keeps_the_raw_pass_rate_of_a_criterion_named_score(monkeypatch, tmp_path):
    workspace = tmp_path / "pristine"
    workspace.mkdir()
    (workspace / "solver.py").write_text("def solve(x):\n    return x\n", encoding="utf-8")
    card = clamp_card(
        "score", kind="test_gate", normalize=raw_clamp(),
        case_split={"gateGroups": 1, "rolloutGroups": 0, "testGroups": 0},
    )
    card["criteria"][0]["measure"].update({"frozen": ["tests/**"], "testCmd": ["pytest", "-q"]})
    cases = {f"t::case{index}": index < 3 for index in range(5)}  # 3 of 5 pass → 0.6
    monkeypatch.setattr(test_gate_domain_module, "_run_suite", lambda *_args, **_kwargs: cases)
    domain = build_gate_domain(
        scorecard=card, workspace=workspace, capability=SandboxCapability(),
        entrypoint_path="solver.py",
    )

    valid, metrics, error = domain.evaluate("candidate", (0,))

    assert valid, error
    assert raw_measurements(metrics)["score"] == pytest.approx(0.6)
    assert normalized_criteria(metrics)["score"] == pytest.approx(0.3)
    assert metrics[SCORE_KEY] == pytest.approx(0.3)
    # The gate's own auxiliary numbers are not displaced by the collision.
    assert metrics["cases"] == 5
    assert metrics["failed"] == 2
    assert len(metrics["caseResults"]) == 5


def test_a_differently_named_criterion_still_keeps_its_flat_raw_value(monkeypatch):
    # Existing evaluators and readers index `metrics[criterion_id]`. A criterion
    # that does not collide keeps that flat value as well as the explicit maps.
    card = clamp_card("exact_match", kind="custom_script", normalize=raw_clamp(), split=SPLIT)
    monkeypatch.setattr(
        script_domain_module, "_run_evaluator",
        lambda *_args, **_kwargs: {
            "valid": True, "metrics": {"exact_match": 0.6, "cases": 4}, "error": "",
        },
    )
    domain = script_domain(scorecard=card, script="anything", capability=SandboxCapability())

    valid, metrics, error = domain.evaluate("candidate", (0,))

    assert valid, error
    assert metrics["exact_match"] == pytest.approx(0.6)  # raw, flat, as before
    assert raw_measurements(metrics)["exact_match"] == pytest.approx(0.6)
    assert normalized_criteria(metrics)["exact_match"] == pytest.approx(0.3)
    assert metrics[SCORE_KEY] == pytest.approx(0.3)
    # A diagnostic an evaluator reports itself is not a reserved name here.
    assert metrics["cases"] == 4


def test_a_criterion_named_seconds_is_not_replaced_by_the_wall_time(monkeypatch):
    card = clamp_card("seconds", normalize={"kind": "clamp", "lo": 0.0, "hi": 5.0}, split=SPLIT)
    monkeypatch.setattr(scorecard_domain_module, "shard_indices", lambda *_args: (0,))
    monkeypatch.setattr(
        scorecard_domain_module, "measure_shards",
        lambda *_args, **_kwargs: Measurement(ok=True, values={"seconds": 2.5}, seconds=1.5),
    )
    domain = scorecard_domain(
        scorecard=card, dataset=None, capability=SandboxCapability(),  # type: ignore[arg-type]
    )

    valid, metrics, error = domain.evaluate("candidate", (0,))

    assert valid, error
    # The wall time is the reserved `seconds`; the criterion's own measurement
    # is the 2.5, and both are available.
    assert metrics["seconds"] == pytest.approx(1.5)
    assert raw_measurements(metrics)["seconds"] == pytest.approx(2.5)
    assert normalized_criteria(metrics)["seconds"] == pytest.approx(0.5)
    assert metrics[SCORE_KEY] == pytest.approx(0.5)


# --- the baseline reference the engine seeds --------------------------------


def _relative_streams(monkeypatch, streams: Dict[str, Iterator[float]]) -> None:
    """Point the dataset path at one raw-value stream per criterion id.

    ``measure_shards`` receives the dataset as its second argument and the
    shard list third, so the criterion id rides in as the dataset — enough to
    give two domains in one test independent streams.
    """
    monkeypatch.setattr(scorecard_domain_module, "shard_indices", lambda *_args: (0,))
    monkeypatch.setattr(
        scorecard_domain_module, "measure_shards",
        lambda _code, dataset, _shards, **_kwargs: Measurement(
            ok=True, values={dataset: next(streams[dataset])}, seconds=1.0),
    )


def _relative_domain(criterion_id: str) -> Tuple[Any, Dict[str, float]]:
    """One domain whose measurement is the next value, baseline reference empty."""
    card = clamp_card(
        criterion_id,
        normalize={"kind": "relative_to_baseline"},
        split=SPLIT,
    )
    card["criteria"][0]["direction"] = "minimize"
    reference: Dict[str, float] = {}
    domain = scorecard_domain(
        scorecard=card, dataset=criterion_id, capability=SandboxCapability(),
        baseline=reference,
    )
    return domain, reference


def test_relative_to_baseline_seeds_from_raw_measurements_not_the_aggregate(monkeypatch):
    """The reviewer's reproduction: raw 0.6/1.2/0.3 must not flatten to 0.5/0.5/0.5.

    The engine fills the reference from the root's metrics; this uses the same
    extraction (`raw_measurements`) so the test covers the seeding path's input,
    not a reimplementation of it.
    """
    _relative_streams(monkeypatch, {"score": iter([0.6, 1.2, 0.3])})
    domain, reference = _relative_domain("score")

    valid, baseline_metrics, error = domain.evaluate("baseline", (0,))
    assert valid, error
    # The baseline is measured against itself, so it lands on the midpoint.
    assert baseline_metrics[SCORE_KEY] == pytest.approx(0.5)

    # Exactly what `aggregator.seed()` does in both engines.
    reference.update(raw_measurements(baseline_metrics))
    assert reference == {"score": pytest.approx(0.6)}

    rewards = []
    for _ in range(2):
        valid, metrics, error = domain.evaluate("candidate", (0,))
        assert valid, error
        rewards.append(metrics[SCORE_KEY])

    assert rewards == [pytest.approx(0.3333333, abs=1e-6), pytest.approx(0.6666667, abs=1e-6)]


def test_the_same_measurements_score_the_same_under_any_criterion_name(monkeypatch):
    # The identical card with a non-colliding id is the control: if these two
    # diverge, the collision is still changing the arithmetic.
    _relative_streams(monkeypatch, {
        "runtime": iter([0.6, 1.2, 0.3]),
        "score": iter([0.6, 1.2, 0.3]),
    })
    named, named_reference = _relative_domain("runtime")
    colliding, colliding_reference = _relative_domain("score")

    for domain, reference in ((named, named_reference), (colliding, colliding_reference)):
        valid, baseline_metrics, error = domain.evaluate("baseline", (0,))
        assert valid, error
        reference.update(raw_measurements(baseline_metrics))

    named_rewards = [named.evaluate("candidate", (0,))[1][SCORE_KEY] for _ in range(2)]
    colliding_rewards = [colliding.evaluate("candidate", (0,))[1][SCORE_KEY] for _ in range(2)]
    assert colliding_rewards == pytest.approx(named_rewards)


# --- the reporter's wire payload --------------------------------------------


def _openevolve_reporter():
    from test_openevolve_engine import _make_program, _make_reporter

    program = _make_program(iteration=1)
    reporter, collector = _make_reporter()
    return program, reporter, collector


def test_the_openevolve_reporter_publishes_a_criterion_named_score():
    from sciencediscovery_evolve.scorecard import score_candidate

    card = clamp_card("score", normalize=raw_clamp())
    metrics = build_outcome(raw={"score": 0.6}, scored=score_candidate(card, {"score": 0.6}, {}))
    program, reporter, collector = _openevolve_reporter()
    program.metrics = metrics
    reporter.domain.reward.return_value = 0.3

    reporter.on_event("node", {
        "program": program, "metrics": metrics, "valid": True, "cell_changed": False,
    })

    evaluated = next(event for event in collector.events if event["type"] == "evaluated")
    # Documented contract: per-criterion normalised scores, keyed by id. The
    # criterion used to disappear here because its id was `score`.
    assert evaluated["criteria"] == {"score": pytest.approx(0.3)}
    # …and the evaluator's measurement rides along, so the audit record still
    # shows the 0.6 behind the normalised 0.3.
    assert evaluated["rawCriteria"] == {"score": pytest.approx(0.6)}
    assert evaluated["gateScore"] == pytest.approx(0.3)
    assert evaluated["reward"] == pytest.approx(0.3)


def test_the_puct_reporter_publishes_a_criterion_named_score():
    from sciencediscovery_evolve.puct_engine import _Reporter
    from sciencediscovery_evolve.scorecard import score_candidate
    from sciencediscovery_evolve.vendor.puct.program import Program
    from sciencediscovery_evolve.vendor.puct.tree import PuctTree

    card = clamp_card("score", normalize=raw_clamp())
    metrics = build_outcome(raw={"score": 0.6}, scored=score_candidate(card, {"score": 0.6}, {}))
    tree = PuctTree()
    root = tree.seed(Program("p0", 0, None, "seed code", "baseline", {"score": 0.5}, True, ""), 0.5)
    node = tree.add_node(
        Program("p1", 1, root.index, "candidate code", "a change", metrics, True, ""),
        0.3, root.index,
    )
    spec = MagicMock()
    spec.search_id = "run-1"
    spec.expansions = 1
    events: List[Dict[str, Any]] = []
    domain = MagicMock()
    domain.reward.return_value = 0.3
    store = MagicMock()
    store.put.return_value = "cas-hash"
    reporter = _Reporter(spec, tree, domain, store, MagicMock(), events.append)

    reporter.on_event("node", {
        "node": node, "metrics": metrics, "ops": {"code": "candidate code", "iteration": 1},
    })

    evaluated = next(event for event in events if event["type"] == "evaluated")
    assert evaluated["criteria"] == {"score": pytest.approx(0.3)}
    assert evaluated["rawCriteria"] == {"score": pytest.approx(0.6)}
    assert evaluated["reward"] == pytest.approx(0.3)


def test_the_probe_recovers_the_raw_reference_for_a_criterion_named_score():
    # `_measure` is what fills the reference on the dataset_metric probe path.
    # It used to skip `score` by name, so the raw half it says it returns was
    # empty for exactly the criterion that collided.
    from sciencediscovery_evolve.probe import _measure
    from sciencediscovery_evolve.scorecard import score_candidate

    card = clamp_card("score", normalize=raw_clamp())
    metrics = build_outcome(raw={"score": 0.6}, scored=score_candidate(card, {"score": 0.6}, {}))

    score, raw, why = _measure(lambda _code, _shards: (True, metrics, ""), "candidate", (0,))

    assert score == pytest.approx(0.3)
    assert raw == {"score": pytest.approx(0.6)}
    assert why == ""


def test_legacy_metrics_without_the_explicit_maps_keep_working():
    # A stored run replayed into today's reporter has only the old flat shape.
    # It must not publish its aggregate as a criterion.
    legacy = {"accuracy": 0.75, "score": 0.75, "seconds": 2.0}

    assert raw_measurements(legacy) == {"accuracy": 0.75}
    assert normalized_criteria(legacy) == {"accuracy": 0.75}


def test_the_custom_script_probe_fills_the_baseline_reference(monkeypatch):
    """The other half of the reference defect, in the mode the report came from.

    The custom_script probe built its domain with no baseline mapping at all, so
    even after the domains stopped overwriting `score` the reference stayed
    empty and `relative_to_baseline` still divided each candidate by itself. It
    now hands the domain a reference and fills it from the starting point's raw
    measurements, the same way the dataset_metric path already did.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve import script_domain as script_module
    from sciencediscovery_evolve.engine import RunSpec
    from sciencediscovery_evolve.scorecard import score_candidate

    card = clamp_card(
        "score", kind="custom_script", normalize={"kind": "relative_to_baseline"},
        split={"gateShards": 1, "rolloutShards": 1, "seed": 0, "shardRows": 0, "testShards": 0},
    )
    card["criteria"][0]["direction"] = "minimize"
    baseline_code = "def solve(x):\n    return x + 1\n"
    captured: Dict[str, Any] = {}

    class _Domain:
        def __init__(self, reference: Dict[str, float]) -> None:
            self.reference = reference

        def evaluate(self, code: str, _shards: Any):
            # The starting point measures 0.6; everything else is worse. The
            # domain normalises against the reference it was handed, as the real
            # one does.
            raw = {"score": 0.6 if code == baseline_code else 1.2}
            scored = score_candidate(card, raw, self.reference or raw)
            return True, build_outcome(raw=raw, scored=scored), ""

    def fake_script_domain(*, baseline: Dict[str, float], **_kwargs: Any) -> _Domain:
        captured["baseline"] = baseline
        return _Domain(baseline)

    monkeypatch.setattr(script_module, "script_domain", fake_script_domain)
    spec = RunSpec(
        search_id="probe-custom", algorithm="puct", expansions=1, scorecard_hash="sha256:card",
        scorecard=card, statement="sort it", baseline_code=baseline_code, script="evaluator",
        sandbox=SandboxCapability(),
    )

    result = probe_module.run_probe(spec)

    # The probe is what fills the reference: raw 0.6, not the aggregate 0.5.
    assert captured["baseline"] == {"score": pytest.approx(0.6)}
    assert result["baseline"] == pytest.approx(0.5)
    # The damaged copy is therefore judged against the starting point, not
    # against itself — otherwise both would read 0.5 and the probe would call a
    # working evaluator flat.
    assert result["worsened"] == pytest.approx(0.3333333, abs=1e-6)
    assert result["flat"] is False


# --- the seeding path through a real engine ---------------------------------


def _staged_engine_fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Any):
    """Real engines, fake model replies and a fake measured dataset.

    ``test_puct_engine``'s `Harness` supplies the replies and the spec; the
    staged manifest it normally gets from its own autouse fixture is built here
    because that fixture does not run for this module.
    """
    from test_puct_engine import BASELINE, Harness, spec
    from sciencediscovery_evolve import puct_engine
    from sciencediscovery_evolve.measurement import CriterionPlan, Dataset, Shard

    shards = tuple(
        Shard(index=index, role=role, train=tmp_path / "train.csv",
              test=tmp_path / "test.csv", truth=(1.0,))
        for index, role in [(0, "rollout"), (1, "rollout"), (2, "rollout"), (3, "rollout"),
                            (4, "gate"), (5, "gate"), (6, "gate"), (7, "gate"),
                            (8, "test"), (9, "test")]
    )
    dataset = Dataset((CriterionPlan("score", "accuracy", shards),))
    monkeypatch.setattr(puct_engine, "load_dataset", lambda _root, _card: dataset)
    monkeypatch.setattr(puct_engine, "missing_candidate_runtime", lambda: [])
    Harness._store = str(tmp_path / "candidates")
    return BASELINE, Harness, spec


def _relative_engine_card() -> Dict[str, Any]:
    card = clamp_card("score", normalize={"kind": "relative_to_baseline"}, split={
        "gateShards": 4, "rolloutShards": 4, "seed": 0,
        "shardRows": 1, "testShards": 2, "trainRows": None,
    })
    card["criteria"][0]["direction"] = "minimize"
    return card


def _relative_measure(BASELINE: str):
    """Root 0.6, every candidate 1.2 — the reviewer's numbers.

    A domain that normalises each candidate against itself returns 0.5 for
    both, so the assertions below separate the two behaviours.
    """
    def measure(code: str, _dataset: Any, _shards: Any, **_kwargs: Any) -> Measurement:
        value = 0.6 if code == BASELINE else 1.2
        return Measurement(ok=True, values={"score": value}, seconds=0.1)

    return measure


class _SeededHarness:
    """The real PUCT engine and the real `scorecard_domain`.

    Only the model and the measured dataset are substituted; the reference map
    the engine fills is the one the domain normalises against, which is the
    wiring a unit test of `raw_measurements` would not cover.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any, card: Dict[str, Any]) -> None:
        self.BASELINE, harness_type, self.spec = _staged_engine_fixture(monkeypatch, tmp_path)
        self.harness = harness_type()
        self.card = card

        def domain_factory(**kwargs: Any):
            return scorecard_domain(
                scorecard=card,
                dataset=kwargs["dataset"],
                capability=kwargs["capability"],
                statement=kwargs.get("statement", ""),
                baseline_code=kwargs["baseline_code"],
                candidate_timeout=kwargs.get("candidate_timeout", 60.0),
                baseline=kwargs["baseline"],
                should_stop=kwargs["should_stop"],
            )

        self.harness.domain_factory = domain_factory  # type: ignore[method-assign]

    def run(self, monkeypatch: pytest.MonkeyPatch) -> List[Dict[str, Any]]:
        monkeypatch.setattr(
            scorecard_domain_module, "measure_shards", _relative_measure(self.BASELINE))
        self.harness.run(self.spec(
            scorecard=self.card, baseline_code=self.BASELINE, dataset_dir="/staged",
            algorithm="puct", expansions=1, workers=1, options={"mode": "serial"},
        ))
        return self.harness.events


def test_the_real_puct_engine_seeds_the_reference_from_raw_measurements(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any,
) -> None:
    events = _SeededHarness(monkeypatch, tmp_path, _relative_engine_card()).run(monkeypatch)

    seeded = [event for event in events if event["type"] == "seeded"]
    assert seeded and seeded[0]["baselineScore"] == pytest.approx(0.5)
    evaluated = [event for event in events if event["type"] == "evaluated"]
    assert evaluated, "the search made no scored expansion"
    for event in evaluated:
        # The candidate is measured against the root's raw 0.6, not against its
        # own aggregate. With the seeding reverted the reference instead picks
        # up the domain's auxiliary `seconds`, the criterion gets no reference,
        # and the reward is 0.0.
        assert event["reward"] == pytest.approx(0.3333333, abs=1e-6)
        assert event["criteria"] == {"score": pytest.approx(0.3333333, abs=1e-6)}
        assert event["rawCriteria"] == {"score": pytest.approx(1.2)}


def test_the_test_gated_probe_fills_the_baseline_reference(monkeypatch, tmp_path):
    """The gated probe had the same empty-reference gap as the scripted one.

    Unreachable from the current proposal schema (it forces identity for
    `test_gate`), but the wiring is the same one-line mirror, so it is closed
    here rather than left as a latent version of this defect.
    """
    from sciencediscovery_evolve import probe as probe_module
    from sciencediscovery_evolve import test_gate_domain as gate_module
    from sciencediscovery_evolve.engine import RunSpec
    from sciencediscovery_evolve.scorecard import score_candidate

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    original = "def solve(x):\n    return x + 1\n"
    (workspace / "solver.py").write_text(original, encoding="utf-8")
    card = clamp_card(
        "score", kind="test_gate", normalize={"kind": "relative_to_baseline"},
        case_split={"gateGroups": 1, "rolloutGroups": 1, "testGroups": 0},
    )
    card["criteria"][0]["direction"] = "minimize"
    card["criteria"][0]["measure"]["entrypoint"] = ["solver.py"]

    def fake_gate_domain(*, baseline: Dict[str, float], **_kwargs: Any):
        class _Domain:
            def evaluate(self, code: str, _groups: Any):
                raw = {"score": 0.6 if code == original else 1.2}
                scored = score_candidate(card, raw, baseline or raw)
                return True, build_outcome(raw=raw, scored=scored), ""

        return _Domain()

    monkeypatch.setattr(gate_module, "test_gate_domain", fake_gate_domain)
    spec = RunSpec(
        search_id="probe-gate", algorithm="puct", expansions=1, scorecard_hash="sha256:card",
        scorecard=card, statement="solve it", workspace_dir=str(workspace),
        sandbox=SandboxCapability(),
    )

    result = probe_module.run_probe(spec)

    assert result["baseline"] == pytest.approx(0.5)
    # Normalised against the root's raw 0.6, the hollowed-out copy is worse. A
    # self-normalised domain returns 0.5 for both and reports flat.
    assert result["worsened"] == pytest.approx(0.3333333, abs=1e-6)
    assert result["flat"] is False


def test_the_real_openevolve_engine_seeds_the_reference_from_raw_measurements(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any,
) -> None:
    from sciencediscovery_evolve.openevolve_engine import OpenEvolveEngine

    BASELINE, Harness, spec = _staged_engine_fixture(monkeypatch, tmp_path)
    monkeypatch.setattr(scorecard_domain_module, "measure_shards", _relative_measure(BASELINE))
    events: List[Dict[str, Any]] = []

    # Same real domain, same staged dataset; the OpenEvolve archive seeds from
    # `archive.best().metrics`, so its own seeding line is what is under test.
    OpenEvolveEngine(
        completion_factory=Harness().completion_factory,
        store_root=tmp_path / "store",
    ).run(
        spec(scorecard=_relative_engine_card(), baseline_code=BASELINE,
             dataset_dir="/staged", algorithm="openevolve", expansions=1,
             workers=1, options={"mode": "serial"}),
        events.append,
        lambda: False,
    )

    seeded = [event for event in events if event["type"] == "seeded"]
    assert seeded and seeded[0]["baselineScore"] == pytest.approx(0.5)
    evaluated = [event for event in events if event["type"] == "evaluated"]
    assert evaluated, "the search made no scored expansion"
    for event in evaluated:
        assert event["reward"] == pytest.approx(0.3333333, abs=1e-6)
        assert event["criteria"] == {"score": pytest.approx(0.3333333, abs=1e-6)}
        assert event["rawCriteria"] == {"score": pytest.approx(1.2)}
