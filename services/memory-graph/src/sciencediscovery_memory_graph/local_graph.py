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

"""In-memory property graph persisted as plain JSONL files.

This is the storage half of the Neo4j-free backend. The whole graph lives in
memory for the lifetime of the sidecar; every committed transaction appends the
new state of each node / relationship it touched to two human-readable files:

* ``nodes.jsonl`` — ``{"id","labels","props"}`` or ``{"id","deleted":true}``
* ``edges.jsonl`` — ``{"id","type","src","dst","props"}`` or ``{"id","deleted":true}``

Replay is last-write-wins on ``id``, so a torn final line (crash mid-append) is
skipped and everything before it survives. The files are compacted on load once
dead lines outnumber live ones.

Mutators journal an inverse operation so a failed statement (or a rolled back
transaction) restores the previous in-memory state exactly.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Callable, Hashable

from .logging_config import get_logger

log = get_logger("local_graph")


class Node:
    __slots__ = ("id", "labels", "props")

    def __init__(self, nid: str, labels: list[str], props: dict[str, Any]) -> None:
        self.id = nid
        self.labels = labels
        self.props = props


class Rel:
    __slots__ = ("id", "type", "src", "dst", "props")

    def __init__(self, rid: str, rtype: str, src: str, dst: str, props: dict[str, Any]) -> None:
        self.id = rid
        self.type = rtype
        self.src = src
        self.dst = dst
        self.props = props


def normalise_prop(value: Any) -> Any:
    """Coerce a value to something Neo4j would accept as a property."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [normalise_prop(v) for v in value]
    raise TypeError("Property values can only be of primitive types or arrays thereof")


def index_key(value: Any) -> Hashable | None:
    """Equality-index key, or ``None`` for values that are not indexed."""
    if isinstance(value, bool):
        return ("b", value)
    if isinstance(value, (int, float)):
        return ("n", value)
    if isinstance(value, str):
        return ("s", value)
    return None


class Store:
    """Append-only JSONL persistence for one graph directory."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.nodes_path = directory / "nodes.jsonl"
        self.edges_path = directory / "edges.jsonl"

    def load(self) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], int]:
        """Replay both files. Returns ``(nodes, edges, dead_lines)``."""
        self.directory.mkdir(parents=True, exist_ok=True)
        nodes, dead_n = self._replay(self.nodes_path)
        edges, dead_e = self._replay(self.edges_path)
        return nodes, edges, dead_n + dead_e

    @staticmethod
    def _replay(path: Path) -> tuple[dict[str, dict[str, Any]], int]:
        state: dict[str, dict[str, Any]] = {}
        lines = 0
        if not path.exists():
            return state, 0
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                    rid = rec["id"]
                except (ValueError, KeyError, TypeError):
                    log.warning("skipping unreadable line in %s", path.name)
                    continue
                lines += 1
                if rec.get("deleted"):
                    state.pop(rid, None)
                else:
                    state[rid] = rec
        return state, lines - len(state)

    def append(self, node_recs: list[dict[str, Any]], edge_recs: list[dict[str, Any]]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        for path, recs in ((self.nodes_path, node_recs), (self.edges_path, edge_recs)):
            if not recs:
                continue
            with path.open("a", encoding="utf-8") as fh:
                for rec in recs:
                    fh.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")

    def rewrite(self, node_recs: list[dict[str, Any]], edge_recs: list[dict[str, Any]]) -> None:
        """Atomically replace both files with just the live records."""
        self.directory.mkdir(parents=True, exist_ok=True)
        for path, recs in ((self.nodes_path, node_recs), (self.edges_path, edge_recs)):
            tmp = path.with_suffix(path.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8") as fh:
                for rec in recs:
                    fh.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
            os.replace(tmp, path)


class Graph:
    """The property graph plus the transaction journal."""

    def __init__(self, store: Store | None = None) -> None:
        self.store = store
        self.lock = threading.RLock()
        self.nodes: dict[str, Node] = {}
        self.rels: dict[str, Rel] = {}
        self.by_label: dict[str, dict[str, None]] = {}
        self.out: dict[str, dict[str, None]] = {}
        self.inn: dict[str, dict[str, None]] = {}
        self.pidx: dict[str, dict[Hashable, dict[str, None]]] = {}
        self._next_node = 1
        self._next_rel = 1
        self._journal: list[Callable[[], None]] | None = None
        self._dirty_nodes: dict[str, None] = {}
        self._dirty_rels: dict[str, None] = {}
        if store is not None:
            self._load()

    # -- loading ------------------------------------------------------------

    def _load(self) -> None:
        assert self.store is not None
        nodes, edges, dead = self.store.load()
        for rec in nodes.values():
            node = Node(rec["id"], list(rec.get("labels") or []), dict(rec.get("props") or {}))
            self._index_node(node)
            self._next_node = max(self._next_node, _numeric_suffix(node.id) + 1)
        for rec in edges.values():
            if rec["src"] not in self.nodes or rec["dst"] not in self.nodes:
                continue
            rel = Rel(rec["id"], rec["type"], rec["src"], rec["dst"], dict(rec.get("props") or {}))
            self._index_rel(rel)
            self._next_rel = max(self._next_rel, _numeric_suffix(rel.id) + 1)
        if dead > 1000 and dead > len(self.nodes) + len(self.rels):
            self.store.rewrite(
                [self._node_rec(n) for n in self.nodes.values()],
                [self._rel_rec(r) for r in self.rels.values()],
            )
            log.info("compacted local graph store: dropped %d dead lines", dead)
        log.info("local graph loaded: %d nodes, %d relationships", len(self.nodes), len(self.rels))

    # -- indexing helpers ---------------------------------------------------

    def _index_node(self, node: Node) -> None:
        self.nodes[node.id] = node
        for label in node.labels:
            self.by_label.setdefault(label, {})[node.id] = None
        for k, v in node.props.items():
            self._index_prop(node.id, k, v)

    def _unindex_node(self, node: Node) -> None:
        self.nodes.pop(node.id, None)
        for label in node.labels:
            self.by_label.get(label, {}).pop(node.id, None)
        for k, v in node.props.items():
            self._unindex_prop(node.id, k, v)

    def _index_prop(self, nid: str, key: str, value: Any) -> None:
        ik = index_key(value)
        if ik is not None:
            self.pidx.setdefault(key, {}).setdefault(ik, {})[nid] = None

    def _unindex_prop(self, nid: str, key: str, value: Any) -> None:
        ik = index_key(value)
        if ik is not None:
            self.pidx.get(key, {}).get(ik, {}).pop(nid, None)

    def _index_rel(self, rel: Rel) -> None:
        self.rels[rel.id] = rel
        self.out.setdefault(rel.src, {})[rel.id] = None
        self.inn.setdefault(rel.dst, {})[rel.id] = None

    def _unindex_rel(self, rel: Rel) -> None:
        self.rels.pop(rel.id, None)
        self.out.get(rel.src, {}).pop(rel.id, None)
        self.inn.get(rel.dst, {}).pop(rel.id, None)

    # -- transactions -------------------------------------------------------

    def begin(self) -> None:
        self._journal = []
        self._dirty_nodes = {}
        self._dirty_rels = {}

    def mark(self) -> int:
        return len(self._journal) if self._journal is not None else 0

    def undo_to(self, mark: int) -> None:
        assert self._journal is not None
        while len(self._journal) > mark:
            self._journal.pop()()

    def rollback(self) -> None:
        if self._journal is not None:
            self.undo_to(0)
        self._journal = None
        self._dirty_nodes = {}
        self._dirty_rels = {}

    def commit(self) -> None:
        journal_active = self._journal is not None
        self._journal = None
        if not journal_active:
            return
        node_recs = [
            self._node_rec(self.nodes[i]) if i in self.nodes else {"id": i, "deleted": True}
            for i in self._dirty_nodes
        ]
        edge_recs = [
            self._rel_rec(self.rels[i]) if i in self.rels else {"id": i, "deleted": True}
            for i in self._dirty_rels
        ]
        self._dirty_nodes = {}
        self._dirty_rels = {}
        if self.store is not None and (node_recs or edge_recs):
            self.store.append(node_recs, edge_recs)

    @staticmethod
    def _node_rec(node: Node) -> dict[str, Any]:
        return {"id": node.id, "labels": node.labels, "props": node.props}

    @staticmethod
    def _rel_rec(rel: Rel) -> dict[str, Any]:
        return {"id": rel.id, "type": rel.type, "src": rel.src, "dst": rel.dst, "props": rel.props}

    def _log(self, undo: Callable[[], None]) -> None:
        if self._journal is not None:
            self._journal.append(undo)

    # -- mutators -----------------------------------------------------------

    def create_node(self, labels: list[str], props: dict[str, Any]) -> Node:
        nid = f"n{self._next_node}"
        self._next_node += 1
        node = Node(nid, list(labels), {k: normalise_prop(v) for k, v in props.items() if v is not None})
        self._index_node(node)
        self._dirty_nodes[nid] = None
        self._log(lambda: self._unindex_node(node))
        return node

    def set_node_prop(self, node: Node, key: str, value: Any) -> None:
        value = normalise_prop(value)
        old = node.props.get(key)
        if key in node.props:
            self._unindex_prop(node.id, key, old)
        if value is None:
            node.props.pop(key, None)
        else:
            node.props[key] = value
            self._index_prop(node.id, key, value)
        self._dirty_nodes[node.id] = None

        def undo() -> None:
            self._unindex_prop(node.id, key, node.props.get(key))
            if old is None:
                node.props.pop(key, None)
            else:
                node.props[key] = old
                self._index_prop(node.id, key, old)

        self._log(undo)

    def add_label(self, node: Node, label: str) -> None:
        if label in node.labels:
            return
        node.labels.append(label)
        self.by_label.setdefault(label, {})[node.id] = None
        self._dirty_nodes[node.id] = None

        def undo() -> None:
            node.labels.remove(label)
            self.by_label.get(label, {}).pop(node.id, None)

        self._log(undo)

    def delete_node(self, node: Node) -> None:
        if node.id not in self.nodes:
            return
        if self.out.get(node.id) or self.inn.get(node.id):
            raise RuntimeError("cannot delete node, because it still has relationships")
        self._unindex_node(node)
        self._dirty_nodes[node.id] = None
        self._log(lambda: self._index_node(node))

    def create_rel(self, rtype: str, src: Node, dst: Node, props: dict[str, Any]) -> Rel:
        rid = f"r{self._next_rel}"
        self._next_rel += 1
        rel = Rel(rid, rtype, src.id, dst.id,
                  {k: normalise_prop(v) for k, v in props.items() if v is not None})
        self._index_rel(rel)
        self._dirty_rels[rid] = None
        self._log(lambda: self._unindex_rel(rel))
        return rel

    def set_rel_prop(self, rel: Rel, key: str, value: Any) -> None:
        value = normalise_prop(value)
        old = rel.props.get(key)
        if value is None:
            rel.props.pop(key, None)
        else:
            rel.props[key] = value
        self._dirty_rels[rel.id] = None

        def undo() -> None:
            if old is None:
                rel.props.pop(key, None)
            else:
                rel.props[key] = old

        self._log(undo)

    def delete_rel(self, rel: Rel) -> None:
        if rel.id not in self.rels:
            return
        self._unindex_rel(rel)
        self._dirty_rels[rel.id] = None
        self._log(lambda: self._index_rel(rel))

    def detach_delete_node(self, node: Node) -> None:
        if node.id not in self.nodes:
            return
        for rid in list(self.out.get(node.id, ())) + list(self.inn.get(node.id, ())):
            rel = self.rels.get(rid)
            if rel is not None:
                self.delete_rel(rel)
        self.delete_node(node)


def _numeric_suffix(ident: str) -> int:
    digits = ident[1:]
    return int(digits) if digits.isdigit() else 0
