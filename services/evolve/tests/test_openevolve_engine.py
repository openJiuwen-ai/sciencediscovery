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

"""Engine-level tests for OpenEvolve: refusal checks, mode selection, and the
event stream the ``_Reporter`` emits.

These do not drive ``agentdescent.evolve()`` — that lives in an end-to-end test
once ``agentdescent>=0.4.5`` is installed. What they cover is the glue that is
ours: the refusal gate that mirrors ``preflight.ts``, the ``_mode`` selection
that mirrors ``era_engine._mode``, and the ``_Reporter`` dispatch that turns
the vendor's ``on_event`` calls into the ``events.*`` NDJSON stream.

Mirrors ``test_era_engine.py``'s structure (Harness + refusal + event tests),
adapted for OpenEvolve's archive model (iteration as node_index, island as
depth, parent_id → parent's iteration as parent_index).
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import MagicMock

import pytest

from sciencediscovery_evolve import events
from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.openevolve_engine import (
    OpenEvolveEngine,
    _Reporter,
    _Usage,
    _mode,
    _refuse_unrunnable,
)
from sciencediscovery_evolve.vendor.openevolve import INITIAL_PROGRAM, Program, program_id


# --- RunSpec factory --------------------------------------------------------


def _spec(**overrides: Any) -> RunSpec:
    """A minimal runnable spec. Overrides applied on top of safe defaults."""
    defaults: Dict[str, Any] = dict(
        search_id="test-search",
        algorithm="openevolve",
        expansions=6,
        scorecard_hash="hash",
        scorecard={"criteria": [{"measure": {"kind": "dataset_metric"}, "normalize": {"kind": "identity"}}]},
        statement="minimise f(x,y)",
        max_tokens_per_call=16_000,
        thinking="disabled",
        workers=3,
        options={},
    )
    return RunSpec(**{**defaults, **overrides})


# --- Refusal checks (same as PUCT: scorecard, resume, packages) ---


def test_refuse_resume():
    with pytest.raises(Exception, match="resumed"):
        _refuse_unrunnable(_spec(resume_from_sequence=5))


def test_refuse_empty_scorecard():
    with pytest.raises(Exception, match="scorecard"):
        _refuse_unrunnable(_spec(scorecard={}))


def test_no_refusal_for_valid_spec():
    _refuse_unrunnable(_spec())


# --- _mode ------------------------------------------------------------------


def test_mode_defaults_to_serial_for_one_worker():
    assert _mode(_spec(workers=1)) == "serial"


def test_mode_defaults_to_async_for_many_workers():
    assert _mode(_spec(workers=4)) == "async"


def test_mode_explicit_serial():
    assert _mode(_spec(workers=4, options={"mode": "serial"})) == "serial"


def test_mode_explicit_sync():
    assert _mode(_spec(workers=4, options={"mode": "sync"})) == "sync"


def test_mode_rejects_unknown():
    with pytest.raises(Exception, match="unknown"):
        _mode(_spec(options={"mode": "bogus"}))





class _Collector:
    """Collects every event the reporter emits, in order."""

    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []

    def __call__(self, event: Dict[str, Any]) -> None:
        self.events.append(event)

    def types(self) -> List[str]:
        return [e["type"] for e in self.events]


def _make_reporter(archive: Any = None, spec: Optional[RunSpec] = None) -> Tuple[_Reporter, _Collector]:
    collector = _Collector()
    store = MagicMock()
    store.put.return_value = "cas_hash"
    usage = _Usage()
    domain = MagicMock()
    domain.test_shards = (1, 2)
    domain.evaluate = MagicMock(return_value=(True, {"score": 0.93}, ""))
    domain.reward = MagicMock(return_value=0.5)
    reporter = _Reporter(
        spec or _spec(),
        archive,
        domain,
        store,
        usage,
        collector,
    )
    return reporter, collector


def _make_program(
    code: str = "def search_algorithm(o,b,r,bounds):\n  return 0.0, 0.0\n",
    *,
    iteration: int = 1,
    island: int = 0,
    parent_id: Optional[str] = None,
    score: float = 0.8,
    valid: bool = True,
) -> Program:
    return Program(
        program_id(code),
        iteration,
        island,
        parent_id,
        code,
        "a mutation",
        {"score": score, "value_score": score * 0.5, "distance_score": score * 0.3},
        valid,
        "",
    )


def _make_archive_with(programs: List[Program]) -> MagicMock:
    archive = MagicMock()
    archive.programs = {p.program_id: p for p in programs}
    archive.history = list(programs)
    archive.best_id = programs[-1].program_id if programs else None
    archive.migrations = 0
    archive.best.return_value = programs[-1] if programs else None
    return archive


# --- selected ---------------------------------------------------------------


def test_selected_emits_events_selected():
    reporter, collector = _make_reporter()
    reporter.on_event("selected", {"iteration": 5, "island": 1, "parent_id": "abc", "best_id": "def", "inspiration_id": "ghi"})
    assert "selected" in collector.types()
    assert collector.events[0]["nodeIndex"] == 5
    assert collector.events[0]["ancestorVisits"] == []
    assert reporter.attempted == 1


# --- seeded -----------------------------------------------------------------


def test_seeded_emits_events_seeded():
    reporter, collector = _make_reporter()
    reporter.on_event("seeded", {"metrics": {"score": 0.96}, "program_id": "abc"})
    assert "seeded" in collector.types()
    assert collector.events[0]["baselineScore"] == pytest.approx(0.96)
    assert collector.events[0]["nodeIndex"] == 0


# --- node → expanded + evaluated -------------------------------------------


def test_node_emits_expanded_and_evaluated():
    program = _make_program(iteration=3, island=1, score=1.2)
    archive = _make_archive_with([program])
    reporter, collector = _make_reporter(archive=archive)
    reporter.on_event("node", {"program": program, "metrics": program.metrics, "valid": True, "cell_changed": True})
    types = collector.types()
    assert "expanded" in types
    assert "evaluated" in types
    expanded = next(e for e in collector.events if e["type"] == "expanded")
    assert expanded["nodeIndex"] == 3
    assert expanded["depth"] == 3  # depth = iteration for openevolve
    assert expanded["score"] == pytest.approx(1.2)
    evaluated = next(e for e in collector.events if e["type"] == "evaluated")
    assert evaluated["nodeIndex"] == 3
    assert evaluated["gateScore"] == pytest.approx(1.2)


def test_node_invalid_emits_expanded_without_evaluated():
    program = _make_program(valid=False, score=0.0)
    archive = _make_archive_with([program])
    reporter, collector = _make_reporter(archive=archive)
    reporter.on_event("node", {"program": program, "metrics": {"score": 0.0}, "valid": False, "cell_changed": False})
    assert "expanded" in collector.types()
    assert "evaluated" not in collector.types()
    assert reporter.scored == 0
    assert len(reporter.failures) == 1


def test_node_looked_up_parent_index_from_archive():
    parent = _make_program("def parent_algo(o,b,r,bounds):\n  return 0.0, 0.0\n", iteration=2, island=0)
    child = _make_program("def child_algo(o,b,r,bounds):\n  return 0.0, 0.0\n", iteration=7, island=1, parent_id=parent.program_id)
    archive = _make_archive_with([parent, child])
    reporter, collector = _make_reporter(archive=archive)
    reporter.on_event("node", {"program": child, "metrics": child.metrics, "valid": True, "cell_changed": False})
    expanded = next(e for e in collector.events if e["type"] == "expanded")
    assert expanded["parentIndex"] == 2


# --- best → merged + cost --------------------------------------------------


def test_best_emits_merged_and_cost():
    program = _make_program(iteration=4, score=1.4)
    reporter, collector = _make_reporter()
    reporter.on_event("best", {"program": program, "committed_version": 7})
    assert "merged" in collector.types()
    assert "cost" in collector.types()
    merged = next(e for e in collector.events if e["type"] == "merged")
    assert merged["nodeIndex"] == 4
    assert merged["accepted"] is True


# --- inserted / migrated ---------------------------------------------------


def test_inserted_emits_events_inserted():
    reporter, collector = _make_reporter()
    reporter.on_event("inserted", {"node_index": 3, "complexity_bin": 1, "diversity_bin": 2, "island": 0, "via": "insert"})
    assert "inserted" in collector.types()
    event = next(e for e in collector.events if e["type"] == "inserted")
    assert event["complexityBin"] == 1
    assert event["via"] == "insert"


def test_migrated_emits_events_migrated():
    reporter, collector = _make_reporter()
    reporter.on_event("migrated", {"node_index": 5, "from_island": 0, "to_island": 1})
    assert "migrated" in collector.types()
    event = next(e for e in collector.events if e["type"] == "migrated")
    assert event["fromIsland"] == 0
    assert event["toIsland"] == 1


# --- finish → search_finished ----------------------------------------------


def test_finish_emits_search_finished():
    program = _make_program(iteration=3, score=1.4)
    archive = _make_archive_with([program])
    reporter, collector = _make_reporter(archive=archive)
    reporter.finish("succeeded", test_score=0.93)
    assert "search_finished" in collector.types()
    finished = next(e for e in collector.events if e["type"] == "search_finished")
    assert finished["status"] == "succeeded"
    assert finished["bestNodeIndex"] == 3
    assert finished["bestTestScore"] == pytest.approx(0.93)


def test_finish_failed_when_nothing_scored():
    archive = _make_archive_with([])
    reporter, collector = _make_reporter(archive=archive)
    reporter.attempted = 5
    reporter.scored = 0
    reporter.failures = ["candidate produced no score"]
    reporter.finish("succeeded")
    finished = next(e for e in collector.events if e["type"] == "search_finished")
    assert finished["status"] == "failed"


def test_finish_warns_when_all_scores_identical():
    program = _make_program(score=0.5)
    archive = _make_archive_with([program] * 5)
    reporter, collector = _make_reporter(archive=archive)
    for _ in range(5):
        reporter._distinct_scores.add(0.5)
    reporter.finish("succeeded")
    logs = [e for e in collector.events if e["type"] == "log" and e["level"] == "warn"]
    assert any("scored the same" in e["message"] for e in logs)
