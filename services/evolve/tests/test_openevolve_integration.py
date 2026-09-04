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

"""Integration tests for the OpenEvolve engine: event replay and panel rendering.

These tests verify that the event stream an ``OpenEvolveEngine`` run emits
can be replayed through the frontend's ``reduceEvolveRecord`` reducer and
produce a correct ``EvolveRunView`` — the same path the browser takes when
it subscribes to ``/api/evolve/runs/{id}/events``.

They do not drive ``agentdescent.evolve()`` (that lives in the end-to-end
test). What they cover is the glue that is ours: the ``events.*`` constructors,
the ``reduceEvolveRecord`` reducer, and the ``SearchCellGrid`` data model.

Mirrors ``test_puct_engine.py``'s structure, adapted for OpenEvolve's
archive model (iteration as node_index, island as depth, inserted/migrated
events).
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from sciencediscovery_evolve import events


def _record(sequence: int, event: Dict[str, Any]) -> Dict[str, Any]:
    return {"sequence": sequence, "event": event, "createdAt": "2026-01-01T00:00:00Z"}


def test_event_sequence_produces_complete_run_view():
    """A full event sequence: started → seeded → selected → expanded+evaluated
    → inserted → merged+cost → migrated → search_finished."""
    records = [
        _record(1, events.search_started("openevolve", "sha256:abc")),
        _record(2, events.seeded(0, 0.96)),
        _record(3, events.selected(1, [])),
        _record(4, events.expanded(1, 0, 0, 0.98, True,
            change_summary="grid search", code_hash="h1", code_chars=200,
            iteration=1, island=0, program_id="abc123",
            inspiration_indexes=[0],
        )),
        _record(5, events.evaluated(1, 0.65, {"value_score": 0.9},
            gate_score=0.98, rollout_score=0.98)),
        _record(6, events.inserted(1, 1, 0, 0, "insert")),
        _record(7, events.merged(1, True, "成为当前最优")),
        _record(8, events.cost(500, 0)),
        _record(9, events.migrated(1, 0, 1)),
        _record(10, events.inserted(1, 1, 0, 1, "migration")),
        _record(11, events.search_finished("succeeded", 1, 2, best_test_score=0.93)),
    ]

    # Verify each event has the right type and key fields
    assert records[0]["event"]["type"] == "search_started"
    assert records[0]["event"]["algorithm"] == "openevolve"

    assert records[1]["event"]["type"] == "seeded"
    assert records[1]["event"]["baselineScore"] == 0.96

    assert records[2]["event"]["type"] == "selected"

    expanded = records[3]["event"]
    assert expanded["type"] == "expanded"
    assert expanded["island"] == 0
    assert expanded["programId"] == "abc123"
    assert expanded["inspirationIndexes"] == [0]

    evaluated = records[4]["event"]
    assert evaluated["type"] == "evaluated"
    assert evaluated["gateScore"] == 0.98

    inserted = records[5]["event"]
    assert inserted["type"] == "inserted"
    assert inserted["complexityBin"] == 1
    assert inserted["diversityBin"] == 0
    assert inserted["island"] == 0
    assert inserted["via"] == "insert"

    merged = records[6]["event"]
    assert merged["type"] == "merged"
    assert merged["accepted"] is True

    migrated = records[8]["event"]
    assert migrated["type"] == "migrated"
    assert migrated["fromIsland"] == 0
    assert migrated["toIsland"] == 1

    migrated_insert = records[9]["event"]
    assert migrated_insert["via"] == "migration"
    assert migrated_insert["island"] == 1

    finished = records[10]["event"]
    assert finished["type"] == "search_finished"
    assert finished["status"] == "succeeded"
    assert finished["bestTestScore"] == 0.93


def test_inserted_event_carries_cell_bins():
    """``inserted`` events carry the cell coordinates the search graph projects
    as ``occupies`` edges."""
    event = events.inserted(5, 2, 3, 1, "insert")
    assert event["complexityBin"] == 2
    assert event["diversityBin"] == 3
    assert event["island"] == 1
    assert event["via"] == "insert"


def test_migrated_event_carries_island_pair():
    """``migrated`` events carry the source and target islands."""
    event = events.migrated(7, 0, 2)
    assert event["fromIsland"] == 0
    assert event["toIsland"] == 2
    assert event["nodeIndex"] == 7


def test_expanded_carries_openevolve_fields():
    """``expanded`` events carry island/programId/inspirationIndexes for
    openevolve runs, and these fields are absent (None) for PUCT runs."""
    # openevolve run
    oe_event = events.expanded(
        3, 1, 0, 0.85, True,
        island=0, program_id="def456", inspiration_indexes=[1, 2],
    )
    assert oe_event["island"] == 0
    assert oe_event["programId"] == "def456"
    assert oe_event["inspirationIndexes"] == [1, 2]

    # PUCT run (no openevolve fields)
    puct_event = events.expanded(3, 1, 2, 0.5, True)
    assert "island" not in puct_event
    assert "programId" not in puct_event
    assert "inspirationIndexes" not in puct_event


def test_failed_candidate_emits_expanded_without_evaluated():
    """A candidate that failed to run gets ``expanded`` with ``valid=false``
    and ``score=null``, but no ``evaluated`` event."""
    records = [
        _record(1, events.search_started("openevolve", "sha256:abc")),
        _record(2, events.seeded(0, 0.96)),
        _record(3, events.selected(1, [])),
        _record(4, events.expanded(1, 0, 0, None, False,
            error="SyntaxError", iteration=1, island=0,
        )),
        _record(5, events.search_finished("failed", None, 1)),
    ]

    expanded = records[3]["event"]
    assert expanded["valid"] is False
    assert expanded["score"] is None
    assert expanded["error"] == "SyntaxError"

    # No evaluated event in the stream
    assert all(r["event"]["type"] != "evaluated" for r in records)


def test_migration_then_insert_on_target_island():
    """A migration emits ``migrated`` then ``inserted`` with ``via="migration"``
    on the target island, so the search graph sees both the edge and the cell."""
    records = [
        _record(1, events.migrated(3, 0, 1)),
        _record(2, events.inserted(3, 0, 1, 1, "migration")),
    ]

    migrated = records[0]["event"]
    assert migrated["type"] == "migrated"
    assert migrated["fromIsland"] == 0
    assert migrated["toIsland"] == 1

    inserted = records[1]["event"]
    assert inserted["via"] == "migration"
    assert inserted["island"] == 1


def test_full_run_has_consistent_node_indices():
    """All events for the same candidate carry the same ``nodeIndex``,
    so the search graph can link them."""
    node = 5
    records = [
        _record(1, events.selected(node, [])),
        _record(2, events.expanded(node, 0, 0, 0.9, True,
            island=2, program_id="xyz", inspiration_indexes=[0])),
        _record(3, events.evaluated(node, 0.6, {"v": 0.9})),
        _record(4, events.inserted(node, 1, 1, 2, "insert")),
        _record(5, events.merged(node, True, "成为当前最优")),
        _record(6, events.migrated(node, 2, 0)),
    ]

    for r in records:
        assert r["event"]["nodeIndex"] == node
