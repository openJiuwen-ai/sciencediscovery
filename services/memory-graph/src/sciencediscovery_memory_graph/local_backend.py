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

"""Neo4j-free backend: the graph kept in memory and mirrored to JSONL files.

:class:`LocalHandle` offers the same surface as
:class:`~.neo4j_driver.Neo4jHandle` (``is_reachable`` / ``session``), and its
session mirrors the HTTP session's ``run(cypher, **params)`` →
``.consume()/.single()/peek()``/iteration contract, so every caller written for
Neo4j runs on it unchanged. One store holds every session; nodes carry their
``session_id`` exactly as they do in Neo4j.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from ._cypher import execute
from ._neo4j_http import _HttpResult
from .local_graph import Graph, Store
from .logging_config import get_logger

log = get_logger("local_backend")

DATA_DIR_ENV = "SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR"


def default_data_dir() -> Path:
    configured = os.environ.get(DATA_DIR_ENV)
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".science-agent" / "memory-graph"


class LocalSession:
    """Explicit transaction over the local graph.

    Used as ``with handle.session() as s:`` it holds the graph lock, commits on
    a clean exit and rolls everything back on error. Used bare (``.run`` without
    ``with``) each statement is its own transaction.
    """

    def __init__(self, graph: Graph) -> None:
        self._g = graph
        self._in_tx = False

    def __enter__(self) -> "LocalSession":
        self._g.lock.acquire()
        self._g.begin()
        self._in_tx = True
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._g.commit()
            else:
                self._g.rollback()
        finally:
            self._in_tx = False
            self._g.lock.release()

    def run(self, cypher: str, **params: Any) -> _HttpResult:
        if self._in_tx:
            return self._run_statement(cypher, params)
        with self._g.lock:
            self._g.begin()
            try:
                result = self._run_statement(cypher, params)
            except BaseException:
                self._g.rollback()
                raise
            self._g.commit()
            return result

    def _run_statement(self, cypher: str, params: dict[str, Any]) -> _HttpResult:
        # A failing statement leaves no partial writes behind, as on Neo4j.
        mark = self._g.mark()
        try:
            columns, rows = execute(self._g, cypher, params)
        except BaseException:
            self._g.undo_to(mark)
            raise
        return _HttpResult(columns, rows)

    def execute_write(self, fn, *args, **kwargs):
        return fn(self, *args, **kwargs)


class LocalHandle:
    """Always-available handle over the JSONL-backed graph."""

    kind = "local"

    def __init__(self, directory: Path | None = None) -> None:
        self._directory = directory
        self._graph: Graph | None = None
        self._lock = threading.Lock()

    @property
    def directory(self) -> Path:
        return self._directory or default_data_dir()

    @property
    def graph(self) -> Graph:
        with self._lock:
            if self._graph is None:
                self._graph = Graph(Store(self.directory))
                log.info("local memory graph store: %s", self.directory)
            return self._graph

    # Neo4jHandle-compatible surface -----------------------------------------

    @property
    def has_password(self) -> bool:
        return True

    def set_password(self, password: str | None) -> None:
        return None

    def configure(self, http_uri: str | None, user: str | None) -> None:
        return None

    def is_reachable(self) -> bool:
        try:
            self.graph
        except OSError as exc:
            log.warning("local memory graph store unavailable: %s", exc)
            return False
        return True

    def session(self) -> LocalSession:
        return LocalSession(self.graph)
