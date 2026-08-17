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

"""Starting the Gateway must not import the vendor package.

Web providers are the only vendor-backed surface left, and ``_engine.web``
loads that dependency lazily. Everything reachable from service start-up —
the app, the web router, the internal-auth dependency, the bundled MCP
servers — must therefore import with ``deerflow`` blocked, so a missing or
broken vendor install degrades web provider invocation alone instead of
taking the whole sidecar down.

Runs in a subprocess so this process's module cache cannot mask an import.
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

_PROBE = """
import sys


class VendorImportBlocker:
    def find_spec(self, name, path=None, target=None):
        if name == "deerflow" or name.startswith("deerflow."):
            raise ImportError(f"vendor import blocked: {name}")
        return None


sys.meta_path.insert(0, VendorImportBlocker())

# Service start-up: app, routes, and the internal-auth dependency.
from science_agent_gateway import server
from science_agent_gateway.internal_auth import require_internal_token

assert server.app is not None
# openapi() reflects the served surface regardless of how the FastAPI version
# stores included routers internally.
paths = set(server.app.openapi()["paths"])
assert "/health" in paths, paths
assert "/internal/web/invoke" in paths, paths
# The retired agent-loop entry point must not come back.
assert "/run" not in paths, paths

# The bundled stdio MCP servers run from this same environment.
import science_agent_gateway.public_biomed_mcp
import science_agent_gateway.uniprot_mcp

# The engine package itself stays importable; only attribute access on the web
# seam may reach the vendor.
import science_agent_gateway._engine as engine

assert "deerflow" not in sys.modules
print("GATEWAY_START_VENDOR_FREE")
"""


class GatewayVendorBoundaryTest(unittest.TestCase):
    def test_gateway_starts_with_vendor_blocked(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        result = subprocess.run(
            [sys.executable, "-c", _PROBE],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=repo_root,
        )
        self.assertEqual(result.returncode, 0, msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        self.assertIn("GATEWAY_START_VENDOR_FREE", result.stdout)


if __name__ == "__main__":
    unittest.main()
