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

"""One rule for ``truncated``: the rows the backend returned, before rendering.

The cap has a single meaning across the seven readers (#883): ``truncated`` is
true when the backend returned more rows than ``_NODE_LIMIT``, and it is
decided on the rows that were read — *before* a row is dropped for having no
identity (``_node_identity``/``_to_hit`` return ``None`` for a label with no id
field). Each Cypher read binds ``LIMIT`` to ``_NODE_LIMIT + 1``, so that one
extra row is the whole probe; spending it on a row that cannot be rendered
would hide whether a renderable row follows it, and the response would claim
completeness it never checked. The flag may therefore be true while the page
carries fewer than ``_NODE_LIMIT`` renderable items — the rows exist, they just
are not renderable — and a page that is merely short of renderable items stays
complete.

``tests/test_node_limit.py`` covers the cap arithmetic; these cases pin the one
rule on the readers where the two candidate conventions disagree.
"""

from __future__ import annotations

import pytest

from sciencediscovery_memory_graph import query

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

CAP = query._NODE_LIMIT

# A label no write path owns, so ``_node_identity`` has no id field for it and
# every reader drops the row. It still occupies a row the backend returned.
UNRENDERABLE = "NoIdentityField"


class _Result:
    """Iterable result shaped like the backend's; honours a Cypher ``LIMIT``."""

    def __init__(self, rows: list[dict], limit: int | None = None):
        self._rows = list(rows) if limit is None else list(rows)[:limit]

    def __iter__(self):
        return iter(self._rows)

    def single(self):
        return self._rows[0] if self._rows else None


class _Session:
    """Scripted session: the first marker contained in the Cypher picks rows."""

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


def _paper_rows(count: int) -> list[dict]:
    return [
        {
            "n": {
                "link": f"https://europepmc.org/article/MED/r{i}",
                "title": f"TP53 study {i}",
                "session_id": "s1",
            },
            "label": "Paper",
        }
        for i in range(count)
    ]


def _unrenderable_row() -> dict:
    return {"n": {"title": "written by a label no reader can key"}, "label": UNRENDERABLE}


def _edge_rows(count: int) -> list[dict]:
    return [
        {
            "a": {"link": f"https://europepmc.org/article/MED/a{i}"},
            "b": {"link": f"https://europepmc.org/article/MED/b{i}"},
            "a_label": "Paper",
            "b_label": "Paper",
            "edge_type": "supports",
            "edge_props": {},
        }
        for i in range(count)
    ]


def _subgraph_rows(count: int) -> list[dict]:
    return [
        {"label": "Paper", "node": {"link": f"https://europepmc.org/article/MED/g{i}"}}
        for i in range(count)
    ]


def test_query_match_counts_an_unrenderable_probe_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert query._NODE_LIMIT == 500  # the arithmetic below is literal on purpose
    rows = _paper_rows(CAP) + [_unrenderable_row()]
    driver = _Driver([("matched >= $min_matched", rows)])
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.query_match("TP53")

    # The 501st row cannot be rendered, but it is a row the backend returned.
    assert result["truncated"] is True
    assert len(result["hits"]) == CAP


def test_query_match_keeps_a_complete_page_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert query._NODE_LIMIT == 500  # the arithmetic below is literal on purpose
    rows = _paper_rows(CAP - 1) + [_unrenderable_row()]
    driver = _Driver([("matched >= $min_matched", rows)])
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.query_match("TP53")

    # A short page of renderable hits is complete: no row was left unread.
    assert result["truncated"] is False
    assert len(result["hits"]) == CAP - 1


def test_by_edge_type_counts_an_unrenderable_probe_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert query._NODE_LIMIT == 500  # the arithmetic below is literal on purpose
    rows = _edge_rows(CAP) + [
        {
            "a": {"link": "https://europepmc.org/article/MED/tail"},
            "b": {"title": "no identity field"},
            "a_label": "Paper",
            "b_label": UNRENDERABLE,
            "edge_type": "supports",
            "edge_props": {},
        }
    ]
    driver = _Driver([("type(r) IN $types", rows)])
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.by_edge_type(["supports"], session_id="s1")

    assert result["truncated"] is True
    assert len(result["edges"]) == CAP


def test_get_subgraph_counts_an_unrenderable_probe_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert query._NODE_LIMIT == 500  # the arithmetic below is literal on purpose
    rows = _subgraph_rows(CAP) + [
        {"label": UNRENDERABLE, "node": {"title": "no identity field"}}
    ]
    script = [
        ("RETURN labels(n)[0] AS label, n AS node", rows),
        ("type(r) AS edge_type, r AS rel", []),
        ("RETURN DISTINCT scope.task_id AS scope_id", []),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.get_subgraph("s1")

    assert result["truncated"] is True
    assert len(result["nodes"]) == CAP
    assert result["total"] == CAP


def test_get_subgraph_keeps_a_complete_page_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert query._NODE_LIMIT == 500  # the arithmetic below is literal on purpose
    rows = _subgraph_rows(CAP - 1) + [
        {"label": UNRENDERABLE, "node": {"title": "no identity field"}}
    ]
    script = [
        ("RETURN labels(n)[0] AS label, n AS node", rows),
        ("type(r) AS edge_type, r AS rel", []),
        ("RETURN DISTINCT scope.task_id AS scope_id", []),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    result = query.get_subgraph("s1")

    assert result["truncated"] is False
    assert len(result["nodes"]) == CAP - 1


def test_serialize_subgraph_counts_an_unrenderable_probe_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert query._NODE_LIMIT == 500  # the arithmetic below is literal on purpose
    rows = _paper_rows(CAP) + [_unrenderable_row()]
    script = [
        ("elementId(n) IN $eids", rows),
        ("elementId(a) IN $eids AND elementId(b) IN $eids", []),
    ]
    driver = _Driver(script)
    monkeypatch.setattr(query, "handle", lambda: driver)
    session = driver.session()
    result = query._serialize_subgraph(
        session, [f"eid-{i}" for i in range(len(rows))], "s1",
    )

    assert result["truncated"] is True
    assert len(result["nodes"]) == CAP
