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

"""Isolate every test from the user's real graph store.

The pre-existing suites exercise the Neo4j degrade contract, so they pin the
``neo4j`` backend; the local-backend suites opt back in with ``monkeypatch``.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolated_backend(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR", str(tmp_path / "graph"))
    monkeypatch.setenv("SCIENCE_AGENT_MEMORY_GRAPH_BACKEND", "neo4j")
    from sciencediscovery_memory_graph import backend

    monkeypatch.setattr(backend, "_router", None)
    yield
