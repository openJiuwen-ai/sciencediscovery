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

"""Unit tests for the HTTP adapter layer (``_neo4j_http``), no live Neo4j.

Uses ``httpx.MockTransport`` to fake Neo4j REST responses and assert the
session/transaction lifecycle: ``.run()`` appends to the open transaction,
``__exit__`` commits on success / rolls back on exception, ``Result`` /
``Record`` match the Bolt surface (``.single`` / ``.peek`` / ``.consume`` /
iteration / ``rec["col"]``), and ``execute_write`` runs the unit once with
the session as the tx object.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from sciencediscovery_memory_graph._neo4j_http import _HttpResult, _HttpRecord, _HttpSession


# --- _HttpResult / _HttpRecord (no HTTP needed) ---------------------------

def test_result_single_returns_first_row() -> None:
    r = _HttpResult(["a", "b"], [[1, 2], [3, 4]])
    rec = r.single()
    assert rec is not None
    assert rec["a"] == 1 and rec["b"] == 2


def test_result_single_none_when_empty() -> None:
    assert _HttpResult(["a"], []).single() is None


def test_result_peek_matches_single() -> None:
    r = _HttpResult(["a"], [[9]])
    assert r.peek() is not None and r.peek()["a"] == 9
    # peek does not consume the iterator — single still works.
    assert r.single()["a"] == 9


def test_result_consume_is_noop() -> None:
    assert _HttpResult(["a"], [[1]]).consume() is None


def test_result_iter_yields_records() -> None:
    r = _HttpResult(["k"], [["x"], ["y"]])
    rows = [rec["k"] for rec in r]
    assert rows == ["x", "y"]


def test_record_get_and_items_and_iter() -> None:
    rec = _HttpRecord(["a", "b"], [1, 2])
    assert rec.get("a") == 1
    assert rec.get("missing", 99) == 99
    assert dict(rec.items()) == {"a": 1, "b": 2}
    assert set(rec) == {"a", "b"}


def test_result_bool() -> None:
    assert _HttpResult(["a"], [[1]])
    assert not _HttpResult(["a"], [])


# --- _HttpSession lifecycle (mocked transport) ---------------------------

def _mock_neo4j(handler) -> tuple[httpx.Client, list[httpx.Request]]:
    """Build a client whose POSTs are handled by ``handler``; record requests."""
    requests: list[httpx.Request] = []

    def _transport_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return handler(request)

    transport = httpx.MockTransport(_transport_handler)
    client = httpx.Client(transport=transport, base_url="http://neo4j.test")
    return client, requests


def _tx_open_resp() -> dict[str, Any]:
    return {"commit": "/db/neo4j/tx/0/commit", "transaction": {}}


def _stmt_resp(columns: list[str], rows: list[list[Any]], errors=None) -> dict[str, Any]:
    return {
        "results": [{"columns": columns, "data": [{"row": row} for row in rows]}],
        "errors": errors or [],
    }


def test_session_commits_on_clean_exit() -> None:
    state = {"phase": "open"}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/db/neo4j/tx" and state["phase"] == "open":
            # open transaction
            state["phase"] = "open_done"
            return httpx.Response(200, json=_tx_open_resp())
        if path == "/db/neo4j/tx/0" and state["phase"] == "open_done":
            # appended statement
            return httpx.Response(200, json=_stmt_resp(["ok"], [[1]]))
        if path == "/db/neo4j/tx/0/commit":
            state["phase"] = "committed"
            return httpx.Response(200, json={"results": [], "errors": []})
        return httpx.Response(404)

    client, reqs = _mock_neo4j(handler)
    with _HttpSession(client, base_url="http://neo4j.test", auth=("u", "p")) as s:
        rec = s.run("RETURN 1 AS ok").single()
        assert rec is not None and rec["ok"] == 1
    # Last request must be the commit.
    assert reqs[-1].url.path == "/db/neo4j/tx/0/commit"
    assert state["phase"] == "committed"


def test_session_rolls_back_on_exception() -> None:
    state = {"phase": "open"}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/db/neo4j/tx" and state["phase"] == "open":
            state["phase"] = "open_done"
            return httpx.Response(200, json=_tx_open_resp())
        if path == "/db/neo4j/tx/0" and state["phase"] == "open_done":
            return httpx.Response(200, json=_stmt_resp(["c"], [[1]]))
        if path == "/db/neo4j/tx/0/rollback":
            state["phase"] = "rolled_back"
            return httpx.Response(200, json={"results": [], "errors": []})
        return httpx.Response(404)

    client, reqs = _mock_neo4j(handler)
    with pytest.raises(ValueError):
        with _HttpSession(client, base_url="http://neo4j.test", auth=("u", "p")) as s:
            s.run("MERGE (n) SET n.x = 1")
            raise ValueError("boom")
    # Must roll back, not commit.
    assert reqs[-1].url.path == "/db/neo4j/tx/0/rollback"
    assert state["phase"] == "rolled_back"


def test_session_run_raises_on_neo4j_error() -> None:
    state = {"phase": "open"}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/db/neo4j/tx" and state["phase"] == "open":
            state["phase"] = "open_done"
            return httpx.Response(200, json=_tx_open_resp())
        if path == "/db/neo4j/tx/0" and state["phase"] == "open_done":
            # statement returns a Neo4j error.
            return httpx.Response(
                200,
                json=_stmt_resp([], [], errors=[{"code": "Neo.ClientError", "message": "bad"}]),
            )
        return httpx.Response(404)

    client, _ = _mock_neo4j(handler)
    with _HttpSession(client, base_url="http://neo4j.test", auth=("u", "p")) as s:
        with pytest.raises(RuntimeError, match="Neo.ClientError"):
            s.run("RETURN bad")


def test_execute_write_runs_unit_once_with_session_as_tx() -> None:
    state = {"phase": "open"}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/db/neo4j/tx" and state["phase"] == "open":
            state["phase"] = "open_done"
            return httpx.Response(200, json=_tx_open_resp())
        if path == "/db/neo4j/tx/0" and state["phase"] == "open_done":
            return httpx.Response(200, json=_stmt_resp(["added"], [[3]]))
        return httpx.Response(404)

    client, _ = _mock_neo4j(handler)
    with _HttpSession(client, base_url="http://neo4j.test", auth=("u", "p")) as s:
        seen: list[Any] = []
        result = s.execute_write(lambda tx: seen.append(tx) or tx.run("MERGE ... RETURN 1 AS added").single())
        # The tx passed to the unit IS the session itself.
        assert seen[0] is s
        assert result["added"] == 3
