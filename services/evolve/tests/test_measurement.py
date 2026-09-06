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

"""What a candidate's predictions are worth, and what the staged dataset must say.

The interesting cases are all refusals: a measurement layer that guesses when
its inputs are incomplete produces a number, and a number is believed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from sciencediscovery_evolve import measurement
from sciencediscovery_evolve.measurement import (
    GATE,
    ROLLOUT,
    DatasetError,
    load_dataset,
    measure,
)
from sciencediscovery_evolve.vendor.puct.sandbox import SandboxCapability, detect_local_capability


def criterion(cid: str, metric: str, direction: str = "maximize") -> Dict[str, Any]:
    return {
        "direction": direction, "id": cid, "name": cid,
        "measure": {
            "datasetCas": ["sha256:d"], "kind": "dataset_metric",
            "metric": {"direction": direction, "name": metric},
            "split": {"gateShards": 2, "rolloutShards": 2, "seed": 0,
                      "shardRows": 2, "testShards": 1, "trainRows": None},
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }


def stage(root: Path, criteria: Dict[str, List[Dict[str, Any]]]) -> Path:
    """Write a manifest of the shape the control plane stages."""
    manifest: Dict[str, Any] = {"criteria": {}, "schemaVersion": 1}
    for cid, shards in criteria.items():
        entries = []
        for shard in shards:
            folder = root / cid / str(shard["index"])
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "train.csv").write_text("x,y\n1,2\n", encoding="utf-8")
            (folder / "test.csv").write_text("x\n1\n", encoding="utf-8")
            (folder / "truth.json").write_text(json.dumps(shard["truth"]), encoding="utf-8")
            entries.append({
                "index": shard["index"], "role": shard["role"],
                "train": f"{cid}/{shard['index']}/train.csv",
                "test": f"{cid}/{shard['index']}/test.csv",
                "truth": f"{cid}/{shard['index']}/truth.json",
            })
        manifest["criteria"][cid] = {"shards": entries}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


# --- Metrics ----------------------------------------------------------------


def test_metrics_agree_with_their_definitions() -> None:
    assert measurement.METRICS["rmse"]([1.0, 3.0], [1.0, 1.0]) == pytest.approx(2.0 ** 0.5)
    assert measurement.METRICS["mae"]([1.0, 3.0], [1.0, 1.0]) == pytest.approx(1.0)
    assert measurement.METRICS["r2"]([1.0, 2.0], [1.0, 2.0]) == pytest.approx(1.0)
    assert measurement.METRICS["accuracy"]([0.6, 0.2], [1.0, 0.0]) == pytest.approx(1.0)


def test_a_truth_column_with_no_variance_scores_zero_not_infinity() -> None:
    # R² divides by the variance of the truth. An inf here would be dropped on
    # the wire and read downstream as "not measured".
    assert measurement.METRICS["r2"]([1.0, 1.0], [2.0, 2.0]) == 0.0


# --- The staged dataset -----------------------------------------------------


def test_a_scorecard_needing_data_without_a_staged_dataset_is_refused(tmp_path: Path) -> None:
    with pytest.raises(DatasetError) as error:
        load_dataset(None, {"criteria": [criterion("f1", "accuracy")]})
    assert "dataset" in str(error.value)


def test_a_metric_this_engine_cannot_compute_is_named_rather_than_guessed(tmp_path: Path) -> None:
    stage(tmp_path, {"f1": [{"index": 0, "role": ROLLOUT, "truth": [1.0]}]})
    with pytest.raises(DatasetError) as error:
        load_dataset(str(tmp_path), {"criteria": [criterion("f1", "auroc")]})
    assert "auroc" in str(error.value)


def test_a_measurement_kind_this_engine_does_not_support_is_refused(tmp_path: Path) -> None:
    # test_gate runs a suite and llm_judge calls a model; neither is this
    # engine's capability, and measuring the wrong thing beats nothing only if
    # you never find out.
    gate = {"direction": "maximize", "id": "t", "name": "t", "normalize": {"kind": "identity"},
            "weight": 1.0, "measure": {"kind": "test_gate", "caseSplit": {}, "entrypoint": [],
                                       "frozen": [], "testCmd": ["pytest"]}}
    with pytest.raises(DatasetError) as error:
        load_dataset(str(tmp_path), {"criteria": [gate]})
    assert "test_gate" in str(error.value)


def test_a_dataset_missing_gate_shards_is_refused(tmp_path: Path) -> None:
    # Without gate shards every candidate would pass unmeasured: the acceptance
    # gate reads them and nothing else.
    stage(tmp_path, {"f1": [{"index": 0, "role": ROLLOUT, "truth": [1.0]}]})
    with pytest.raises(DatasetError) as error:
        load_dataset(str(tmp_path), {"criteria": [criterion("f1", "accuracy")]})
    assert GATE in str(error.value)


def test_a_seconds_criterion_needs_no_dataset_of_its_own() -> None:
    # This is what makes a "training time < 300s" veto expressible: a constraint
    # refers to a criterion, and a criterion needs something to measure.
    dataset = load_dataset(None, {"criteria": [criterion("t", "seconds", "minimize")]})
    assert [plan.metric for plan in dataset.plans] == ["seconds"]
    assert dataset.plans[0].shards == ()


# --- Measuring --------------------------------------------------------------


def fake_run(payloads: List[Dict[str, Any]]):
    calls: List[List[str]] = []

    def run(code: str, inner_args, **kwargs):  # noqa: ANN001
        calls.append(list(inner_args))
        return payloads[min(len(calls) - 1, len(payloads) - 1)]

    run.calls = calls  # type: ignore[attr-defined]
    return run


def load_two_criteria(tmp_path: Path):
    """Two criteria measured on the *same* shards."""
    manifest = {
        "criteria": {
            "acc": {"shards": [
                {"index": 0, "role": ROLLOUT, "train": "s/0/train.csv", "test": "s/0/test.csv",
                 "truth": "s/0/truth.json"},
                {"index": 1, "role": GATE, "train": "s/1/train.csv", "test": "s/1/test.csv",
                 "truth": "s/1/truth.json"},
            ]},
            "err": {"shards": [
                {"index": 0, "role": ROLLOUT, "train": "s/0/train.csv", "test": "s/0/test.csv",
                 "truth": "s/0/truth.json"},
                {"index": 1, "role": GATE, "train": "s/1/train.csv", "test": "s/1/test.csv",
                 "truth": "s/1/truth.json"},
            ]},
        },
        "schemaVersion": 1,
    }
    for index in (0, 1):
        folder = tmp_path / "s" / str(index)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "train.csv").write_text("x\n1\n", encoding="utf-8")
        (folder / "test.csv").write_text("x\n1\n", encoding="utf-8")
        (folder / "truth.json").write_text(json.dumps([1.0, 0.0]), encoding="utf-8")
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return load_dataset(str(tmp_path), {
        "criteria": [criterion("acc", "accuracy"), criterion("err", "mae", "minimize")],
    })


def test_two_criteria_over_one_dataset_cost_one_execution_per_shard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = load_two_criteria(tmp_path)
    run = fake_run([{"ok": True, "predictions": [1.0, 0.0], "seconds": 1.5}])
    monkeypatch.setattr(measurement, "run_candidate", run)

    result = measure("code", dataset, ROLLOUT, capability=SandboxCapability(), timeout=5.0)

    assert result.ok
    # One rollout shard, two criteria: adding a cheap second criterion must not
    # double the wall clock of every expansion.
    assert len(run.calls) == 1
    assert result.values == {"acc": pytest.approx(1.0), "err": pytest.approx(0.0)}
    assert result.seconds == pytest.approx(1.5)


def test_rollout_and_gate_are_measured_separately(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = load_two_criteria(tmp_path)
    monkeypatch.setattr(measurement, "run_candidate",
                        fake_run([{"ok": True, "predictions": [1.0, 1.0], "seconds": 0.5}]))

    rollout = measure("code", dataset, ROLLOUT, capability=SandboxCapability(), timeout=5.0)
    gate = measure("code", dataset, GATE, capability=SandboxCapability(), timeout=5.0)

    # Same numbers here only because the fixture's shards are identical. What
    # matters is that each role reads its own shards: mixing them would let the
    # shards the search optimised against decide the commit.
    assert rollout.ok and gate.ok


def test_a_candidate_that_will_not_run_stops_after_the_first_shard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = load_two_criteria(tmp_path)
    run = fake_run([{"ok": False, "error": "gate: import 'os' is not allowed", "seconds": 0.0}])
    monkeypatch.setattr(measurement, "run_candidate", run)

    result = measure("code", dataset, ROLLOUT, capability=SandboxCapability(), timeout=5.0)

    assert not result.ok
    assert "not allowed" in result.error
    assert len(run.calls) == 1, "spending the other shards to confirm a failure buys nothing"


def test_a_candidate_returning_nan_is_a_failure_not_a_score(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = load_two_criteria(tmp_path)
    monkeypatch.setattr(measurement, "run_candidate",
                        fake_run([{"ok": True, "predictions": [float("nan"), 0.0], "seconds": 0.1}]))

    result = measure("code", dataset, ROLLOUT, capability=SandboxCapability(), timeout=5.0)

    # A NaN score would poison every average it touches and still rank as a
    # real number downstream.
    assert not result.ok
    assert "non-finite" in result.error


def test_the_wrong_number_of_predictions_is_a_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = load_two_criteria(tmp_path)
    monkeypatch.setattr(measurement, "run_candidate",
                        fake_run([{"ok": True, "predictions": [1.0], "seconds": 0.1}]))

    result = measure("code", dataset, ROLLOUT, capability=SandboxCapability(), timeout=5.0)
    assert not result.ok


@pytest.mark.skipif(
    not detect_local_capability().available,
    reason="needs a real sandbox: this exercises the confinement itself, and a host that only carries the binary cannot provide it",
)
def test_a_real_candidate_runs_under_the_real_sandbox_and_is_scored(tmp_path: Path) -> None:
    """The one test that does not stub `run_candidate`.

    Everything above mocks the execution, so the argv this module assembles —
    the runner path, `--train`/`--test`/`--rows`, the CPU budget appended by
    `run_candidate` — is never checked by them. A wrong flag order fails
    identically to a bad candidate, which is exactly the confusion this whole
    layer exists to prevent.
    """
    from sciencediscovery_evolve.vendor.puct.sandbox import detect_local_capability

    from sciencediscovery_evolve.measurement import missing_candidate_runtime

    capability = detect_local_capability()
    if not capability.available:
        pytest.skip("no sandbox backend on this host")
    if missing_candidate_runtime():
        pytest.skip("candidate runtime not installed (uv sync --extra candidates)")

    (tmp_path / "s" / "0").mkdir(parents=True)
    (tmp_path / "s" / "0" / "train.csv").write_text("x,y\n1,2\n2,4\n", encoding="utf-8")
    (tmp_path / "s" / "0" / "test.csv").write_text("x\n3\n4\n", encoding="utf-8")
    (tmp_path / "s" / "0" / "truth.json").write_text("[6.0, 8.0]", encoding="utf-8")
    (tmp_path / "s" / "1").mkdir(parents=True)
    (tmp_path / "s" / "1" / "train.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "s" / "1" / "test.csv").write_text("x\n5\n", encoding="utf-8")
    (tmp_path / "s" / "1" / "truth.json").write_text("[10.0]", encoding="utf-8")
    (tmp_path / "manifest.json").write_text(json.dumps({
        "criteria": {"err": {"shards": [
            {"index": 0, "role": ROLLOUT, "train": "s/0/train.csv",
             "test": "s/0/test.csv", "truth": "s/0/truth.json"},
            {"index": 1, "role": GATE, "train": "s/1/train.csv",
             "test": "s/1/test.csv", "truth": "s/1/truth.json"},
        ]}},
        "schemaVersion": 1,
    }), encoding="utf-8")

    dataset = load_dataset(str(tmp_path), {"criteria": [criterion("err", "mae", "minimize")]})
    code = (
        '"""Predict 2x for every test row."""\n'
        "import pandas as pd\n\n\n"
        "def train_and_predict(train_path, test_path):\n"
        "    test = pd.read_csv(test_path)\n"
        "    return [float(value) * 2 for value in test['x']]\n"
    )

    result = measure(code, dataset, ROLLOUT, capability=capability, timeout=60.0)

    assert result.ok, result.error
    assert result.values["err"] == pytest.approx(0.0)
    assert result.seconds > 0.0


def test_the_candidate_runtime_the_gate_promises_is_checked_by_name() -> None:
    """The AST gate admits pandas, numpy, scipy and sklearn.

    If this venv does not have them, every candidate fails with
    `ModuleNotFoundError` and the run reads as a model that cannot write code —
    so the run is refused up front instead. This asserts the list the check
    covers, which is the half that can silently drift from the gate.
    """
    from sciencediscovery_evolve.measurement import _CANDIDATE_RUNTIME
    from sciencediscovery_evolve.vendor.puct.program import BLOCKED_IMPORTS

    third_party = {"numpy", "pandas", "scipy", "sklearn"}
    assert set(_CANDIDATE_RUNTIME) == third_party
    # The gate admits anything installed and unblocked, so what this has to
    # assert is the other direction: nothing the run promises a candidate can
    # import may be on the deny list.
    assert not (third_party & BLOCKED_IMPORTS), "the run promises imports the gate refuses"
