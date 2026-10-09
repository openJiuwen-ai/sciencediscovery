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

"""Apply JiuwenSwarm's MCP timeout patch before its startup prewarms MCP clients.

Python imports ``sitecustomize`` during interpreter startup when this directory
is on ``PYTHONPATH``. ScienceDiscovery adds it only to JiuwenSwarm processes.
The hook deliberately does not import JiuwenSwarm here: doing that before its
dotenv/bootstrap code runs initializes openJiuwen logging against the process's
read-only startup directory. Instead it wraps the normal import of the deep
adapter and applies the already-imported patch immediately after that module is
loaded, before startup prewarming can create an MCP client. Without this hook,
the first prewarmed client keeps JiuwenSwarm's 30-second fallback for its whole
lifetime.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import os
import sys
from types import ModuleType
from typing import Any


_TARGET = "jiuwenswarm.server.runtime.agent_adapter.interface_deep"


class _PatchAfterImportLoader(importlib.abc.Loader):
    def __init__(self, wrapped: importlib.abc.Loader) -> None:
        self._wrapped = wrapped

    def create_module(self, spec: Any) -> ModuleType | None:
        create = getattr(self._wrapped, "create_module", None)
        return create(spec) if create else None

    def exec_module(self, module: ModuleType) -> None:
        self._wrapped.exec_module(module)
        from jiuwenswarm.server.runtime.mcp.call_timeout_patch import apply_mcp_call_timeout_patch

        apply_mcp_call_timeout_patch()


class _PatchBeforePrewarmFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname: str, path: Any, target: ModuleType | None = None):
        if fullname != _TARGET:
            return None
        # PathFinder bypasses sys.meta_path, so resolving the real loader does
        # not recurse into this finder. Remove the one-shot hook once claimed.
        try:
            sys.meta_path.remove(self)
        except ValueError:
            pass
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec is not None and spec.loader is not None:
            spec.loader = _PatchAfterImportLoader(spec.loader)
        return spec


if os.environ.get("SCIENCE_AGENT_JIUWENSWARM_BOOTSTRAP") == "1":
    sys.meta_path.insert(0, _PatchBeforePrewarmFinder())
