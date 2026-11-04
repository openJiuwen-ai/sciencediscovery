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

"""The 500-node cap sets ``truncated`` only when content was left out (#883).

``_NODE_LIMIT`` is a hard cap, and the contract in ``query.py`` says results
*beyond* it carry ``truncated: True``. Every reader that returns the shared
``{..., total, truncated}`` shape has to ask its Cypher for one row more than
the cap and let that extra row decide the flag: a page that came back exactly
full is not evidence of a further page.

These tests drive the real Python path through a scripted session — no Neo4j.
Each faked result honours the ``$limit`` parameter the way Cypher's ``LIMIT``
does, so a reader that does not ask for the extra row cannot observe one, and
a reader that returns everything it read has to cut the page itself.
"""

from __future__ import annotations

import pytest

from sciencediscovery_memory_graph import query

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

CAP = query._NODE_LIMIT


class _Result:
    """Iterable result shaped like the backend's; honours a Cypher ``LIMIT``."""

    def __init__(self, rows: list[dict], limit: int | None = None):
        self._rows = list(rows) if limit is None else list(rows)[:limit]

    def __iter__(self):
        return iter(self._rows)

    def single(self):
        return self._rows[0] if self._rows else None


class _Session:
    """Scripted session: the first marker contained in the Cypher picks rows.

    An unscripted Cypher raises instead of returning nothing, so a reader that
    grows a new query fails loudly here rather than silently asserting on an
    empty result.
    """

    def __init__(self, script: list[tuple[str, list[dict]]]):
        self._script = script
        self.calls: list[tuple[str, dict]] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def run(self, cypher: str, **params):
        self.calls.append((cypher, params))
        for marker, rows in self._script:
            if marker in cypher:
                return _Result(rows, params.get("limit"))
        raise AssertionError(f"unscripted Cypher: {cypher}")


class _Driver:
    def __init__(self, script: list[tuple[str, list[dict]]]):
        self._script = script
        self.sessions: list[_Session] = []

    def is_reachable(self) -> bool:
        return True

    def session(self) -> _Session:
        session = _Session(self._script)
        self.sessions.append(session)
        return session


def _papers(count: int, prefix: str = "p") -> list[dict]:
    return [
        {
            "n": {
                "link": f"https://europepmc.org/article/MED/{prefix}{i}",
                "title": f"TP53 study {i}",
                "session_id": "s1",
            },
            "label": "Paper",
        }
        for i in range(count)
    ]


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_query_match_cap_reports_beyond_cap(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    driver = _Driver([("matched >= $min_matched", _papers(count))])
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.query_match("TP53")

    assert result["truncated"] is truncated
    assert len(result["hits"]) == min(count, CAP)
    # The flag is only decidable if the reader asked for the extra row.
    assert driver.sessions[0].calls[0][1]["limit"] == CAP + 1


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_by_node_type_cap_reports_beyond_cap(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    script = [("labels(n)[0] IN $types", _papers(count))]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.by_node_type(["Paper"], session_id="s1")

    assert result["truncated"] is truncated
    assert len(result["hits"]) == min(count, CAP)
    assert driver.sessions[0].calls[0][1]["limit"] == CAP + 1


def _edge_rows(count: int) -> list[dict]:
    rows = []
    for i in range(count):
        rows.append({
            "a": {"link": f"https://europepmc.org/article/MED/a{i}"},
            "b": {"link": f"https://europepmc.org/article/MED/b{i}"},
            "a_label": "Paper",
            "b_label": "Paper",
            "edge_type": "supports",
            "edge_props": {},
        })
    return rows


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_by_edge_type_cap_reports_beyond_cap(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    script = [("type(r) IN $types", _edge_rows(count))]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.by_edge_type(["supports"], session_id="s1")

    assert result["truncated"] is truncated
    assert len(result["edges"]) == min(count, CAP)
    assert len(result["nodes"]) == 2 * len(result["edges"])
    assert driver.sessions[0].calls[0][1]["limit"] == CAP + 1


def _subgraph_nodes(count: int) -> list[dict]:
    return [
        {"label": "Paper", "node": {"link": f"https://europepmc.org/article/MED/g{i}"}}
        for i in range(count)
    ]


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_get_subgraph_cap_reports_beyond_cap(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    script = [
        ("RETURN labels(n)[0] AS label, n AS node", _subgraph_nodes(count)),
        ("type(r) AS edge_type, r AS rel", []),
        ("RETURN DISTINCT scope.task_id AS scope_id", []),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.get_subgraph("s1")

    assert result["truncated"] is truncated
    assert len(result["nodes"]) == min(count, CAP)
    assert result["total"] == len(result["nodes"])
    assert driver.sessions[0].calls[0][1]["limit"] == CAP + 1


def _children(count: int) -> list[dict]:
    return [
        {"child": {"task_id": f"child-{i}"}, "child_label": "ToolCall",
         "child_eid": f"eid-{i}"}
        for i in range(count)
    ]


def _spine_edges(count: int) -> list[dict]:
    pairs = [(0, 1), (count - 2, count - 1)]
    return [
        {
            "a": {"task_id": f"child-{a}"},
            "b": {"task_id": f"child-{b}"},
            "a_label": "ToolCall",
            "b_label": "ToolCall",
            "edge_type": "next",
            "edge_props": {},
        }
        for a, b in pairs
    ]


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_get_scope_expansion_cuts_the_page_and_drops_dangling_edges(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    # This reader has no Cypher LIMIT (the node set is assembled from children,
    # the produces subtree and the edge endpoints), so the cap has to be applied
    # in Python — and an edge whose endpoint was cut must not be rendered.
    script = [
        ("MATCH (scope:Task {task_id: $tid, session_id: $sid})",
         [{"scope_eid": "eid-scope"}]),
        ("MATCH (child:ToolCall {parent_subtask_id: $tid, session_id: $sid})",
         _children(count)),
        ("-[:produces*1..3]->", [{"prod_eids": []}]),
        ("type(r) IN ['produces', 'contains', 'next']", _spine_edges(count)),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.get_scope_expansion("scope-1", "s1")

    assert result["truncated"] is truncated
    assert len(result["nodes"]) == min(count, CAP)
    ids = {n["id"] for n in result["nodes"]}
    assert all(e["source"] in ids and e["target"] in ids for e in result["edges"])
    # The spine edge into row CAP references a node that was cut.
    assert len(result["edges"]) == (1 if count > CAP else 2)


def _members(count: int) -> list[dict]:
    return [
        {"product": {"link": f"https://europepmc.org/article/MED/m{i}"},
         "product_label": "Paper", "via_child": f"child-{i}"}
        for i in range(count)
    ]


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_get_group_expansion_cuts_the_page(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    script = [
        ("RETURN scope.task_id AS scope_id", [{"scope_id": "scope-1"}]),
        ("RETURN DISTINCT p AS product", _members(count)),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.get_group_expansion("_group:scope-1:Paper", "s1")

    assert result["truncated"] is truncated
    assert len(result["nodes"]) == min(count, CAP)
    ids = {n["id"] for n in result["nodes"]}
    assert len(result["edges"]) == len(result["nodes"])
    assert all(e["source"] == "scope-1" and e["target"] in ids
               for e in result["edges"])


@pytest.mark.parametrize(
    ("count", "truncated"),
    [(500, False), (501, True)],
    ids=["exactly-at-cap-is-complete", "beyond-cap-is-truncated"],
)
def test_serialize_subgraph_cap_reports_beyond_cap(
    monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    assert query._NODE_LIMIT == 500  # the table above is literal on purpose
    script = [
        ("elementId(n) IN $eids", _papers(count)),
        ("elementId(a) IN $eids AND elementId(b) IN $eids", []),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    session = driver.session()
    result = query._serialize_subgraph(
        session, [f"eid-{i}" for i in range(count)], "s1",
    )

    assert result["truncated"] is truncated
    assert len(result["nodes"]) == min(count, CAP)
    assert session.calls[0][1]["limit"] == CAP + 1
