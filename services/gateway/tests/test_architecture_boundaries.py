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

import re
import unittest
from pathlib import Path


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
IGNORED_DIRECTORIES = {"__pycache__", "dist", "node_modules"}
TEXT_SUFFIXES = {
    ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".mdx", ".mjs",
    ".sh", ".ts", ".tsx", ".yaml", ".yml",
}


def _files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and not any(part in IGNORED_DIRECTORIES for part in path.parts):
            yield path


class ArchitectureBoundaryTests(unittest.TestCase):
    def test_node_and_browser_sources_use_only_product_names(self) -> None:
        failures: list[str] = []
        for root in NODE_ROOTS:
            for path in _files(root):
                relative = path.relative_to(REPOSITORY_ROOT).as_posix()
                if VENDOR_NAME.search(relative):
                    failures.append(f"path: {relative}")
                    continue
                if path.suffix.lower() not in TEXT_SUFFIXES:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                if VENDOR_NAME.search(text):
                    failures.append(f"content: {relative}")
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


if __name__ == "__main__":
    unittest.main()
