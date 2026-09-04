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

"""The function-minimization evaluator, lifted from upstream.

Vendored from ``examples/openevolve/_openevolve_support.py`` (upstream commit
``411fb59``). This is the *fixed* OpenEvolve task: the objective
``f(x,y) = sin(x)cos(y) + sin(xy) + (x²+y²)/20`` and the combined-score formula
(value 0.5 + distance 0.3 + reliability 0.2, times a basin multiplier). The
agentdescent port declares ``benchmark_faithful`` against this formula; changing
it here drops that label.

.. note:: The scorecard-driven path (step D option 2 in the integration doc)
   would replace this module with a ``scorecard_domain`` adapter. Until then
   this module is what an ``openevolve`` run actually optimises.

The sandbox plumbing is **not** vendored here: ``vendor/era/sandbox.py``'s
``SandboxCapability`` and ``sandbox_command`` are reused, because the
container corrections (``--disable-userns``, procfs fallback) are knowledge
this repository has already paid for and asking twice is how two answers
disagree.
"""

from __future__ import annotations

import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..puct.sandbox import (
    SandboxCapability,
    SandboxUnavailable,
    cpu_seconds_for,
    detect_local_capability,
    sandbox_command,
)
from .program import (
    GLOBAL_MIN_X,
    GLOBAL_MIN_Y,
    GLOBAL_MIN_VALUE,
    Program,
    validate_source,
)


UPSTREAM_COMMIT = "411fb59c886c18704caaffb611e17cf9e7d824d2"

#: Where the search is bounded. Matches upstream's ``examples/function_minimization``.
BOUNDS = (-5.0, 5.0)

#: The sandbox-side runner. Lives next to this module; resolved at import time
#: so the path is stable across calls. The runner is mounted read-only into
#: the sandbox via ``sandbox_command``'s ``--ro-bind / /`` (ERA's profile), so
#: this host path is reachable inside the sandbox as-is.
RUNNER = Path(__file__).with_name("runner.py")


def objective_value(x: float, y: float) -> float:
    """The objective the candidate's ``search_algorithm`` is trying to minimise.

    Lifted verbatim from upstream. The known global minimum is
    ``(GLOBAL_MIN_X, GLOBAL_MIN_Y) = (-1.704, 0.678)`` with value
    ``GLOBAL_MIN_VALUE = -1.519``; the AST gate in ``program.py`` refuses any
    candidate that hard-codes these.
    """
    return math.sin(x) * math.cos(y) + math.sin(x * y) + (x * x + y * y) / 20.0


def _zero_metrics(error: str) -> Dict[str, Any]:
    return {
        "value_score": 0.0,
        "distance_score": 0.0,
        "reliability_score": 0.0,
        "combined_score": 0.0,
        "avg_value": None,
        "avg_distance": None,
        "avg_runtime_seconds": None,
        "avg_objective_calls": None,
        "successful_trials": 0,
        "total_trials": 0,
        "error": error,
    }


def combined_metrics(trials: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute the pinned upstream function-minimization fitness.

    Formula and weights match OpenEvolve commit ``411fb59``
    ``examples/function_minimization/evaluator.py`` lines 190-215: value 0.5,
    distance 0.3, reliability 0.2, followed by the basin-distance multiplier.
    That pinned evaluator has no speed term.
    """
    successes = [trial for trial in trials if trial.get("success")]
    total = len(trials)
    if not successes or total == 0:
        return _zero_metrics("all trials failed")
    values = [objective_value(float(trial["x"]), float(trial["y"])) for trial in successes]
    distances = [
        math.hypot(float(trial["x"]) - GLOBAL_MIN_X, float(trial["y"]) - GLOBAL_MIN_Y)
        for trial in successes
    ]
    avg_value = sum(values) / len(values)
    avg_distance = sum(distances) / len(distances)
    value_stddev = math.sqrt(sum((value - avg_value) ** 2 for value in values) / len(values))
    distance_stddev = math.sqrt(
        sum((distance - avg_distance) ** 2 for distance in distances) / len(distances)
    )
    value_score = 1.0 / (1.0 + abs(avg_value - GLOBAL_MIN_VALUE))
    distance_score = 1.0 / (1.0 + avg_distance)
    reliability_score = len(successes) / total
    if avg_distance < 0.5:
        multiplier = 1.5
    elif avg_distance < 1.5:
        multiplier = 1.2
    elif avg_distance < 3.0:
        multiplier = 1.0
    else:
        multiplier = 0.7
    base_score = 0.5 * value_score + 0.3 * distance_score + 0.2 * reliability_score
    return {
        "value_score": value_score,
        "distance_score": distance_score,
        "reliability_score": reliability_score,
        "solution_quality_multiplier": multiplier,
        "combined_score": base_score * multiplier,
        "avg_value": avg_value,
        "value_stddev": value_stddev,
        "best_value": min(values),
        "worst_value": max(values),
        "avg_distance": avg_distance,
        "distance_stddev": distance_stddev,
        "best_distance": min(distances),
        "worst_distance": max(distances),
        "avg_runtime_seconds": sum(float(trial["seconds"]) for trial in successes)
        / len(successes),
        "avg_objective_calls": sum(int(trial["objective_calls"]) for trial in successes)
        / len(successes),
        "successful_trials": len(successes),
        "total_trials": total,
        "error": "",
    }


def framework_score(metrics: Dict[str, Any]) -> float:
    """Map OpenEvolve's ``[0, 1.5]`` combined score into AgentDescent's ``[0, 1]``."""
    return max(0.0, min(1.0, float(metrics.get("combined_score") or 0.0) / 1.5))


def mutation_prompt(
    parent: Program,
    best: Program,
    inspiration: Program,
    *,
    iteration: int,
    budget: int,
    trials: int = 10,
) -> str:
    """The prompt the model rewrites the parent with.

    Lifted verbatim from ``examples/openevolve/_openevolve_support.mutation_prompt``.
    The contract (``search_algorithm(objective, budget, rng, bounds) -> (x, y)``),
    the safety constraints and the ``<PROGRAM>`` / ``<CHANGE_SUMMARY>`` return
    format are all part of the upstream benchmark — editing this prompt drops
    the ``benchmark_faithful`` label.
    """
    return f'''You are the mutation model in an OpenEvolve-style program search.

Improve a Python search algorithm for this objective on x,y in [-5,5]:
f(x,y) = sin(x)*cos(y) + sin(x*y) + (x^2+y^2)/20.

The evaluator runs {trials} deterministic seeds with a strict budget of {budget} calls to
the supplied objective. It rewards low average objective value, proximity to the
same global basin across seeds, and reliability. Never hard-code a known optimum.

Contract and safety constraints:
- Return a complete Python module defining exactly this callable interface:
  search_algorithm(objective, budget, rng, bounds) -> (x, y)
- Use objective(x, y) for scoring and never exceed budget calls.
- Use only the standard library modules math, random, statistics, heapq, bisect,
  or itertools. Do not access files, processes, the environment, or the network.
- Keep all returned coordinates inside bounds.
- Generalize across RNG seeds. Spend the fixed budget more intelligently rather
  than merely increasing loops.

Iteration: {iteration}

PARENT METRICS:
{json.dumps(parent.metrics, sort_keys=True)}

PARENT PROGRAM:
<PARENT_PROGRAM>
{parent.code}
</PARENT_PROGRAM>

GLOBAL BEST METRICS:
{json.dumps(best.metrics, sort_keys=True)}

DIVERSE INSPIRATION METRICS:
{json.dumps(inspiration.metrics, sort_keys=True)}

DIVERSE INSPIRATION PROGRAM:
<INSPIRATION_PROGRAM>
{inspiration.code}
</INSPIRATION_PROGRAM>

Propose one substantive algorithmic mutation. Return exactly:
<PROGRAM>
complete Python source
</PROGRAM>
<CHANGE_SUMMARY>one concise sentence</CHANGE_SUMMARY>'''


def evaluate_source(
    source: str,
    *,
    trials: int,
    budget: int,
    seed: int,
    timeout: float,
    max_length: int = 20_000,
    capability: Optional[SandboxCapability] = None,
) -> Tuple[bool, Dict[str, Any], str, List[Dict[str, Any]]]:
    """Run a candidate in the sandbox and return its metrics.

    Lifted from ``examples/openevolve/_openevolve_support.evaluate_source`` with
    one change: the sandbox backend comes from ``capability`` (the control
    plane's probe result) rather than ``detect_local_capability()``. A local
    fallback remains for tests, but the run path must use the probe's authority.

    The ``capability`` argument is handed down from ``RunSpec.sandbox`` by the
    engine — both in ``make_run`` (rollout evaluation) and in
    ``OpenEvolveAggregator._evaluate`` (gate evaluation) — so the search runs
    under the control plane's probed backend rather than a local fallback.
    The ``None`` default falls back to ``detect_local_capability()`` so the
    function remains callable standalone for tests.
    """
    valid, error = validate_source(source, max_length)
    if not valid:
        return False, _zero_metrics(error), error, []

    cap = capability or detect_local_capability()
    if not cap.available:
        return False, _zero_metrics("no sandbox backend available"), "no sandbox backend", []

    with tempfile.TemporaryDirectory(prefix="openevolve-candidate-") as directory:
        candidate = Path(directory) / "candidate.py"
        candidate.write_text(source, encoding="utf-8")

        # The runner is the first argv element: ERA's ``sandbox_command``
        # appends ``sys.executable -I *inner``, so ``inner[0]`` is the script
        # Python executes. The runner then takes ``candidate`` as its position
        # argument, followed by the flag pairs.
        inner = [
            str(RUNNER),
            str(candidate),
            "--trials", str(trials),
            "--budget", str(budget),
            "--seed", str(seed),
            "--bound", str(BOUNDS[1]),
            "--cpu-seconds", str(cpu_seconds_for(timeout)),
            # nproc limit mirrors ERA's _current_user_task_count() + 64 floor.
            # OpenEvolve candidates are stdlib-only and single-threaded, but the
            # limit is still applied to defend against a candidate that spawns.
            "--nproc-limit", "512",
        ]
        command, env = sandbox_command(
            candidate.parent, inner, capability=cap, timeout=timeout,
        )
        # Retry on transient namespace-creation failures. Inside a container
        # bwrap can hit "Creating new namespace failed: Resource temporarily
        # unavailable" under load — a real condition, not a candidate fault, so
        # a single attempt would judge a good candidate as broken. Upstream
        # OpenEvolve retries 3 times with linear backoff; same here.
        stdout = stderr = ""
        process: Optional[subprocess.Popen] = None
        for sandbox_attempt in range(3):
            try:
                process = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    start_new_session=True,
                    env=env,
                )
            except FileNotFoundError as exc:
                return False, _zero_metrics(str(exc)), str(exc), []

            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
                error = f"candidate timed out after {timeout:.1f}s"
                return False, _zero_metrics(error), error, []

            transient_namespace_error = (
                process.returncode != 0
                and "Creating new namespace failed: Resource temporarily unavailable"
                in (stderr or "")
            )
            if transient_namespace_error and sandbox_attempt < 2:
                time.sleep(0.25 * (sandbox_attempt + 1))
                continue
            break

    if process is not None and process.returncode != 0:
        error = f"sandbox exited {process.returncode}: {(stderr or stdout).strip()[:500]}"
        return False, _zero_metrics(error), error, []

    try:
        payload = json.loads(stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError) as exc:
        error = f"invalid sandbox JSON: {exc}; output={stdout.strip()[:300]!r}"
        return False, _zero_metrics(error), error, []

    if not payload.get("ok"):
        error = str(payload.get("error") or "sandbox runner failed")
        return False, _zero_metrics(error), error, payload.get("trials", [])

    trial_rows = payload.get("trials", [])
    metrics = combined_metrics(trial_rows)
    valid = metrics["successful_trials"] > 0
    return valid, metrics, metrics.get("error", ""), trial_rows
