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

import atexit
import os
import re
import signal
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


# services/api/src/mcp/datasource-egress-contract.test.ts walks every `.ts` file
# under these roots and reads each one, skipping only the directories below and
# tolerating no file that vanished between the listing and the read. A probe
# planted there is read by a worker that knows nothing about it: the read fails
# with ENOENT once addCleanup unlinks it, and a killed run leaves a vendor token
# behind in a tracked source directory.
EGRESS_SCANNED_ROOTS = ("packages", "services")
EGRESS_IGNORED_DIRECTORIES = {"dist", "node_modules", ".tmp"}


def _egress_scan_reads(path: Path) -> bool:
    """Whether the datasource egress contract worker opens this file."""
    if path.suffix != ".ts":
        return False
    relative = path.relative_to(REPOSITORY_ROOT)
    if relative.parts[0] not in EGRESS_SCANNED_ROOTS:
        return False
    return not any(part in EGRESS_IGNORED_DIRECTORIES for part in relative.parts[:-1])


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
    # `services/api` is the root #918 names first, so the positive half stays inside
    # it. A `.mdx` probe is still text for the walk, while the datasource egress
    # contract worker only opens `.ts`, so no other worker reads a file this case
    # creates and removes.
    PROBE_ROOT = REPOSITORY_ROOT / "services" / "api" / "src"
    PROBE_SUFFIX = ".mdx"
    # A killed run cannot clean up after itself, so the pattern is ignored by git and
    # the next run sweeps what a dead process left behind. Keep both in sync.
    PROBE_PATTERN = f"probe-boundary-*{PROBE_SUFFIX}"

    def setUp(self) -> None:
        self.TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.probe = self.TEMP_ROOT / f"probe-boundary-{os.getpid()}.ts"
        self.addCleanup(self.probe.unlink, missing_ok=True)
        self._remove_stale_probes()
        # Installed once per case, before any probe exists, so every test that writes
        # one is covered — including tests added later.
        self._guard_probe_against_signals()

    def relative_probe(self) -> str:
        return self.probe.relative_to(REPOSITORY_ROOT).as_posix()

    def positive_probe_path(self) -> Path:
        """Where the positive case plants the file the walk must report.

        It sits under `services/api/src`, the root #918 names first, so narrowing or
        ignoring that tree fails this case instead of leaving it green. The `.mdx`
        suffix keeps it out of the datasource egress contract test, which reads only
        `.ts` files under `packages/` and `services/`.
        """
        return self.PROBE_ROOT / f"probe-boundary-{os.getpid()}{self.PROBE_SUFFIX}"

    def _remove_stale_probes(self) -> None:
        """Delete probes a killed run left behind, never one a live run is using.

        `SIGKILL` cannot be caught, so this sweep — not the handler below — is what
        keeps a dead run's probe from reaching the next one. A pid that still answers
        `kill(pid, 0)` may be a parallel shard mid-test, so its file stays.
        """
        for stale in self.PROBE_ROOT.glob(self.PROBE_PATTERN):
            try:
                owner = int(stale.stem.rsplit("-", 1)[1])
            except (IndexError, ValueError):
                continue
            if owner == os.getpid():
                continue
            try:
                os.kill(owner, 0)
            except ProcessLookupError:
                stale.unlink(missing_ok=True)
            except PermissionError:
                continue

    def _guard_probe_against_signals(self) -> None:
        """Unlink the probe on exit, `SIGINT` and `SIGTERM`, then let the signal work.

        Installed before any probe exists so no window misses it. A signal handler
        restores the previous handler and re-raises the same signal, because a
        cancelled job must still fail rather than exit zero; the `atexit` hook covers
        a `sys.exit` or an interpreter that ends without running unittest cleanups.
        Both read `self.probe` when they fire, so they unlink the probe the current
        test actually wrote.
        """
        previous: dict[int, object] = {}

        def on_exit() -> None:
            self.probe.unlink(missing_ok=True)

        def restore() -> None:
            atexit.unregister(on_exit)
            for signum, handler in previous.items():
                signal.signal(signum, handler)

        def on_signal(signum: int, _frame: object) -> None:
            self.probe.unlink(missing_ok=True)
            restore()
            os.kill(os.getpid(), signum)

        atexit.register(on_exit)
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.getsignal(signum)
            signal.signal(signum, on_signal)
        self.addCleanup(restore)

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

    def test_a_vendor_reference_outside_a_generated_workspace_is_still_reported(self) -> None:
        """The cases above only prove the walk stays quiet; this proves it still speaks.

        Both of them assert a negative, so narrowing the walk would keep them green
        while vendor naming escaped the boundary entirely. Pin the positive half:
        a file the walk should report is reported.
        """
        self.probe = self.positive_probe_path()
        self.addCleanup(self.probe.unlink, missing_ok=True)
        self.probe.write_text("// deerflow vendor token\n", encoding="utf-8")
        original = _files

        def only_the_probe(root: Path):
            # Keep the real listing (so IGNORED_DIRECTORIES still governs) and drop
            # every other file, so the assertion cannot depend on the working tree.
            if root == self.PROBE_ROOT:
                return (path for path in original(root) if path == self.probe)
            return original(root)

        with mock.patch.object(sys.modules[__name__], "_files", only_the_probe):
            failures = _node_boundary_failures()
        self.assertIn(f"content: {self.relative_probe()}", failures)

    def test_the_positive_probe_lives_in_the_root_the_issue_names(self) -> None:
        # The assertions above only say the walk still speaks; this one says where.
        # Without it, moving the probe back to `apps/web` (or anywhere the egress
        # worker never scans) would keep the whole class green.
        relative = self.positive_probe_path().relative_to(REPOSITORY_ROOT).as_posix()
        self.assertIn("services/api/src/", relative)
        self.assertTrue(relative.endswith(self.PROBE_SUFFIX))

    def test_the_walk_enumerates_and_reads_the_positive_probe(self) -> None:
        """The `.mdx` suffix is only sound while the walk still treats it as text.

        Changing the suffix, or a rule that skips non-source files under
        `services/api/src`, would silently stop the positive half from ever seeing
        the probe — so this asserts the walk lists the file and reports its content.
        """
        self.probe = self.positive_probe_path()
        self.addCleanup(self.probe.unlink, missing_ok=True)
        self.probe.write_text("// deerflow vendor token\n", encoding="utf-8")
        self.assertIn(self.probe.suffix.lower(), TEXT_SUFFIXES)
        self.assertIn(self.probe, list(_files(self.PROBE_ROOT)))
        self.assertIn(f"content: {self.relative_probe()}", _node_boundary_failures())

    def test_the_positive_probe_is_not_written_where_the_egress_worker_scans(self) -> None:
        # The egress contract test reads every `.ts` under packages/ and services/.
        # A probe there races that read and can outlive a killed run, so the probe
        # must use a suffix that worker never opens.
        self.assertFalse(
            _egress_scan_reads(self.positive_probe_path()),
            f"{self.positive_probe_path().relative_to(REPOSITORY_ROOT).as_posix()} is read by the "
            "datasource egress worker while it exists; give the probe a suffix it never opens",
        )


if __name__ == "__main__":
    unittest.main()
