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

import hashlib
import os
import threading
import time
from pathlib import Path
from typing import Any

from ._cypher import CypherBudgetExceeded, QueryStats, execute
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
        started = time.monotonic()
        query_id = hashlib.sha256(cypher.encode()).hexdigest()[:12]
        reason = "ok"
        stats = QueryStats()
        try:
            columns, rows = execute(self._g, cypher, params, stats)
        except BaseException as exc:
            reason = type(exc).__name__
            self._g.undo_to(mark)
            raise
        finally:
            elapsed = time.monotonic() - started
            if elapsed >= 0.25 or reason != "ok":
                log.info("local query id=%s duration_ms=%d nodes=%d edges=%d work=%d traversals=%d intermediate_peak=%d reason=%s",
                         query_id, int(elapsed * 1000), len(self._g.nodes),
                         len(self._g.rels), stats.work, stats.traversals,
                         stats.intermediate_peak, reason)
        return _HttpResult(columns, rows)

    def folded_products(self, session_id: str, scope_id: str | None = None,
                        kind: str | None = None) -> list[dict[str, Any]]:
        """Reach scope products once per child, without enumerating next paths.

        Called within the subgraph read transaction. The parent marker and edge
        method keep historical temporal chains and other scopes out of the walk.
        """
        graph = self._g
        started = time.monotonic()
        work = 0
        traversals = 0
        result: list[dict[str, Any]] = []
        seen_products: set[tuple[str, str, str]] = set()

        def charge() -> None:
            nonlocal work
            work += 1
            if work > 250_000 or time.monotonic() - started > 10:
                log.warning("local folded query id=folded_products duration_ms=%d nodes=%d edges=%d work=%d traversals=%d intermediate=%d reason=budget_exceeded",
                            int((time.monotonic() - started) * 1000), len(graph.nodes),
                            len(graph.rels), work, traversals, len(result))
                raise CypherBudgetExceeded("local folded query work or time budget exceeded")

        def visible(node, label: str) -> bool:
            return (label in node.labels and node.props.get("session_id") == session_id
                    and not node.props.get("deleted_session"))

        for nid in graph.pidx.get("session_id", {}).get(("s", session_id), {}):
            charge()
            scope = graph.nodes[nid]
            scope_tid = scope.props.get("task_id")
            if (not visible(scope, "Task") or scope.props.get("task_type") != "subagent"
                    or (scope_id is not None and scope_tid != scope_id)):
                continue
            pending: list[str] = []
            for rid in graph.out.get(nid, {}):
                charge()
                rel = graph.rels[rid]
                if rel.type == "contains":
                    pending.append(rel.dst)
            visited: set[str] = set()
            while pending:
                charge()
                traversals += 1
                child_id = pending.pop()
                if child_id in visited:
                    continue
                visited.add(child_id)
                child = graph.nodes[child_id]
                if (not visible(child, "ToolCall")
                        or child.props.get("parent_subtask_id") != scope_tid):
                    continue
                for rid in graph.out.get(child_id, {}):
                    charge()
                    rel = graph.rels[rid]
                    if rel.type == "next" and rel.props.get("method") == "scope_chain":
                        pending.append(rel.dst)
                    if rel.type != "produces":
                        continue
                    target = graph.nodes[rel.dst]
                    products = []
                    if visible(target, "Paper"):
                        products.append((target, "Paper"))
                    elif visible(target, "Code"):
                        for code_rid in graph.out.get(target.id, {}):
                            charge()
                            code_rel = graph.rels[code_rid]
                            artifact = graph.nodes[code_rel.dst]
                            if code_rel.type == "produces" and visible(artifact, "Artifact"):
                                products.append((artifact, "Artifact"))
                    for product, product_kind in products:
                        if kind is not None and kind != product_kind:
                            continue
                        key = (nid, child_id, product.id)
                        if key in seen_products:
                            continue
                        seen_products.add(key)
                        result.append({"scope_id": scope_tid, "product": dict(product.props),
                                       "kind": product_kind, "product_label": product_kind,
                                       "via_child": child.props.get("task_id")})
        log.info("local folded query id=folded_products duration_ms=%d nodes=%d edges=%d work=%d traversals=%d intermediate=%d reason=ok",
                 int((time.monotonic() - started) * 1000), len(graph.nodes),
                 len(graph.rels), work, traversals, len(result))
        return result

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
