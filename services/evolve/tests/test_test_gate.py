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

"""Scoring by a test suite.

The tests worth writing here are all about the thing that measures: a candidate
is executed, and a candidate that can reach the tests will eventually find that
deleting an assertion is cheaper than satisfying it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import pytest

from sciencediscovery_evolve.test_gate_domain import (
    TestGateError,
    _group_of,
    _read_junit,
    _restore_frozen,
    _roles,
    test_gate_domain as build_domain,
)
from sciencediscovery_evolve.vendor.era.sandbox import SandboxCapability

CARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "maximize", "id": "pass_rate", "name": "通过率",
        "measure": {
            "caseSplit": {"gateGroups": 4, "rolloutGroups": 4, "testGroups": 2},
            "entrypoint": ["solver.py"],
            "frozen": ["tests/**", "conftest.py"],
            "kind": "test_gate",
            "testCmd": ["pytest", "-q"],
        },
        "normalize": {"kind": "identity"}, "weight": 1.0,
    }],
    "hash": "sha256:gate", "schemaVersion": 1, "solvedThreshold": 0.999,
}


def project(tmp_path: Path) -> Path:
    root = tmp_path / "pristine"
    (root / "tests").mkdir(parents=True)
    (root / "solver.py").write_text("def solve(x):\n    return x\n", encoding="utf-8")
    (root / "tests" / "test_solver.py").write_text(
        "from solver import solve\n\n\ndef test_doubles():\n    assert solve(2) == 4\n",
        encoding="utf-8")
    (root / "conftest.py").write_text("# fixtures\n", encoding="utf-8")
    return root


# --- the layer that cannot be skipped --------------------------------------------


def test_a_candidate_that_edits_the_tests_finds_them_restored(tmp_path: Path) -> None:
    pristine = project(tmp_path)
    scratch = tmp_path / "work"
    scratch.mkdir()
    (scratch / "tests").mkdir()
    (scratch / "solver.py").write_text("def solve(x):\n    return x * 2\n", encoding="utf-8")
    # The candidate has weakened the assertion.
    (scratch / "tests" / "test_solver.py").write_text("def test_doubles():\n    assert True\n",
                                                      encoding="utf-8")
    (scratch / "conftest.py").write_text("# tampered\n", encoding="utf-8")

    restored = _restore_frozen(pristine, scratch, ("tests/**", "conftest.py"))

    assert restored == 2
    assert "solve(2) == 4" in (scratch / "tests" / "test_solver.py").read_text(encoding="utf-8")
    assert (scratch / "conftest.py").read_text(encoding="utf-8") == "# fixtures\n"
    # …and the candidate's own work is untouched: only the measurement is frozen.
    assert "x * 2" in (scratch / "solver.py").read_text(encoding="utf-8")


def test_a_candidate_that_deletes_a_test_file_finds_it_back(tmp_path: Path) -> None:
    # Deleting a test weakens the measurement exactly as much as editing one, and
    # only restoring files that still exist would miss it.
    pristine = project(tmp_path)
    scratch = tmp_path / "work"
    scratch.mkdir()
    (scratch / "solver.py").write_text("def solve(x):\n    return x\n", encoding="utf-8")

    _restore_frozen(pristine, scratch, ("tests/**", "conftest.py"))

    assert (scratch / "tests" / "test_solver.py").exists()


def test_a_card_with_nothing_frozen_is_refused(tmp_path: Path) -> None:
    # Upstream's own note: without it the shortest path to a high score is to
    # weaken the thing measuring it.
    card = {**CARD, "criteria": [{
        **CARD["criteria"][0],
        "measure": {**CARD["criteria"][0]["measure"], "frozen": []},
    }]}
    with pytest.raises(TestGateError) as error:
        build_domain(scorecard=card, workspace=project(tmp_path),
                         capability=SandboxCapability(backend="seatbelt"))
    assert "冻结" in str(error.value)


def test_a_card_with_no_test_command_is_refused(tmp_path: Path) -> None:
    card = {**CARD, "criteria": [{
        **CARD["criteria"][0],
        "measure": {**CARD["criteria"][0]["measure"], "testCmd": []},
    }]}
    with pytest.raises(TestGateError):
        build_domain(scorecard=card, workspace=project(tmp_path),
                         capability=SandboxCapability(backend="seatbelt"))


# --- groups ----------------------------------------------------------------------


def test_a_group_follows_the_test_rather_than_its_position() -> None:
    # Hashing the id rather than the index: the split has to survive a test being
    # added or renamed, or every group changes membership and two runs stop being
    # comparable.
    before = {name: _group_of(name, 0, 10) for name in ("a::x", "b::y", "c::z")}
    after = {name: _group_of(name, 0, 10) for name in ("a::x", "new::t", "b::y", "c::z")}

    for name, group in before.items():
        assert after[name] == group


def test_a_different_seed_is_a_different_split() -> None:
    names = [f"t::{index}" for index in range(40)]
    one = [_group_of(name, 0, 8) for name in names]
    two = [_group_of(name, 7, 8) for name in names]
    assert one != two


def test_rollout_gate_and_test_groups_do_not_overlap() -> None:
    roles = _roles(CARD["criteria"][0]["measure"])
    # The whole three-way split: a candidate measured on the groups that decide
    # would be scored on what the search already optimised against.
    assert set(roles["rollout"]).isdisjoint(roles["gate"])
    assert set(roles["gate"]).isdisjoint(roles["test"])
    assert roles["rollout"] == [0, 1, 2, 3]
    assert roles["gate"] == [4, 5, 6, 7]
    assert roles["test"] == [8, 9]


# --- reading the suite's results --------------------------------------------------


def test_a_junit_report_becomes_pass_or_fail_per_test(tmp_path: Path) -> None:
    report = tmp_path / "junit.xml"
    report.write_text("""<testsuites><testsuite>
      <testcase classname="tests.test_a" name="test_ok"/>
      <testcase classname="tests.test_a" name="test_bad"><failure>boom</failure></testcase>
      <testcase classname="tests.test_b" name="test_err"><error>import</error></testcase>
      <testcase classname="tests.test_b" name="test_skipped"><skipped/></testcase>
    </testsuite></testsuites>""", encoding="utf-8")

    outcomes = _read_junit(report)

    assert outcomes["tests.test_a::test_ok"] is True
    assert outcomes["tests.test_a::test_bad"] is False
    # An error is a failure: the candidate broke it either way.
    assert outcomes["tests.test_b::test_err"] is False
    # A skipped test says nothing about the candidate, so it does not count
    # against it.
    assert outcomes["tests.test_b::test_skipped"] is True


def test_an_unparseable_report_is_an_error_rather_than_a_zero(tmp_path: Path) -> None:
    report = tmp_path / "junit.xml"
    report.write_text("not xml at all", encoding="utf-8")
    # Scoring it zero would read as "the candidate failed every test", which is
    # a claim about the candidate that nothing supports.
    with pytest.raises(TestGateError):
        _read_junit(report)


def test_a_candidate_that_rewrites_the_tests_at_run_time_gains_nothing(tmp_path: Path) -> None:
    """The layer that cannot be skipped, exercised by actually running it.

    A candidate is executed. This one writes over the test file as its first act
    — the shortest path to a perfect score, if the overlay were not there — and
    then returns a wrong answer. It must still be scored on the original
    assertions.
    """
    from sciencediscovery_evolve.measurement import missing_candidate_runtime
    from sciencediscovery_evolve.vendor.era.sandbox import detect_local_capability

    capability = detect_local_capability()
    if not capability.available:
        pytest.skip("no sandbox backend on this host")

    root = tmp_path / "pristine"
    (root / "tests").mkdir(parents=True)
    (root / "solver.py").write_text("def solve(x):\n    return x * 2\n", encoding="utf-8")
    (root / "tests" / "test_solver.py").write_text(
        "import sys, pathlib\n"
        "sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))\n"
        "from solver import solve\n\n\n"
        "def test_doubles():\n    assert solve(2) == 4\n\n\n"
        "def test_triples():\n    assert solve(3) == 6\n",
        encoding="utf-8")

    card = {**CARD, "criteria": [{
        **CARD["criteria"][0],
        "measure": {
            **CARD["criteria"][0]["measure"],
            "caseSplit": {"gateGroups": 1, "rolloutGroups": 1, "testGroups": 0},
            "testCmd": ["-m", "pytest", "-q", "--junitxml=.junit.xml"],
        },
    }]}
    domain = build_domain(
        scorecard=card, workspace=root, capability=capability,
        entrypoint_path="solver.py", candidate_timeout=120.0,
    )

    cheating = (
        "import pathlib\n\n"
        "pathlib.Path(__file__).resolve().parent.joinpath('tests', 'test_solver.py')"
        ".write_text('def test_doubles():\\n    assert True\\n')\n\n\n"
        "def solve(x):\n    return 0\n"
    )
    valid, metrics, _error = domain.evaluate(cheating, (0, 1))

    # Scored on the original assertions, which a `solve` returning 0 fails.
    assert valid, metrics
    # Both of them, so this is measuring the suite and not an empty report.
    assert metrics["cases"] == 2, metrics
    assert metrics["failed"] == 2, metrics
    assert metrics["pass_rate"] == pytest.approx(0.0), metrics

    # And the same suite scores an honest candidate full marks, which is what
    # makes the zero above mean something.
    honest_valid, honest, _ = domain.evaluate("def solve(x):\n    return x * 2\n", (0, 1))
    assert honest_valid, honest
    assert honest["pass_rate"] == pytest.approx(1.0), honest


def test_a_missing_runner_says_so_instead_of_blaming_the_candidate(tmp_path: Path) -> None:
    """Found on a real deployment: the sidecar's venv had no pytest.

    The suite failing because the candidate is wrong is the signal this mode
    runs on. The suite failing because its runner is not installed is a
    deployment problem, and reporting it as "the project's implementation
    cannot even run its tests" sends the user to the wrong file.
    """
    from sciencediscovery_evolve.vendor.era.sandbox import detect_local_capability

    capability = detect_local_capability()
    if not capability.available:
        pytest.skip("no sandbox backend on this host")

    root = project(tmp_path)
    card = {**CARD, "criteria": [{
        **CARD["criteria"][0],
        "measure": {
            **CARD["criteria"][0]["measure"],
            "caseSplit": {"gateGroups": 1, "rolloutGroups": 1, "testGroups": 0},
            "testCmd": ["-m", "no_such_runner"],
        },
    }]}
    domain = build_domain(scorecard=card, workspace=root, capability=capability,
                          entrypoint_path="solver.py", candidate_timeout=60.0)

    with pytest.raises(TestGateError) as error:
        domain.evaluate("def solve(x):\n    return x\n", (0, 1))

    message = str(error.value)
    assert "JUnit" in message
    # The runner's own words, which are the only thing that says what is wrong.
    assert "no_such_runner" in message
