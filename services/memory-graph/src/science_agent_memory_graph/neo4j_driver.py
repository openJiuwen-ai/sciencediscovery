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

"""Singleton Neo4j HTTP client with lazy password injection and health probing.

The Neo4j password is configured by the user (pushed by the Node control API
from System Settings → Memory graph) and posted into this process over a
loopback Bearer-protected endpoint (``POST /internal/neo4j-password``) at
startup and whenever it changes. Until a password is supplied the client is
uninitialised and ``is_reachable`` reports ``False`` (lazy-degrade: a
missing/unreachable Neo4j never blocks the API).

Access is via Neo4j's HTTP Transactional API (``POST /db/neo4j/tx``), not the
Bolt driver — the ``neo4j`` Python package was dropped for licence reasons.
``session()`` returns an :class:`~._neo4j_http._HttpSession` whose surface
(``.run(cypher, **params).consume()/.single()/peek()`` + iteration +
``rec["col"]``) mirrors the Bolt ``Session``/``Result``/``Record`` so callers
in ``persistence``/``query``/``constraints``/``server`` are unchanged.

The sidecar is launched unconditionally by ``start-stack.sh``; the on/off
toggle now lives in the Node control API (System Settings → Memory graph,
persisted in the store), which short-circuits sink writes and reads before
they ever reach this process. The legacy ``SCIENCE_AGENT_MEMORY_GRAPH_ENABLED``
env switch is therefore obsolete and no longer read.
"""

from __future__ import annotations

import os
import threading
from typing import Any

import httpx

from ._neo4j_http import _HttpSession


class Neo4jHandle:
    """Holds the current HTTP client + the password it was built with."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._client: httpx.Client | None = None
        self._password: str | None = None
        self._http_uri: str = os.environ.get(
            "SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_HTTP",
            "http://127.0.0.1:7474",
        )
        self._user: str = os.environ.get(
            "SCIENCE_AGENT_MEMORY_GRAPH_NEO4J_USER",
            "neo4j",
        )

    @property
    def has_password(self) -> bool:
        return self._password is not None

    def set_password(self, password: str | None) -> None:
        """Replace the client with one built from ``password``.

        ``None`` clears the client (user removed the credential, or the service
        must degrade). Closing the previous client is best-effort.
        """
        with self._lock:
            if self._client is not None:
                try:
                    self._client.close()
                except Exception:
                    pass
                self._client = None
            self._password = password
            if password is not None:
                try:
                    self._client = httpx.Client(
                        base_url=self._http_uri,
                        auth=(self._user, password),
                        timeout=60.0,
                    )
                except Exception:
                    # Bad creds / unreachable host: stay uninitialised; the
                    # caller will see is_reachable() == False and degrade.
                    self._client = None

    def configure(self, http_uri: str | None, user: str | None) -> None:
        """Replace the HTTP URI / user, rebuilding the client from the stored
        password if one is set. Either argument may be ``None`` to keep the
        current value. Called when the Node API pushes updated connection
        settings from System Settings → Memory graph.
        """
        with self._lock:
            if http_uri is not None and http_uri != self._http_uri:
                self._http_uri = http_uri
            if user is not None and user != self._user:
                self._user = user
            # Rebuild the client from the (possibly new) uri/user + stored pw.
            if self._password is not None:
                if self._client is not None:
                    try:
                        self._client.close()
                    except Exception:
                        pass
                    self._client = None
                try:
                    self._client = httpx.Client(
                        base_url=self._http_uri,
                        auth=(self._user, self._password),
                        timeout=60.0,
                    )
                except Exception:
                    self._client = None

    def is_reachable(self) -> bool:
        if self._client is None:
            return False
        try:
            resp = self._client.post(
                "/db/neo4j/tx/commit",
                json={"statements": [{"statement": "RETURN 1 AS ok"}]},
            )
            resp.raise_for_status()
            data = resp.json()
            if data.get("errors"):
                return False
            results = data.get("results") or [{}]
            rows = (results[0].get("data") or [{}])
            return bool(rows and rows[0].get("row", [None])[0] == 1)
        except Exception:
            return False

    def session(self) -> Any:
        """Return an explicit-transaction HTTP session, or raise if none.

        Callers must check ``is_reachable()`` first; this is the escape hatch
        used only once the caller has decided to proceed with a write. The
        returned session is a context manager: ``with driver.session() as s:``
        opens the transaction and commits on clean exit / rolls back on error.
        """
        if self._client is None:
            raise RuntimeError("neo4j driver not initialised (no password or disabled)")
        return _HttpSession(
            self._client,
            base_url=self._http_uri,
            auth=(self._user, self._password or ""),
        )


_handle: Neo4jHandle | None = None


def handle() -> Neo4jHandle:
    """Process-wide singleton accessor."""
    global _handle
    if _handle is None:
        _handle = Neo4jHandle()
    return _handle
