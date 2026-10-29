# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
"""Portable graph rows. Never archive the truncated/synthetic UI subgraph."""
from __future__ import annotations

import json
import math
from collections import defaultdict
from typing import Any
from uuid import uuid4

from .backend import handle
from .query import _ID_FIELDS, _json_safe, _node_identity

EDGE_TYPES = {"next", "produces", "extracts", "supports", "stated_in", "supersedes",
              "input", "contains", "searches", "root", "expands", "inspires", "elected",
              "occupies", "feeds"}


def _key(labels: list[str], props: dict[str, Any]) -> str:
    return json.dumps([sorted(labels), props.get("session_id"),
                       _node_identity(labels[0], props)], ensure_ascii=False)


def export_snapshot(session_ids: list[str]) -> dict[str, Any]:
    driver = handle()
    if not driver.is_reachable():
        raise RuntimeError("Memory graph is unavailable")
    with driver.session() as session:
        nodes = [{"id": _key(row["labels"], dict(row["node"])),
                  "labels": row["labels"], "properties": _json_safe(dict(row["node"]))}
                 for row in session.run(
                     "MATCH (n) WHERE n.session_id IN $ids RETURN labels(n) AS labels, n AS node",
                     ids=session_ids)]
        edges = [{"source": _key(row["src_labels"], dict(row["src"])),
                  "target": _key(row["dst_labels"], dict(row["dst"])),
                  "type": row["type"], "properties": _json_safe(dict(row["rel"]))}
                 for row in session.run(
                     "MATCH (a)-[r]->(b) WHERE a.session_id IN $ids AND b.session_id IN $ids "
                     "RETURN a AS src, b AS dst, labels(a) AS src_labels, labels(b) AS dst_labels, "
                     "type(r) AS type, r AS rel", ids=session_ids)]
    validate_snapshot(session_ids, nodes, edges)
    return {"nodes": nodes, "edges": edges}


def _properties(props: dict[str, Any]) -> None:
    def scalar(value: Any) -> bool:
        return value is None or isinstance(value, (str, bool, int)) or (
            isinstance(value, float) and math.isfinite(value))
    if any(key.startswith("_package_") or not (
        scalar(value) or isinstance(value, list) and all(scalar(item) for item in value)
    ) for key, value in props.items()):
        raise ValueError("Invalid graph properties")


def validate_snapshot(session_ids: list[str], nodes: list[dict[str, Any]],
                      edges: list[dict[str, Any]]) -> tuple[dict, dict]:
    keys: set[str] = set()
    identities: set[str] = set()
    grouped_nodes: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    grouped_edges: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in nodes:
        labels, props = node["labels"], node["properties"]
        if (not labels or len(set(labels)) != len(labels) or any(label not in _ID_FIELDS for label in labels)
                or node["id"] in keys or props.get("session_id") not in session_ids
                or _node_identity(labels[0], props) is None):
            raise ValueError("Invalid graph node or session scope")
        _properties(props)
        identity = _key(labels, props)
        if identity in identities:
            raise ValueError("Duplicate graph node identity")
        identities.add(identity)
        keys.add(node["id"])
        grouped_nodes[tuple(sorted(labels))].append(node)
    for edge in edges:
        if edge["type"] not in EDGE_TYPES or edge["source"] not in keys or edge["target"] not in keys:
            raise ValueError("Invalid graph edge")
        _properties(edge["properties"])
        grouped_edges[edge["type"]].append(edge)
    return grouped_nodes, grouped_edges


def import_snapshot(session_ids: list[str], nodes: list[dict[str, Any]],
                    edges: list[dict[str, Any]]) -> None:
    """Validate the entire snapshot before writes; restore only into empty scopes."""
    grouped_nodes, grouped_edges = validate_snapshot(session_ids, nodes, edges)
    driver = handle()
    if not driver.is_reachable():
        raise RuntimeError("Memory graph is unavailable")
    token = str(uuid4())
    with driver.session() as session:
        if session.run("MATCH (n) WHERE n.session_id IN $ids RETURN n LIMIT 1", ids=session_ids).single():
            raise ValueError("Target memory graph must be empty")
        try:
            for labels, rows in grouped_nodes.items():
                # Labels and relationship types come exclusively from the vocabulary above.
                session.run(f"UNWIND $rows AS row CREATE (n:{':'.join(labels)}) "
                            "SET n += row.properties, n._package_import = $token, n._package_node = row.id",
                            rows=rows, token=token).consume()
            for edge_type, rows in grouped_edges.items():
                session.run("UNWIND $rows AS row "
                            "MATCH (a {_package_import: $token, _package_node: row.source}) "
                            "MATCH (b {_package_import: $token, _package_node: row.target}) "
                            f"CREATE (a)-[r:{edge_type}]->(b) SET r += row.properties",
                            rows=rows, token=token).consume()
            session.run("MATCH (n {_package_import: $token}) "
                        "SET n._package_import = null, n._package_node = null", token=token).consume()
        except Exception:
            session.run("MATCH (n {_package_import: $token}) DETACH DELETE n", token=token).consume()
            raise


def discard_snapshot(session_ids: list[str]) -> None:
    """Compensate fresh unpublished scopes; callers own the operation's session IDs."""
    driver = handle()
    if not driver.is_reachable():
        raise RuntimeError("Memory graph is unavailable")
    with driver.session() as session:
        session.run("MATCH (n) WHERE n.session_id IN $ids DETACH DELETE n",
                    ids=session_ids).consume()
