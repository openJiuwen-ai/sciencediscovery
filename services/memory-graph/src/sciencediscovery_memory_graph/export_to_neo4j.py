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

"""One-way import of the local JSONL graph into a Neo4j server.

    python -m sciencediscovery_memory_graph.export_to_neo4j \\
        --http http://127.0.0.1:7474 --user neo4j --password-env NEO4J_PASSWORD

Nodes are MERGEd on a temporary ``_local_id`` property (removed at the end), so
re-running the import is idempotent and never duplicates a node it already
copied. Relationships are MERGEd between the copied endpoints. Run the sidecar
against Neo4j once first so its constraints exist.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import httpx

from ._neo4j_http import _HttpSession
from .local_backend import default_data_dir
from .local_graph import Graph, Store

_BATCH = 500
_IDENT = "`{}`"


def _quote(name: str) -> str:
    return _IDENT.format(name.replace("`", "``"))


def _batches(rows: list[dict[str, Any]]):
    for i in range(0, len(rows), _BATCH):
        yield rows[i:i + _BATCH]


def export_graph(graph: Graph, session: Any) -> tuple[int, int]:
    """Copy ``graph`` through an open Neo4j ``session``; returns (nodes, rels)."""
    by_labels: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for node in graph.nodes.values():
        by_labels[tuple(node.labels)].append({"id": node.id, "props": node.props})
    for labels, rows in by_labels.items():
        label_expr = "".join(f":{_quote(lb)}" for lb in labels)
        for chunk in _batches(rows):
            session.run(
                f"UNWIND $rows AS r MERGE (n{label_expr} {{_local_id: r.id}}) SET n += r.props",
                rows=chunk,
            ).consume()
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for rel in graph.rels.values():
        by_type[rel.type].append({"src": rel.src, "dst": rel.dst, "props": rel.props})
    for rtype, rows in by_type.items():
        for chunk in _batches(rows):
            session.run(
                "UNWIND $rows AS r MATCH (a {_local_id: r.src}) MATCH (b {_local_id: r.dst}) "
                f"MERGE (a)-[e:{_quote(rtype)}]->(b) SET e += r.props",
                rows=chunk,
            ).consume()
    session.run("MATCH (n) WHERE n._local_id IS NOT NULL REMOVE n._local_id").consume()
    return len(graph.nodes), len(graph.rels)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    parser.add_argument("--http", default="http://127.0.0.1:7474", help="Neo4j HTTP address")
    parser.add_argument("--user", default="neo4j")
    parser.add_argument("--password-env", default="NEO4J_PASSWORD",
                        help="environment variable holding the Neo4j password")
    args = parser.parse_args(argv)
    password = os.environ.get(args.password_env)
    if not password:
        print(f"set {args.password_env} to the Neo4j password", file=sys.stderr)
        return 2
    graph = Graph(Store(args.data_dir))
    with httpx.Client(base_url=args.http, auth=(args.user, password), timeout=60.0) as client:
        with _HttpSession(client, base_url=args.http, auth=(args.user, password)) as session:
            nodes, rels = export_graph(graph, session)
    print(f"imported {nodes} nodes and {rels} relationships into {args.http}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
