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

from __future__ import annotations

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
NODE_ROOTS = (
    REPOSITORY_ROOT / "services" / "api",
    REPOSITORY_ROOT / "packages",
    REPOSITORY_ROOT / "apps" / "web",
    REPOSITORY_ROOT / "test" / "api",
)
GATEWAY_PACKAGE = REPOSITORY_ROOT / "services" / "gateway" / "src" / "sciencediscovery_gateway"
VENDOR_NAME = re.compile(r"deer[-_ ]?flow", re.IGNORECASE)
VENDOR_PYTHON_REFERENCE = re.compile(
    r"(?:^|\n)\s*(?:from|import)\s+deerflow\b|deerflow\.",
    re.MULTILINE,
)
HTTPX_CLIENT = re.compile(r"httpx\.(?:Async)?Client\(")
# The Node control plane can only steer these subprocesses through the proxy
# environment it injects, so a client that opts out of the environment silently
# ignores the MCP server's proxy policy.
PROXY_OPT_OUT = re.compile(r"\b(?:trust_env\s*=\s*(?!True)|proxy\s*=|proxies\s*=|mounts\s*=)")
IGNORED_DIRECTORIES = {"__pycache__", ".tmp", "dist", "node_modules"}
TEXT_SUFFIXES = {
    ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".mdx", ".mjs",
    ".sh", ".ts", ".tsx", ".yaml", ".yml",
}


def _call_arguments(text: str, start: int) -> str:
    """Return the argument text of the call whose "(" is at `start`."""
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:index]
    return text[start:]


def _files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and not any(part in IGNORED_DIRECTORIES for part in path.parts):
            yield path


def _node_boundary_failures() -> list[str]:
    failures: list[str] = []
    for root in NODE_ROOTS:
        for path in _files(root):
            relative = path.relative_to(REPOSITORY_ROOT).as_posix()
            if VENDOR_NAME.search(relative):
                failures.append(f"path: {relative}")
                continue
            if path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except FileNotFoundError:
                # The listing preceded the read: another suite removed its generated
                # workspace in between, and a file that no longer exists cannot be
                # asserted on. Treat it as gone rather than as a boundary violation.
                continue
            if VENDOR_NAME.search(text):
                failures.append(f"content: {relative}")
    return failures


class ArchitectureBoundaryTests(unittest.TestCase):
    def test_node_and_browser_sources_use_only_product_names(self) -> None:
        failures = _node_boundary_failures()
        self.assertEqual(failures, [], "vendor naming escaped the Gateway boundary:\n" + "\n".join(failures))

    def test_gateway_package_has_no_vendor_dependency(self) -> None:
        """The adapter that once isolated the vendor is gone; nothing may reach it.

        Web providers were the last vendor-backed surface. With them native to
        Node, this package is only the bundled stdio MCP servers, so a vendor
        reference anywhere in it would be a regression rather than an isolated
        seam.
        """
        failures: list[str] = []
        for path in GATEWAY_PACKAGE.rglob("*.py"):
            if VENDOR_PYTHON_REFERENCE.search(path.read_text(encoding="utf-8")):
                failures.append(path.relative_to(GATEWAY_PACKAGE).as_posix())
        self.assertEqual(failures, [], "vendor dependency reintroduced:\n" + "\n".join(failures))

    def test_bundled_mcp_http_clients_honour_the_injected_proxy_environment(self) -> None:
        """A new bundled source must not pin or disable its own proxying.

        `McpNodeClient` resolves the MCP server's proxy policy and projects it
        onto this subprocess as HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY.
        httpx applies those only while `trust_env` stays on and no explicit
        proxy or transport mount overrides it. The observable half of this
        contract lives in `tests/test_public_biomed_mcp.py`.
        """
        failures: list[str] = []
        for path in GATEWAY_PACKAGE.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            for match in HTTPX_CLIENT.finditer(text):
                arguments = _call_arguments(text, match.end() - 1)
                if PROXY_OPT_OUT.search(arguments):
                    line = text.count("\n", 0, match.start()) + 1
                    failures.append(f"{path.relative_to(GATEWAY_PACKAGE).as_posix()}:{line}")
        self.assertEqual(
            failures,
            [],
            "bundled MCP HTTP clients bypassed the injected proxy environment:\n" + "\n".join(failures),
        )


class GeneratedWorkspaceBoundaryTests(unittest.TestCase):
    """`services/api/.tmp` is a live workspace root, not source.

    Other suites create session trees there while this walk runs, so a generated
    file can be both present at the listing and gone at the read.
    """

    TEMP_ROOT = REPOSITORY_ROOT / "services" / "api" / ".tmp"
    API_ROOT = REPOSITORY_ROOT / "services" / "api"

    def setUp(self) -> None:
        self.TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.probe = self.TEMP_ROOT / f"probe-boundary-{os.getpid()}.ts"
        self.addCleanup(self.probe.unlink, missing_ok=True)

    def relative_probe(self) -> str:
        return self.probe.relative_to(REPOSITORY_ROOT).as_posix()

    def test_a_generated_workspace_is_not_walked(self) -> None:
        self.probe.write_text("// deerflow vendor token\n", encoding="utf-8")
        failures = _node_boundary_failures()
        self.assertNotIn(f"content: {self.relative_probe()}", failures)
        self.assertNotIn(f"path: {self.relative_probe()}", failures)

    def test_a_workspace_file_removed_after_listing_is_skipped(self) -> None:
        # The CI failure lists a path and then cannot read it. Reproduce that exactly:
        # the listing hands the walk a path that no longer exists when it is read.
        self.probe.write_text("// deerflow vendor token\n", encoding="utf-8")
        self.probe.unlink()
        original = _files

        def listed_then_gone(root: Path):
            if root == self.API_ROOT:
                return iter([self.probe])
            return original(root)

        with mock.patch.object(sys.modules[__name__], "_files", listed_then_gone):
            failures = _node_boundary_failures()
        self.assertNotIn(f"content: {self.relative_probe()}", failures)
        self.assertNotIn(f"path: {self.relative_probe()}", failures)


if __name__ == "__main__":
    unittest.main()
