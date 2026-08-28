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

"""Turning one candidate into the numbers the scorecard grades.

The candidate never computes its own score. It is handed a train file and a test
file and returns predictions; the metric is computed **here**, outside the
sandbox, against truth the candidate never sees. That split is the whole reason
a score means anything: a candidate that could read the answer key would
optimise for reading it.

Three things this module is careful about.

**Rollout and gate shards are measured separately and never mixed.** The search
ranks on rollout; the acceptance gate reads gate. A caller that averaged them
would let the shards the search optimised against decide the commit, which is
the failure `MergeContext` names in its own docstring — and which this
repository has shipped once already.

**Test shards are not measured here at all.** They are the number reported once,
at the end, for the winner; anything that reads them during the search has
spent them.

**One execution serves every criterion that shares a shard.** A scorecard of
"RMSE + training time" over the same dataset costs one run per shard, not two: the
executions are keyed by ``(train, test)`` and each criterion computes its own
metric from the same predictions. Without that, adding a cheap second criterion
would double the wall clock of every expansion.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .candidates import run_candidate
from .logging_config import get_logger
from .vendor.puct.sandbox import SandboxCapability

log = get_logger("measurement")

#: Shards the search may see, shards that decide a commit, and shards that take
#: no part until the run is over.
ROLLOUT = "rollout"
GATE = "gate"
TEST = "test"

#: Measured from the runner payload rather than from predictions, so a criterion
#: using it needs no dataset of its own. This is what makes a "training time < 300s"
#: veto expressible: a constraint refers to a criterion, and a criterion needs
#: something to measure.
SECONDS_METRIC = "seconds"


class DatasetError(RuntimeError):
    """The staged dataset does not describe what the scorecard asks for.

    A run-level fault, never a candidate failure: it means nothing measurable
    was set up, so every candidate would fail identically and the search would
    report "nothing worked" for a reason that has nothing to do with candidates.
    """


# --- Metrics ----------------------------------------------------------------


def _rmse(predictions: Sequence[float], truth: Sequence[float]) -> float:
    return math.sqrt(sum((p - t) ** 2 for p, t in zip(predictions, truth)) / len(truth))


def _mae(predictions: Sequence[float], truth: Sequence[float]) -> float:
    return sum(abs(p - t) for p, t in zip(predictions, truth)) / len(truth)


def _r2(predictions: Sequence[float], truth: Sequence[float]) -> float:
    mean = sum(truth) / len(truth)
    total = sum((t - mean) ** 2 for t in truth)
    residual = sum((p - t) ** 2 for p, t in zip(predictions, truth))
    # A constant truth column has no variance to explain. Reporting 0.0 rather
    # than dividing by zero: "explained none of it" is the honest reading, and
    # an inf here would be dropped on the wire and read as "not measured".
    return 0.0 if total <= 0 else 1.0 - residual / total


def _accuracy(predictions: Sequence[float], truth: Sequence[float]) -> float:
    hits = sum(1 for p, t in zip(predictions, truth) if round(p) == round(t))
    return hits / len(truth)


#: Raw metrics, by the name a scorecard criterion uses. The criterion carries
#: its own ``direction``; nothing here assumes bigger is better.
METRICS: Dict[str, Callable[[Sequence[float], Sequence[float]], float]] = {
    "accuracy": _accuracy,
    "mae": _mae,
    "r2": _r2,
    "rmse": _rmse,
}


def supported_metric(name: str) -> bool:
    return name in METRICS or name == SECONDS_METRIC


# --- The staged dataset -----------------------------------------------------


@dataclass(frozen=True)
class Shard:
    index: int
    role: str
    train: Path
    test: Path
    truth: Tuple[float, ...]


@dataclass(frozen=True)
class CriterionPlan:
    """What one criterion needs measured. ``shards`` is empty for a derived
    metric such as ``seconds``, which is read off the run itself."""

    criterion_id: str
    metric: str
    shards: Tuple[Shard, ...] = ()

    def of_role(self, role: str) -> Tuple[Shard, ...]:
        return tuple(shard for shard in self.shards if shard.role == role)


@dataclass(frozen=True)
class Dataset:
    """Every criterion's measurement plan, as staged by the control plane."""

    plans: Tuple[CriterionPlan, ...] = ()

    def roles_present(self, role: str) -> bool:
        return any(plan.of_role(role) for plan in self.plans)


def load_dataset(root: Optional[str], scorecard: Mapping[str, Any]) -> Dataset:
    """Read the staged manifest and pair it with the scorecard's criteria.

    The split policy — the seed, the shard size, which index is a gate shard —
    is the control plane's; this reads the result. Deciding it twice, in two
    languages, is how two answers start to disagree, which is the same reason
    the sandbox backend is handed down rather than probed here.
    """
    criteria = list(scorecard.get("criteria") or [])
    needs_data = [c for c in criteria if _metric_name(c) != SECONDS_METRIC]

    if not root:
        if needs_data:
            raise DatasetError(
                "this search has no staged dataset, but the scorecard has "
                f"{len(needs_data)} criteria that must be measured on data: "
                f"{', '.join(_metric_name(c) for c in needs_data)}"
            )
        return Dataset(tuple(CriterionPlan(c["id"], SECONDS_METRIC) for c in criteria))

    base = Path(root)
    manifest_path = base / "manifest.json"
    if not manifest_path.exists():
        raise DatasetError(f"the staging directory {root} has no manifest.json")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise DatasetError(f"manifest.json does not parse: {error}") from error

    staged = manifest.get("criteria") or {}
    plans: List[CriterionPlan] = []
    for criterion in criteria:
        metric = _metric_name(criterion)
        if not supported_metric(metric):
            raise DatasetError(
                f"criterion \"{criterion.get('name', criterion['id'])}\" uses the metric "
                f"{metric!r}, which this engine cannot compute yet; supported are "
                f"{sorted(METRICS)} and {SECONDS_METRIC!r}"
            )
        if metric == SECONDS_METRIC:
            plans.append(CriterionPlan(criterion["id"], metric))
            continue
        entry = staged.get(criterion["id"])
        if not entry:
            raise DatasetError(f"the staged dataset has no shards for criterion {criterion['id']!r}")
        plans.append(CriterionPlan(criterion["id"], metric, _shards(base, entry)))

    for role in (ROLLOUT, GATE):
        if needs_data and not any(plan.of_role(role) for plan in plans):
            # Missing gate shards would let every candidate through unmeasured;
            # missing rollout shards leave the search with nothing to rank on.
            raise DatasetError(f"the staged dataset has no {role} shards, so there is no acceptance gate and no ranking")
    return Dataset(tuple(plans))


def _metric_name(criterion: Mapping[str, Any]) -> str:
    measure = criterion.get("measure") or {}
    if measure.get("kind") != "dataset_metric":
        # Every other measurement kind is a different engine capability
        # (test_gate runs a suite, llm_judge calls a model). Refusing by name
        # beats measuring the wrong thing.
        raise DatasetError(
            f"criterion \"{criterion.get('name', criterion.get('id'))}\" is measured by "
            f"{measure.get('kind')!r}, which this engine does not support yet"
        )
    return str((measure.get("metric") or {}).get("name") or "")


def _shards(base: Path, entry: Mapping[str, Any]) -> Tuple[Shard, ...]:
    shards: List[Shard] = []
    for raw in entry.get("shards") or []:
        role = str(raw.get("role"))
        if role not in (ROLLOUT, GATE, TEST):
            raise DatasetError(f"unknown shard role {role!r}")
        truth_path = base / str(raw["truth"])
        try:
            truth = tuple(float(value) for value in json.loads(truth_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as error:
            raise DatasetError(f"the truth for shard {raw.get('index')} cannot be read: {error}") from error
        if not truth:
            raise DatasetError(f"the truth for shard {raw.get('index')} is empty")
        shards.append(Shard(
            index=int(raw.get("index", len(shards))),
            role=role,
            train=base / str(raw["train"]),
            test=base / str(raw["test"]),
            truth=truth,
        ))
    return tuple(shards)


# --- Measuring one candidate ------------------------------------------------


@dataclass
class Measurement:
    """Raw per-criterion numbers for one candidate at one role.

    ``ok`` false means the candidate never produced a usable number — it failed
    the gate, crashed, timed out or returned the wrong shape. That is a
    different fact from "it scored badly", and the two must not arrive as one.
    """

    ok: bool
    values: Dict[str, float] = field(default_factory=dict)
    seconds: float = 0.0
    error: str = ""


def measure(
    code: str,
    dataset: Dataset,
    role: str,
    *,
    capability: SandboxCapability,
    timeout: float,
    runner_argv: Optional[Sequence[str]] = None,
) -> Measurement:
    """Run the candidate over one role's shards and reduce to per-criterion means."""
    return measure_shards(
        code, dataset, shard_indices(dataset, role),
        capability=capability, timeout=timeout, runner_argv=runner_argv, what=role,
    )


def shard_indices(dataset: Dataset, role: str) -> Tuple[int, ...]:
    """Every shard index this role covers, in order."""
    seen = {shard.index for plan in dataset.plans for shard in plan.of_role(role)}
    return tuple(sorted(seen))


def measure_shards(
    code: str,
    dataset: Dataset,
    indices: Sequence[int],
    *,
    capability: SandboxCapability,
    timeout: float,
    runner_argv: Optional[Sequence[str]] = None,
    what: str = "",
) -> Measurement:
    """Run the candidate over exactly these shards and reduce to per-criterion means.

    Addressed by index rather than by role because one shard is one rollout to
    the engine: the roles are the scorecard's vocabulary for *which* shards, and
    the engine only ever asks for a set.

    Fails fast on the first shard that will not run: a candidate that crashes on
    shard 2 of 8 is a failed candidate, and spending the other six executions to
    confirm it buys nothing.
    """
    groups = _executions_for(dataset, indices)
    if not groups:
        return Measurement(ok=False, error=f"there are no {what or 'such'} shards to measure")

    per_criterion: Dict[str, List[float]] = {}
    durations: List[float] = []
    argv = list(runner_argv or default_runner_argv())

    for (train, test), wants in groups.items():
        rows = len(wants[0][2])
        payload = run_candidate(
            code,
            [*argv, "--train", str(train), "--test", str(test), "--rows", str(rows)],
            capability=capability,
            timeout=timeout,
        )
        if not payload.get("ok"):
            return Measurement(
                ok=False,
                seconds=float(payload.get("seconds") or 0.0),
                error=str(payload.get("error") or "the candidate failed to run"),
            )
        predictions = payload.get("predictions") or []
        if any(not math.isfinite(value) for value in predictions):
            # Checked once, here, rather than per metric: `accuracy` raises on a
            # NaN and `rmse` propagates it silently, so leaving it to the metrics
            # makes the same candidate fail differently depending on the
            # scorecard. A NaN score poisons every average it touches and still
            # ranks as a real number downstream.
            return Measurement(ok=False, error="the candidate produced non-finite predictions (NaN or inf)")
        durations.append(float(payload.get("seconds") or 0.0))
        for criterion_id, metric, truth in wants:
            if len(predictions) != len(truth):
                return Measurement(
                    ok=False,
                    error=f"the candidate produced {len(predictions)} predictions; the shard "
                          f"needs {len(truth)}",
                )
            try:
                value = METRICS[metric](predictions, truth)
            except (ArithmeticError, TypeError, ValueError) as error:
                return Measurement(ok=False, error=f"metric {metric} cannot be computed: {error}")
            if not math.isfinite(value):
                # A candidate returning NaN is a failed candidate, not a
                # candidate scoring NaN: the second would poison every average
                # it touches and rank as a real number downstream.
                return Measurement(ok=False, error=f"metric {metric} came out non-finite")
            per_criterion.setdefault(criterion_id, []).append(value)

    mean_seconds = sum(durations) / len(durations) if durations else 0.0
    values = {key: sum(items) / len(items) for key, items in per_criterion.items()}
    for plan in dataset.plans:
        if plan.metric == SECONDS_METRIC:
            values[plan.criterion_id] = mean_seconds
    return Measurement(ok=True, values=values, seconds=mean_seconds)


def _executions_for(
    dataset: Dataset, indices: Sequence[int],
) -> Dict[Tuple[Path, Path], List[Tuple[str, str, Tuple[float, ...]]]]:
    """Group these shards by the files they run on.

    Two criteria over the same dataset share one execution and read their own
    metric off the same predictions.
    """
    wanted = set(indices)
    groups: Dict[Tuple[Path, Path], List[Tuple[str, str, Tuple[float, ...]]]] = {}
    for plan in dataset.plans:
        for shard in plan.shards:
            if shard.index not in wanted:
                continue
            groups.setdefault((shard.train, shard.test), []).append(
                (plan.criterion_id, plan.metric, shard.truth)
            )
    return groups


#: Third-party modules the AST gate admits. A candidate runs with this process's
#: interpreter, so this venv is the environment the gate makes promises about.
_CANDIDATE_RUNTIME = ("numpy", "pandas", "scipy", "sklearn")


def missing_candidate_runtime() -> List[str]:
    """Allowlisted modules a candidate could import but this venv does not have.

    Checked once at run start rather than discovered per candidate: without it
    every expansion fails with `ModuleNotFoundError` and the run reads as a
    model that cannot write code.
    """
    import importlib.util

    return [name for name in _CANDIDATE_RUNTIME if importlib.util.find_spec(name) is None]


def default_runner_argv() -> List[str]:
    """The vendored runner, invoked as a file so the sandbox needs no package
    path: ``-I`` in the sandbox command already strips this process's."""
    from .vendor.puct import runner

    return [str(Path(runner.__file__).resolve())]

