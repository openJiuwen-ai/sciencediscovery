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

"""The stub engine's event sequence is a fixture, so it is pinned here.

Everything downstream (run lifecycle, SSE bridge, graph mirror, dashboard,
search canvas) is built and tested against this sequence before a real engine
exists, so a change to it is a change to every one of those tests. If a change
is intended, update the expected shape here in the same commit.
"""

from __future__ import annotations

import json

from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.events import EventStream
from sciencediscovery_evolve.stub_engine import StubEngine


def collect(expansions: int = 6, **overrides) -> list[dict]:
    spec = RunSpec(
        search_id=overrides.pop("search_id", "run-1"),
        algorithm=overrides.pop("algorithm", "era"),
        expansions=expansions,
        scorecard_hash=overrides.pop("scorecard_hash", "sha256:card"),
        **overrides,
    )
    events: list[dict] = []
    StubEngine().run(spec, events.append, lambda: False)
    return events


def test_the_sequence_is_the_documented_shape() -> None:
    events = collect(6)
    kinds = [event["type"] for event in events]

    assert kinds[0] == "search_started"
    assert kinds[1] == "seeded"
    assert kinds[-1] == "search_finished"
    # Per expansion: selected, expanded, [evaluated], merged, cost. A failed
    # candidate emits no `evaluated` — there is nothing to score — so the count
    # is not a flat multiple, and asserting one would hide that.
    assert kinds.count("expanded") == 6
    assert kinds.count("merged") == 6, "a failed candidate is still merged (as a refusal)"
    assert kinds.count("evaluated") == 5, "the failed candidate is not evaluated"
    assert len(events) == 3 + (5 * 5) + 4


def test_it_is_deterministic() -> None:
    assert collect(6) == collect(6)


def test_a_failed_candidate_carries_null_and_still_enters_the_tree() -> None:
    events = collect(6)
    expanded = [event for event in events if event["type"] == "expanded"]
    failed = [event for event in expanded if not event["valid"]]

    assert len(failed) == 1, "the fixture must exercise the failure path"
    assert failed[0]["score"] is None, "-inf must never reach the wire"
    assert failed[0]["error"]
    # The node is in the tree: its index is allocated in sequence with the rest.
    assert [event["nodeIndex"] for event in expanded] == [1, 2, 3, 4, 5, 6]


def test_the_whole_stream_is_strict_json() -> None:
    """`json.dumps` writes -inf as the bare token `-Infinity`, which is not
    valid JSON. `allow_nan=False` turns that into a crash here rather than a
    parse error three processes downstream."""
    for event in collect(8):
        json.dumps(event, allow_nan=False)


def test_both_refusal_kinds_appear() -> None:
    merged = [event for event in collect(6) if event["type"] == "merged"]
    categories = {event.get("category") for event in merged if not event["accepted"]}

    assert "constraint-violated" in categories, "a constraint refusal must be exercised"
    assert "below-threshold" in categories, "a gate refusal must be exercised"
    constrained = [event for event in merged if event.get("category") == "constraint-violated"]
    assert constrained[0]["rejectedBy"] == "too-slow"


def test_visits_are_absolute_and_backpropagate_to_the_root() -> None:
    selected = [event for event in collect(6) if event["type"] == "selected"]

    root_counts = []
    for event in selected:
        entries = event["ancestorVisits"]
        assert entries[-1]["nodeIndex"] == 0, "the chain must reach the root"
        root_counts.append(entries[-1]["visits"])

    # Absolute, monotonic, one per expansion — not deltas.
    assert root_counts == [1, 2, 3, 4, 5, 6]


def test_the_first_expansion_can_only_attach_to_the_root() -> None:
    first = next(event for event in collect(4) if event["type"] == "expanded")
    assert first["parentIndex"] == 0


def test_stopping_ends_the_run_with_a_terminal_event() -> None:
    spec = RunSpec(search_id="run-stop", algorithm="era", expansions=6, scorecard_hash="sha256:card")
    events: list[dict] = []
    calls = {"n": 0}

    def should_stop() -> bool:
        calls["n"] += 1
        return calls["n"] > 2  # let two expansions through

    StubEngine().run(spec, events.append, should_stop)
    finished = events[-1]

    assert finished["type"] == "search_finished"
    assert finished["status"] == "stopped"
    assert len([event for event in events if event["type"] == "expanded"]) == 2


def test_the_baseline_seeds_the_root_score() -> None:
    events = collect(2, baseline_score=0.731)
    assert events[1] == {"baselineScore": 0.731, "nodeIndex": 0, "type": "seeded"}


def test_sequence_numbers_continue_a_resumed_search() -> None:
    stream = EventStream(start_at=12)
    assert stream.record({"type": "log"})["sequence"] == 13
    assert stream.record({"type": "log"})["sequence"] == 14
