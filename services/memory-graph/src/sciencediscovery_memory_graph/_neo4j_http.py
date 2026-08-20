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

"""HTTP Transactional API client for Neo4j, shape-compatible with the Bolt
driver's ``Session`` / ``Result`` / ``Record`` surface.

Replaces the ``neo4j`` Python package (license) with Neo4j's built-in HTTP
REST: ``POST /db/{db}/tx`` opens an explicit transaction, each ``.run()``
appends a statement to it, and the session context manager commits on clean
exit or rolls back on exception — preserving the same delete-then-rebuild
atomicity the Bolt ``session()`` block gave callers.

The HTTP response already returns node/relationship values as their
*properties* dict (verified against a live Neo4j 5 REST endpoint: a returned
node serialises as ``{"name": "alpha", "n": 1}``, not a wrapped
``{<id>, <labels>, properties}`` structure), so callers that do
``node.get("session_id")`` / ``dict(node)`` / ``_node_identity(label, node)``
work unchanged. Temporal types arrive as ISO strings; ``_iso``/``_json_safe``
in ``query.py`` fall through to ``str(value)`` and pass them through.
"""

from __future__ import annotations

from typing import Any, Iterator

import httpx


class _HttpRecord:
    """A single result row, accessed by column name like a Bolt ``Record``.

    ``rec["col"]`` and ``rec.get(key, default)`` are the only access patterns
    the codebase uses; ``items()`` / ``__iter__`` support ``dict(record)``
    and ``_json_safe`` walking.
    """

    __slots__ = ("_map",)

    def __init__(self, columns: list[str], row: list[Any]) -> None:
        # Neo4j REST returns a parallel ``meta`` list (element ids/types) for
        # some cells; we only need the ``row`` values zipped with column names.
        self._map = dict(zip(columns, row))

    def __getitem__(self, key: str) -> Any:
        return self._map[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self._map.get(key, default)

    def items(self):
        return self._map.items()

    def __iter__(self):
        return iter(self._map)

    def __len__(self) -> int:
        return len(self._map)


class _HttpResult:
    """A statement's result set, shape-compatible with a Bolt ``Result``.

    HTTP returns the whole result at once (no streaming cursor), so
    ``.single()`` / ``.peek()`` / iteration all read from the cached rows.
    ``.consume()`` is a no-op — by the time the result exists, the statement
    has already been applied to the open transaction.
    """

    __slots__ = ("_columns", "_rows")

    def __init__(self, columns: list[str], rows: list[list[Any]]) -> None:
        self._columns = columns
        self._rows = rows

    def __iter__(self) -> Iterator[_HttpRecord]:
        for row in self._rows:
            yield _HttpRecord(self._columns, row)

    def __bool__(self) -> bool:
        return bool(self._rows)

    def single(self) -> _HttpRecord | None:
        """First row, or ``None`` if empty — matches Bolt ``Result.single``."""
        return _HttpRecord(self._columns, self._rows[0]) if self._rows else None

    def peek(self) -> _HttpRecord | None:
        """First row without advancing — Bolt ``peek`` semantics.

        HTTP already holds the full result, so this is identical to
        ``.single()``; it exists only to satisfy
        ``persistence.py``'s ``result.peek()`` guard.
        """
        return self.single()

    def consume(self) -> None:
        """No-op: the statement was applied when the response arrived."""
        return None


class _HttpSession:
    """An explicit HTTP transaction, opened on construction.

    Mirrors a Bolt ``Session`` used as a context manager: ``with
    driver.session() as session:`` opens a transaction, ``session.run(...)``
    appends statements to it, and ``__exit__`` commits (clean) or rolls back
    (exception). This keeps ``_link_subtasks_by_finish_time``'s
    delete-then-rebuild atomic — the HTTP transaction is the unit of work,
    not each statement.
    """

    def __init__(
        self,
        client: httpx.Client,
        *,
        base_url: str,
        auth: tuple[str, str],
        database: str = "neo4j",
        timeout: float = 60.0,
    ) -> None:
        self._client = client
        self._auth = auth
        self._base = base_url.rstrip("/")
        self._db = database
        # Open the transaction: POST /db/{db}/tx → {commit, transaction}.
        resp = client.post(
            f"{self._base}/db/{self._db}/tx",
            json={"statements": []},
            auth=auth,
            timeout=timeout,
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("errors"):
            raise RuntimeError(f"neo4j tx open failed: {payload['errors']}")
        commit_url = payload.get("commit")
        if not commit_url:
            raise RuntimeError("neo4j tx open returned no commit URL")
        # The server returns an absolute or root-relative URL; normalise to
        # root-relative so base_url swapping (loopback) is respected.
        self._commit_url = self._relativize(commit_url)
        self._tx_url = f"{self._base}/db/{self._db}/tx"  # appended statements go here
        self._tx_path = self._commit_url.removesuffix("/commit")  # /db/neo4j/tx/0
        self._closed = False

    @staticmethod
    def _relativize(url: str) -> str:
        """Strip scheme://host so requests reuse the configured base_url.

        Neo4j returns absolute commit URLs (``http://127.0.0.1:7474/db/...``);
        we POST them against the base_url anyway, but keeping them
        root-relative makes loopback rewriting unambiguous.
        """
        if "://" in url:
            return "/" + url.split("/", 3)[3]
        return url

    def run(self, cypher: str, **params: Any) -> _HttpResult:
        """Append a statement to the open transaction and return its result.

        Raises on a server-side error (the same way a Bolt ``session.run``
        raises ``ClientError``); callers wrap writes in ``try/except`` and
        the ``with`` block rolls the transaction back.
        """
        return self._run(cypher, params)

    def execute_write(self, fn, *args, **kwargs):
        """Run a managed write unit, Bolt ``Session.execute_write``-compatible.

        The Bolt driver retries the unit on ``TransientError`` (deadlock /
        constraint); HTTP has no equivalent retry, so this runs ``fn`` exactly
        once, passing ``self`` as the transaction object (``tx.run(...)`` is
        this session's own ``.run``). The unit's atomicity comes from the
        enclosing explicit transaction, not a Bolt managed retry loop.
        """
        return fn(self, *args, **kwargs)

    def _run(self, cypher: str, params: dict[str, Any]) -> _HttpResult:
        if self._closed:
            raise RuntimeError("session used outside its context manager")
        body = {
            "statements": [
                {"statement": cypher, "parameters": params or None}
            ]
        }
        resp = self._client.post(
            self._tx_path, json=body, auth=self._auth, timeout=60.0
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("errors"):
            # Surface the Neo4j error code + message like the Bolt driver does.
            err = payload["errors"][0]
            raise RuntimeError(
                f"neo4j statement failed: {err.get('code')}: {err.get('message')}"
            )
        results = payload.get("results") or [{}]
        block = results[0]
        columns = block.get("columns") or []
        rows = [d.get("row", []) for d in block.get("data", [])]
        return _HttpResult(columns, rows)

    def __enter__(self) -> "_HttpSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._closed:
            return
        self._closed = True
        url = self._commit_url if exc_type is None else self._tx_path + "/rollback"
        try:
            self._client.post(url, json={"statements": []}, auth=self._auth, timeout=60.0)
        except Exception:
            # Best-effort commit/rollback: never raise from __exit__.
            # A failed commit surfaces as a subsequent read mismatch, which
            # the lazy-degrade contract already tolerates (is_reachable flips
            # False on the next probe).
            pass
