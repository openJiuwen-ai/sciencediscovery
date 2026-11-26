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
adapted for OpenEvolve's archive model (iteration as node_index, ancestry as
depth, parent_id → parent's iteration as parent_index).
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import MagicMock

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_evolve import events, openevolve_engine
from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.openevolve_engine import (
    OpenEvolveEngine,
    _Reporter,
    _Usage,
    _mode,
    _refuse_unrunnable,
)
from sciencediscovery_evolve.vendor.openevolve import (
    INITIAL_PROGRAM,
    OpenEvolveArchive,
    Program,
    program_id,
)


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


# --- _default_completion -----------------------------------------------------
# A gateway seen in the wild rejects every temperature except the one it is
# configured with, which turned every mutation call into a failed candidate
# (issue reported against `/evolve-design --algorithm puct`, which shares
# this same default through `completion_for`). Sending none by default, like
# `thinking`, is what fixed it.


def test_default_completion_omits_temperature_when_unset(monkeypatch):
    captured: Dict[str, Any] = {}

    def fake_completion_for(*_args: Any, **kwargs: Any) -> Callable[[str], str]:
        captured.update(kwargs)
        return lambda _prompt: ""

    monkeypatch.setattr(openevolve_engine, "completion_for", fake_completion_for)
    openevolve_engine._default_completion(_spec(), MagicMock(), lambda: False)
    assert captured["temperature"] is None


def test_default_completion_forwards_explicit_temperature(monkeypatch):
    captured: Dict[str, Any] = {}

    def fake_completion_for(*_args: Any, **kwargs: Any) -> Callable[[str], str]:
        captured.update(kwargs)
        return lambda _prompt: ""

    monkeypatch.setattr(openevolve_engine, "completion_for", fake_completion_for)
    openevolve_engine._default_completion(_spec(options={"temperature": 0.6}), MagicMock(), lambda: False)
    assert captured["temperature"] == 0.6


def test_default_completion_forwards_transient_retry_options(monkeypatch):
    captured: Dict[str, Any] = {}

    def fake_completion_for(*_args: Any, **kwargs: Any) -> Callable[[str], str]:
        captured.update(kwargs)
        return lambda _prompt: ""

    monkeypatch.setattr(openevolve_engine, "completion_for", fake_completion_for)
    openevolve_engine._default_completion(
        _spec(options={"model_retries": 1, "retry_backoff": 0.25}), MagicMock(), lambda: False,
    )
    assert captured["max_retries"] == 1
    assert captured["retry_backoff"] == 0.25


def test_default_completion_forwards_low_effort(monkeypatch):
    captured = {}
    monkeypatch.setattr(openevolve_engine, "completion_for", lambda *_args, **kwargs: captured.update(kwargs))
    openevolve_engine._default_completion(_spec(thinking="enabled", thinking_effort="low"), MagicMock(), lambda: False)
    assert captured["thinking"] == "enabled"
    assert captured["thinking_effort"] == "low"


def test_capped_empty_reply_is_not_retried_by_openevolve():
    from sciencediscovery_evolve.completion import CompletionUsage
    calls = []

    def factory(*_args):
        def complete(_prompt, sink, _on_failure):
            calls.append(1)
            sink(CompletionUsage(total=16010, completion=16000, capped=True))
            return ""
        return complete

    spec = _spec(options={"model_retries": 5})
    usage = _Usage()
    collector = _Collector()
    reporter = _Reporter(spec, None, MagicMock(), MagicMock(), usage, collector)
    engine = OpenEvolveEngine(completion_factory=factory)
    assert engine._model_call(spec, usage, reporter, lambda: False)("mutate", 1) == ("", "")
    assert calls == [1]
    assert usage.of(1).total == 16010
    assert "16000 output tokens" in next(e for e in collector.events if e["type"] == "expanded")["error"]
    assert [e["tokens"] for e in collector.events if e["type"] == "cost"] == [16010]
    assert engine._model_call(spec, usage, reporter, lambda: False)("mutate again", 2) == ("", "")
    assert calls == [1, 1]
    assert [e["tokens"] for e in collector.events if e["type"] == "cost"] == [16010, 32020]



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


def _real_archive() -> OpenEvolveArchive:
    """A real archive seeded with the iteration-0 baseline, as a run has it."""
    archive = OpenEvolveArchive(archive_size=20, num_islands=3, feature_bins=4)
    archive.add_program(Program(
        program_id(INITIAL_PROGRAM), 0, 0, None, INITIAL_PROGRAM, "",
        {"score": 0.5}, True, "",
    ), baseline=True)
    return archive


def _add(reporter: _Reporter, archive: OpenEvolveArchive, program: Program) -> None:
    """Add a program to the archive and report it, as the aggregator does."""
    archive.add_program(program)
    reporter.on_event("node", {
        "program": program, "metrics": program.metrics, "valid": program.valid,
        "cell_changed": True,
    })


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
    # No parent means the root's generation, not the attempt ordinal.
    assert expanded["depth"] == 0
    assert expanded["score"] == pytest.approx(1.2)
    evaluated = next(e for e in collector.events if e["type"] == "evaluated")
    assert evaluated["nodeIndex"] == 3
    assert evaluated["gateScore"] == pytest.approx(1.2)
    # The gate score is not a rollout measurement; the UIs fall back to `score`.
    assert "rolloutScore" not in evaluated


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


def test_expanded_depth_is_ancestry_not_the_iteration_ordinal():
    """#1457: a node at iteration 4 parented by the root has depth 1."""
    archive = _real_archive()
    root_id = archive.baseline().program_id
    child = _make_program(
        "def child_algo(o,b,r,bounds):\n  return 0.0, 0.0\n", iteration=4, parent_id=root_id,
    )
    reporter, collector = _make_reporter(archive=archive)
    reporter.on_event("selected", {
        "iteration": 4, "island": 0, "parent_id": root_id,
        "best_id": root_id, "inspiration_id": root_id,
    })
    _add(reporter, archive, child)

    expanded = next(e for e in collector.events if e["type"] == "expanded")
    assert expanded["nodeIndex"] == 4
    assert expanded["parentIndex"] == 0
    assert expanded["depth"] == 1
    assert expanded["iteration"] == 4  # attempts keep their own number


def test_expanded_depth_follows_the_parent_chain():
    """The report's chain 3 → 2 → 0 puts node 3 at depth 2, not 3."""
    archive = _real_archive()
    root_id = archive.baseline().program_id
    node2 = _make_program(
        "def node2_algo(o,b,r,bounds):\n  return 0.0, 0.0\n", iteration=2, parent_id=root_id,
    )
    node3 = _make_program(
        "def node3_algo(o,b,r,bounds):\n  return 0.0, 0.0\n", iteration=3, parent_id=node2.program_id,
    )
    archive.add_program(node2)
    reporter, collector = _make_reporter(archive=archive)
    _add(reporter, archive, node3)

    expanded = next(e for e in collector.events if e["type"] == "expanded")
    assert expanded["parentIndex"] == 2
    assert expanded["depth"] == 2


def test_unknown_parent_is_depth_zero_not_an_invented_generation():
    archive = _real_archive()
    orphan = _make_program(
        "def orphan_algo(o,b,r,bounds):\n  return 0.0, 0.0\n", iteration=9, parent_id="missing",
    )
    reporter, collector = _make_reporter(archive=archive)
    _add(reporter, archive, orphan)
    expanded = next(e for e in collector.events if e["type"] == "expanded")
    assert expanded["depth"] == 0


def test_failed_attempt_depth_comes_from_its_selected_parent():
    """A call that never returned has no node, but its parent was selected."""
    archive = _real_archive()
    root_id = archive.baseline().program_id
    reporter, collector = _make_reporter(archive=archive)
    reporter.on_event("selected", {
        "iteration": 4, "island": 0, "parent_id": root_id,
        "best_id": root_id, "inspiration_id": root_id,
    })
    reporter.note_failure(4, "the model call timed out")

    failed = next(e for e in collector.events if e["type"] == "expanded")
    assert failed["valid"] is False
    assert failed["depth"] == 1
    assert failed["depth"] != failed["iteration"]


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


def test_finish_carries_why_the_run_stopped_early():
    """A run ended by the scorecard's threshold says so on the finish event.

    `target_reward` — the scorecard's `solvedThreshold` — ends a sweep at 1 of 8
    expansions (#948). The summary the user reads is built from this event, so a
    reason that lives only in the log leaves the run looking like it just stopped.
    """
    program = _make_program(iteration=1, score=1.0)
    archive = _make_archive_with([program])
    reporter, collector = _make_reporter(archive=archive, spec=_spec(expansions=8))
    reporter.note_outcome(SimpleNamespace(stop_reason="target_reward"), 8)
    reporter.finish("succeeded")

    finished = next(e for e in collector.events if e["type"] == "search_finished")
    assert finished["stopReason"] == "target_reward"
    assert finished["expansionsPlanned"] == 8


def test_a_completed_run_with_one_failed_call_does_not_report_a_shortfall():
    """#1457: six attempts, one call never returned, five programs — full round budget.

    ``done = len(history) - 1`` counted the five programs and called a healthy
    six-round run truncated. Attempts are what the round budget measures, and a
    failed call spent one of them.
    """
    archive = _real_archive()
    root_id = archive.baseline().program_id
    reporter, collector = _make_reporter(archive=archive)
    for iteration in range(1, 7):
        reporter.on_event("selected", {
            "iteration": iteration, "island": 0, "parent_id": root_id,
            "best_id": root_id, "inspiration_id": root_id,
        })
    reporter.note_failure(1, "the model call timed out")
    for iteration in range(2, 7):
        _add(reporter, archive, _make_program(
            f"def search_algorithm(o,b,r,bounds):\n  return {iteration}.0, 0.0\n",
            iteration=iteration, parent_id=root_id, score=0.6 + iteration / 100,
        ))

    reporter.note_outcome(SimpleNamespace(stop_reason="rounds"), 6)
    reporter.finish("succeeded")

    shortfall = [
        e["message"] for e in collector.events
        if e["type"] == "log" and "planned" in e["message"]
    ]
    assert shortfall == []
    finished = next(e for e in collector.events if e["type"] == "search_finished")
    assert finished["attempts"] == 6
    assert finished["generated"] == 5
    assert finished["evaluated"] == 5
    assert finished["archiveNodes"] == 6  # five generated programs + baseline
    assert finished["candidates"] == 6  # existing consumers keep this population
    assert finished["expansionsPlanned"] == 6
    assert finished["stopReason"] == "rounds"


def test_a_real_shortfall_is_still_reported():
    """The fix is about counting attempts, not about silencing the warning."""
    archive = _real_archive()
    reporter, collector = _make_reporter(archive=archive)
    reporter.attempted = 4
    reporter.note_outcome(SimpleNamespace(stop_reason="patience"), 6)
    reporter.finish("succeeded")
    logs = [
        e["message"] for e in collector.events
        if e["type"] == "log" and "planned" in e["message"]
    ]
    assert logs == ["planned 6 expansions, ran 4, stopped because patience."]


def test_regenerating_identical_code_is_two_attempts_but_one_generated_program():
    """#1457: the archive refuses a duplicate program_id, so count it once."""
    archive = _real_archive()
    root_id = archive.baseline().program_id
    reporter, collector = _make_reporter(archive=archive)
    code = "def search_algorithm(o,b,r,bounds):\n  return 1.0, 2.0\n"
    for iteration in (1, 2):
        reporter.on_event("selected", {
            "iteration": iteration, "island": 0, "parent_id": root_id,
            "best_id": root_id, "inspiration_id": root_id,
        })
        _add(reporter, archive, _make_program(code, iteration=iteration, parent_id=root_id))

    reporter.note_outcome(SimpleNamespace(stop_reason="rounds"), 2)
    reporter.finish("succeeded")

    finished = next(e for e in collector.events if e["type"] == "search_finished")
    assert finished["attempts"] == 2
    assert finished["generated"] == 1
    assert finished["archiveNodes"] == 2  # the one program + the baseline
    assert finished["candidates"] == 2
    # Not a shortfall: both rounds were used.
    assert [
        e["message"] for e in collector.events
        if e["type"] == "log" and "planned" in e["message"]
    ] == []


def test_rollouts_are_never_skipped_as_solved():
    """As in the PUCT engine: a rollout scoring past `solved_threshold` proposes nothing.

    Measured live: the first candidate scored 1.0 and a run planned for 4 expansions made 1
    ("stopped because rounds"), every later rollout counted as solved.
    """
    import inspect

    from sciencediscovery_evolve.openevolve_engine import OpenEvolveEngine

    # Narrowed to the assignment: `_search` now reads the scorecard's
    # `solvedThreshold` as `target_reward`, the run's own stop, which is a
    # separate knob from this rollout-level skip.
    lines = [line.strip() for line in inspect.getsource(OpenEvolveEngine._search).splitlines()]
    assert [line for line in lines if '"solved_threshold"' in line] == ['"solved_threshold": 2.0,']
    target = [line for line in lines if '"target_reward"' in line]
    assert len(target) == 1 and "solvedThreshold" in target[0]
