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

"""Storage-backend seam for the memory graph.

Every reader / writer goes through :func:`handle` and only uses the
:class:`GraphBackend` surface: ``is_reachable()`` and ``session()`` (a context
manager whose ``run(cypher, **params)`` returns Bolt-shaped results).

Two backends implement it:

* ``local`` — :class:`~.local_backend.LocalHandle`, the graph persisted as JSONL
  text files under the data directory. Needs no credentials and no server.
* ``neo4j`` — :class:`~.neo4j_driver.Neo4jHandle`, the external Neo4j 5 server.

Selection: the backend is a setting (System configuration → Memory). It
defaults to ``local`` so ScienceMemory works with zero setup; the control API
pushes the chosen backend to ``POST /internal/backend`` at startup and whenever
it changes, and the Neo4j connection (address / user / password) is only used
when ``neo4j`` is selected. ``SCIENCE_AGENT_MEMORY_GRAPH_BACKEND`` (``local`` |
``neo4j``) sets the initial value before the first push. A selected but
unreachable Neo4j degrades instead of silently switching stores, so the two
histories never diverge.
"""

from __future__ import annotations

import os
from typing import Any, Protocol

from .local_backend import LocalHandle
from .neo4j_driver import Neo4jHandle, handle as neo4j_handle

BACKEND_ENV = "SCIENCE_AGENT_MEMORY_GRAPH_BACKEND"


class GraphBackend(Protocol):
    kind: str

    @property
    def has_password(self) -> bool: ...

    def is_reachable(self) -> bool: ...

    def session(self) -> Any: ...


class BackendRouter:
    """Process-wide handle that forwards to the active backend."""

    def __init__(self, local: LocalHandle | None = None, neo4j: Neo4jHandle | None = None) -> None:
        self._local = local or LocalHandle()
        self._neo4j = neo4j
        env = os.environ.get(BACKEND_ENV, "local").strip().lower()
        self._mode = "neo4j" if env == "neo4j" else "local"

    def set_backend(self, mode: str) -> None:
        if mode not in ("local", "neo4j"):
            raise ValueError(f"unknown memory graph backend: {mode}")
        self._mode = mode

    @property
    def neo4j(self) -> Neo4jHandle:
        return self._neo4j or neo4j_handle()

    def active(self) -> GraphBackend:
        return self.neo4j if self._mode == "neo4j" else self._local

    @property
    def kind(self) -> str:
        return self.active().kind

    @property
    def has_password(self) -> bool:
        return self.active().has_password

    def is_reachable(self) -> bool:
        return self.active().is_reachable()

    def session(self) -> Any:
        return self.active().session()

    def set_password(self, password: str | None) -> None:
        self.neo4j.set_password(password)

    def configure(self, http_uri: str | None, user: str | None) -> None:
        self.neo4j.configure(http_uri, user)


_router: BackendRouter | None = None


def handle() -> BackendRouter:
    """Process-wide singleton accessor."""
    global _router
    if _router is None:
        _router = BackendRouter()
    return _router
