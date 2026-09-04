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

"""Fidelity of the vendored OpenEvolve port, pinned against upstream's formulas.

Mirrors ``test_era_fidelity.py``'s purpose: vendoring the port without these
would discard the only thing that makes vendoring better than re-implementing —
the claim that this is the same algorithm, checkable rather than asserted.

These tests do not require the ``agentdescent`` package: they cover the
algorithm core that lives entirely under ``vendor/openevolve/`` (the AST gate,
the evaluator formulas, the archive's MAP-Elites logic and the epsilon-greedy
selection). Engine-level tests that mock ``evolve()`` / ``async_evolve()`` live
in ``test_openevolve_engine.py``.

Reference: ``algorithmicsuperintelligence/openevolve@411fb59``,
``examples/function_minimization/evaluator.py`` lines 190-215.
"""

from __future__ import annotations

import math

import pytest
from unittest.mock import MagicMock

from sciencediscovery_evolve.vendor.openevolve import (
    ALLOWED_IMPORTS,
    FORBIDDEN_CALLS,
    GLOBAL_MIN_VALUE,
    GLOBAL_MIN_X,
    GLOBAL_MIN_Y,
    INITIAL_PROGRAM,
    Program,
    code_distance,
    combined_metrics,
    extract_program,
    framework_score,
    objective_value,
    program_id,
    validate_source,
)
from sciencediscovery_evolve.vendor.openevolve.search import (
    EpsilonGreedy,
    OpenEvolveArchive,
    OpenEvolveStrategy,
)


# --- objective_value ---------------------------------------------------------


def test_objective_value_at_global_minimum():
    """The known optimum's value matches upstream's pinned constant."""
    assert objective_value(GLOBAL_MIN_X, GLOBAL_MIN_Y) == pytest.approx(GLOBAL_MIN_VALUE, abs=1e-3)


def test_objective_value_formula():
    """Spot-check the formula away from the optimum."""
    # f(0,0) = sin(0)*cos(0) + sin(0) + 0 = 0
    assert objective_value(0.0, 0.0) == pytest.approx(0.0, abs=1e-9)
    # f(1,0) = sin(1)*cos(0) + sin(0) + (1+0)/20 = sin(1) + 0.05
    assert objective_value(1.0, 0.0) == pytest.approx(math.sin(1.0) + 0.05, abs=1e-9)


# --- combined_metrics -------------------------------------------------------


def _trial(x: float, y: float, success: bool = True) -> dict:
    return {
        "x": x,
        "y": y,
        "value": objective_value(x, y),
        "success": success,
        "objective_calls": 1,
        "seconds": 0.01,
    }


def test_combined_metrics_weights_and_basin_multiplier():
    """The 0.5/0.3/0.2 weights and the basin multiplier match upstream's evaluator.py."""
    # A trial sitting exactly at the optimum: distance ~0, value ~ GLOBAL_MIN_VALUE.
    # GLOBAL_MIN_* are pinned approximations (3 decimals), so value_score is
    # 0.9997 rather than 1.0 — the formula is what matters, not the rounding.
    metrics = combined_metrics([_trial(GLOBAL_MIN_X, GLOBAL_MIN_Y)])
    assert metrics["successful_trials"] == 1
    assert metrics["value_score"] == pytest.approx(1.0, abs=1e-3)
    assert metrics["distance_score"] == pytest.approx(1.0, abs=1e-3)
    assert metrics["reliability_score"] == pytest.approx(1.0)
    # Basin multiplier: avg_distance < 0.5 → 1.5
    assert metrics["solution_quality_multiplier"] == 1.5
    base = 0.5 * metrics["value_score"] + 0.3 * metrics["distance_score"] + 0.2 * 1.0
    assert metrics["combined_score"] == pytest.approx(base * 1.5)


def test_combined_metrics_basin_multiplier_thresholds():
    """The four distance bands (0.5/1.5/3.0/beyond) produce 1.5/1.2/1.0/0.7."""
    # avg_distance < 0.5 → 1.5
    near = combined_metrics([_trial(GLOBAL_MIN_X + 0.1, GLOBAL_MIN_Y)])
    assert near["solution_quality_multiplier"] == 1.5
    # 0.5 ≤ avg_distance < 1.5 → 1.2
    mid = combined_metrics([_trial(GLOBAL_MIN_X + 1.0, GLOBAL_MIN_Y)])
    assert mid["solution_quality_multiplier"] == 1.2
    # 1.5 ≤ avg_distance < 3.0 → 1.0
    far = combined_metrics([_trial(GLOBAL_MIN_X + 2.0, GLOBAL_MIN_Y)])
    assert far["solution_quality_multiplier"] == 1.0
    # avg_distance ≥ 3.0 → 0.7
    very_far = combined_metrics([_trial(GLOBAL_MIN_X + 5.0, GLOBAL_MIN_Y)])
    assert very_far["solution_quality_multiplier"] == 0.7


def test_combined_metrics_all_trials_failed():
    """No successes → zero metrics with an error message."""
    metrics = combined_metrics([_trial(0, 0, success=False)])
    assert metrics["combined_score"] == 0.0
    assert metrics["successful_trials"] == 0
    assert "error" in metrics


def test_framework_score_maps_15_range_to_01():
    """framework_score maps [0, 1.5] → [0, 1], clamping at both ends."""
    assert framework_score({"combined_score": 0.0}) == 0.0
    assert framework_score({"combined_score": 1.5}) == 1.0
    assert framework_score({"combined_score": 0.75}) == pytest.approx(0.5)
    # Clamps above 1.5 and below 0
    assert framework_score({"combined_score": 2.0}) == 1.0
    assert framework_score({"combined_score": -1.0}) == 0.0


# --- validate_source (AST gate) ---------------------------------------------


def test_validate_source_admits_the_initial_program():
    """The shipped baseline passes the gate."""
    valid, error = validate_source(INITIAL_PROGRAM)
    assert valid, error


def test_validate_source_rejects_disallowed_imports():
    """Only the stdlib allowlist is admitted; pandas is not on it."""
    src = "import pandas\ndef search_algorithm(o, b, r, bounds):\n    return 0.0, 0.0\n"
    valid, error = validate_source(src)
    assert not valid
    assert "pandas" in error


def test_validate_source_rejects_dunder_access():
    src = "def search_algorithm(o, b, r, bounds):\n    x = object.__class__\n    return 0.0, 0.0\n"
    valid, error = validate_source(src)
    assert not valid
    assert "dunder" in error


def test_validate_source_rejects_forbidden_calls():
    for name in ("eval", "exec", "open", "globals"):
        src = f"def search_algorithm(o, b, r, bounds):\n    {name}()\n    return 0.0, 0.0\n"
        valid, _ = validate_source(src)
        assert not valid, f"{name} should be forbidden"


def test_validate_source_rejects_hard_coded_optimum():
    """Hard-coding the evaluator's known optima is the one thing the gate refuses by name."""
    for optimum in (str(GLOBAL_MIN_X), str(GLOBAL_MIN_Y), str(GLOBAL_MIN_VALUE)):
        src = f"def search_algorithm(o, b, r, bounds):\n    return {optimum}, {optimum}\n"
        valid, error = validate_source(src)
        assert not valid
        assert "hard-coding" in error or "optimum" in error


def test_validate_source_rejects_missing_search_algorithm():
    valid, error = validate_source("x = 1\n")
    assert not valid
    assert "search_algorithm" in error


def test_validate_source_rejects_empty_and_oversized():
    assert not validate_source("")[0]
    assert not validate_source("x" * 20_001)[0]


# --- extract_program --------------------------------------------------------


def test_extract_program_prefers_program_block():
    raw = "noise\n<PROGRAM>\ndef search_algorithm(o,b,r,bounds):\n  return 1.0,1.0\n</PROGRAM>\n<CHANGE_SUMMARY>fixed</CHANGE_SUMMARY>"
    code, summary = extract_program(raw)
    assert "def search_algorithm" in code
    assert summary == "fixed"


def test_extract_program_falls_back_to_fenced():
    raw = "```python\ndef search_algorithm(o,b,r,bounds):\n  return 1.0,1.0\n```"
    code, summary = extract_program(raw)
    assert "def search_algorithm" in code
    assert summary == ""


def test_extract_program_falls_back_to_raw():
    raw = "def search_algorithm(o,b,r,bounds):\n  return 1.0,1.0"
    code, _ = extract_program(raw)
    assert "def search_algorithm" in code


def test_extract_program_empty_reply():
    code, summary = extract_program("")
    assert code == ""
    assert summary == ""


# --- program_id / code_distance --------------------------------------------


def test_program_id_is_stable_and_short():
    pid = program_id("def f(): pass\n")
    assert len(pid) == 16
    assert program_id("def f(): pass\n") == pid
    assert program_id("def g(): pass\n") != pid


def test_code_distance_is_token_jaccard():
    # Identical → 0
    assert code_distance("def f(): pass", "def f(): pass") == 0.0
    # Disjoint tokens → 1
    assert code_distance("aaa", "zzz") == 1.0
    # Two of three tokens shared → distance = 1 - 2/3... wait: {a,b} vs {a,c}
    # intersection={a} (size 1), union={a,b,c} (size 3), dist = 1 - 1/3 = 2/3
    d = code_distance("a b", "a c")
    assert d == pytest.approx(2.0 / 3.0)


# --- OpenEvolveArchive ------------------------------------------------------


def _program(code: str, *, iteration: int = 1, island: int = 0, score: float = 0.5) -> Program:
    return Program(
        program_id(code),
        iteration,
        island,
        None,
        code,
        "summary",
        {"score": score},
        True,
        "",
    )


def test_archive_add_program_seeds_baseline():
    """The first program becomes the baseline and the best."""
    archive = OpenEvolveArchive(num_islands=2, feature_bins=2)
    p = _program("def f(): pass\n", score=0.5)
    archive.add_program(p, baseline=True)
    assert archive.baseline_id == p.program_id
    assert archive.best_id == p.program_id
    assert archive.best().program_id == p.program_id


def test_archive_add_program_rejects_duplicate():
    archive = OpenEvolveArchive()
    p = _program("def f(): pass\n")
    archive.add_program(p, baseline=True)
    assert archive.add_program(p) is False


def test_archive_best_updates_on_higher_score():
    archive = OpenEvolveArchive(num_islands=1, feature_bins=1)
    low = _program("def low(): pass\n", score=0.3)
    high = _program("def high(): pass\n", score=0.9)
    archive.add_program(low, baseline=True)
    archive.add_program(high)
    assert archive.best().program_id == high.program_id


def test_archive_invalid_program_does_not_occupy_cell():
    archive = OpenEvolveArchive()
    invalid = Program("bad", 1, 0, None, "def f(): pass", "", {}, False, "error")
    changed = archive.add_program(invalid, baseline=True)
    # Invalid programs are recorded but do not occupy a cell or become best
    assert changed is False
    assert archive.best_id is None


def test_archive_candidate_limit_stops_selection():
    """select_parent returns None past the candidate limit — upstream's "no more"."""
    archive = OpenEvolveArchive(num_islands=1, feature_bins=1, candidate_limit=1)
    archive.add_program(_program("def f(): pass\n", score=0.5), baseline=True)
    # First select reserves iteration 1; second should be None (limit=1, next=2>1)
    first = archive.select_parent()
    assert first is not None
    second = archive.select_parent()
    assert second is None


def test_archive_select_parent_returns_five_tuple():
    archive = OpenEvolveArchive(num_islands=2)
    archive.add_program(_program("def f(): pass\n", score=0.5), baseline=True)
    selection = archive.select_parent()
    assert selection is not None
    iteration, island, parent, best, inspiration = selection
    assert isinstance(iteration, int)
    assert isinstance(island, int)
    assert isinstance(parent, Program)
    assert isinstance(best, Program)
    assert isinstance(inspiration, Program)


# --- EpsilonGreedy ----------------------------------------------------------


class _Rng:
    """A deterministic rng that returns a fixed sequence of floats/choices."""

    def __init__(self, values: list[float]):
        self._values = list(values)
        self._i = 0

    def random(self) -> float:
        v = self._values[self._i % len(self._values)]
        self._i += 1
        return v

    def choice(self, items):
        return items[0]


def test_epsilon_greedy_exploits_when_under_ratio():
    """Below the exploitation ratio, the best-fitness member is picked."""
    rng = _Rng([0.0])  # 0.0 < 0.7 → exploit
    eg = EpsilonGreedy(rng, exploitation_ratio=0.7)

    class _Ctx:
        candidates = [
            type("C", (), {"score": 0.3}),
            type("C", (), {"score": 0.9}),
            type("C", (), {"score": 0.5}),
        ]
        head = candidates[0]

    picked = eg.select(_Ctx(), 1)
    assert picked[0].score == 0.9  # the best


def test_epsilon_greedy_explores_when_over_ratio():
    """Above the exploitation ratio, a random member is picked."""
    rng = _Rng([0.9])  # 0.9 > 0.7 → explore
    eg = EpsilonGreedy(rng, exploitation_ratio=0.7)

    class _Ctx:
        candidates = [
            type("C", (), {"score": 0.3}),
            type("C", (), {"score": 0.9}),
        ]
        head = candidates[0]

    picked = eg.select(_Ctx(), 1)
    # Exploration picks rng.choice(candidates)[0] = first candidate
    assert picked[0].score == 0.3


def test_epsilon_greedy_empty_candidates_returns_head():
    eg = EpsilonGreedy(_Rng([]), 0.7)
    head = type("C", (), {"score": 1.0})
    ctx = type("Ctx", (), {"candidates": [], "head": head})
    picked = eg.select(ctx(), 1)
    assert picked[0] is head


# --- OpenEvolveStrategy -----------------------------------------------------


def test_strategy_initial_returns_baseline():
    domain = MagicMock(); domain.initial_program = INITIAL_PROGRAM; domain.initial_summary = "baseline"
    s = OpenEvolveStrategy(domain)
    state = s.initial()
    assert state["code"] == INITIAL_PROGRAM
    assert state["program_id"] == program_id(INITIAL_PROGRAM)
    assert "baseline" in state["change_summary"]


def test_strategy_render_returns_code():
    domain = MagicMock(); domain.initial_program = INITIAL_PROGRAM; domain.initial_summary = "baseline"
    s = OpenEvolveStrategy(domain)
    assert s.render({"code": "custom"}) == "custom"
    assert s.render({}) == INITIAL_PROGRAM
    assert s.render({}) == INITIAL_PROGRAM  # fallback


def test_strategy_to_diff_parses_proposal():
    domain = MagicMock(); domain.initial_program = INITIAL_PROGRAM; domain.initial_summary = "baseline"
    s = OpenEvolveStrategy(domain)
    proposal = '{"code":"def f(): pass","iteration":3,"island":1,"parent_id":"abc"}'
    diff = s.to_diff({}, proposal, "author", 0, "target")
    assert diff is not None
    assert diff.ops["code"] == "def f(): pass"
    assert diff.ops["iteration"] == "3"
    assert diff.ops["island"] == "1"


def test_strategy_to_diff_rejects_bad_json():
    domain = MagicMock(); domain.initial_program = INITIAL_PROGRAM; domain.initial_summary = "baseline"
    s = OpenEvolveStrategy(domain)
    assert s.to_diff({}, "not json", "a", 0, "t") is None
    assert s.to_diff({}, '{"code":""}', "a", 0, "t") is None  # empty code
