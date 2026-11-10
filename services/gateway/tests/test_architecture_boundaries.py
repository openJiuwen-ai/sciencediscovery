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
import subprocess
import sys
import time
import unittest
from collections.abc import Iterable
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


# `services/api` is the root #918 names first, so the positive half of the boundary
# walk stays inside it. A `.mdx` probe is still text for that walk — `.mdx` is in
# TEXT_SUFFIXES — while the datasource egress contract worker only opens `.ts`, so no
# other worker reads a file a case creates and removes.
PROBE_ROOT = REPOSITORY_ROOT / "services" / "api" / "src"
PROBE_SUFFIX = ".mdx"
# A killed run cannot clean up after itself, so this pattern is ignored by git and the
# next run sweeps what a dead process left behind. Keep the two in sync.
#
# Sweeping is a heuristic, and its limits are deliberate: a pid that a container has
# recycled onto an unrelated live process is caught by the start-time test below, and
# a same-pid probe is never touched. Parallel shards that share one checkout are NOT
# supported: `ArchitectureBoundaryTests` walks the real tree and can see a sibling's
# in-flight probe, and the sweep is not allowed to delete a live shard's file. CI gives
# every job its own checkout, so this shape does not occur there; introducing xdist
# would need the probe moved or the walk redesigned, not a skip marker.
PROBE_PATTERN = f"probe-boundary-*{PROBE_SUFFIX}"
# The slowest probe-holding case measured 0.65 s (`pytest --durations=0`), so the age
# fallback for hosts without /proc uses 10 s: more than ten times a full probe life,
# which keeps a parallel shard's fresh probe and still collects an abandoned one.
PROBE_STALE_AGE_S = 10.0
# `btime` in /proc/stat has one-second resolution while a probe's mtime is
# nanosecond-precise, so a shard that writes its probe within a second of starting
# would look older than its own process. This margin absorbs that truncation and any
# NTP step, and stays well below PROBE_STALE_AGE_S.
PROBE_START_MARGIN_S = 3.0


def _process_started_at(pid: int) -> float | None:
    """Wall-clock start of `pid` from /proc, or None where /proc is unusable.

    `starttime` is the 22nd field of /proc/<pid>/stat, counted in clock ticks since
    boot — `SC_CLK_TCK` per second, which is not always 100 — and `btime` is whole
    seconds, so the result is accurate to about one second.
    """
    try:
        with open("/proc/stat", encoding="utf-8") as handle:
            boot = next(int(line.split()[1]) for line in handle if line.startswith("btime "))
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            fields = handle.read().rsplit(")", 1)[1].split()
        return boot + int(fields[19]) / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, StopIteration):
        return None


def _remove_stale_probes(root: Path, pattern: str) -> None:
    """Delete probes a dead run left, never one a live shard is still writing.

    A dead pid means the file is garbage. A live pid is judged by its own start time
    (so a recycled pid cannot keep an old probe alive), and hosts without /proc fall
    back to pid liveness plus PROBE_STALE_AGE_S. Our own pid is judged the same way:
    the start-time rule already keeps a probe this process wrote, while a leftover
    from a killed run that held this pid before the namespace recycled it is older
    than our start and gets swept.
    """
    for stale in root.glob(pattern):
        try:
            owner = int(stale.stem.rsplit("-", 1)[1])
        except (IndexError, ValueError):
            continue
        try:
            os.kill(owner, 0)
        except ProcessLookupError:
            stale.unlink(missing_ok=True)
            continue
        except PermissionError:
            pass  # alive, just not ours to signal
        started = _process_started_at(owner)
        if started is not None:
            if stale.stat().st_mtime < started - PROBE_START_MARGIN_S:
                stale.unlink(missing_ok=True)
            continue
        if time.time() - stale.stat().st_mtime >= PROBE_STALE_AGE_S:
            stale.unlink(missing_ok=True)


def setUpModule() -> None:
    """Sweep before any test walks the tree, not from the class that writes probes.

    `ArchitectureBoundaryTests.test_node_and_browser_sources_use_only_product_names`
    walks the real tree without a patched listing and is collected before the class
    below, so a sweep that only ran from that class let a dead run's probe fail it
    first.
    """
    _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)


class GeneratedWorkspaceBoundaryTests(unittest.TestCase):
    """`services/api/.tmp` is a live workspace root, not source.

    Other suites create session trees there while this walk runs, so a generated
    file can be both present at the listing and gone at the read.
    """

    TEMP_ROOT = REPOSITORY_ROOT / "services" / "api" / ".tmp"
    API_ROOT = REPOSITORY_ROOT / "services" / "api"
    PROBE_ROOT = PROBE_ROOT
    PROBE_SUFFIX = PROBE_SUFFIX

    def setUp(self) -> None:
        self.TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.probe = self.TEMP_ROOT / f"probe-boundary-{os.getpid()}.ts"
        self.addCleanup(self.probe.unlink, missing_ok=True)
        # Idempotent: setUpModule already swept, and a later case in the same run may
        # have left something behind.
        _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        # Installed once per case, before any probe exists, so every test that writes
        # one is covered — including tests added later.
        self._guard_probe_against_signals()

    def relative_probe(self) -> str:
        return self.probe.relative_to(REPOSITORY_ROOT).as_posix()

    def _filtered_listing(self, root: Path, listing: Iterable[Path]) -> Iterable[Path]:
        """Keep only this case's probe under the root the walk actually visits.

        `_node_boundary_failures()` calls `_files()` with `NODE_ROOTS` entries, so the
        filter has to key on `API_ROOT`; keying on `PROBE_ROOT` never matches and lets
        the positive case read every root unfiltered.
        """
        if root != self.API_ROOT:
            return listing
        return (path for path in listing if path == self.probe)

    def positive_probe_path(self) -> Path:
        """Where the positive case plants the file the walk must report.

        It sits under `services/api/src`, the root #918 names first, so narrowing or
        ignoring that tree fails this case instead of leaving it green. The `.mdx`
        suffix keeps it out of the datasource egress contract test, which reads only
        `.ts` files under `packages/` and `services/`.
        """
        return self.PROBE_ROOT / f"probe-boundary-{os.getpid()}{self.PROBE_SUFFIX}"

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
            # every file but this case's probe under the walked root, so the assertion
            # cannot depend on the working tree or on a parallel shard's probe.
            return self._filtered_listing(root, original(root))

        with mock.patch.object(sys.modules[__name__], "_files", only_the_probe):
            failures = _node_boundary_failures()
        self.assertIn(f"content: {self.relative_probe()}", failures)

    def test_the_positive_filter_drops_another_shards_probe(self) -> None:
        """Prove the filter filters, rather than its condition never matching.

        A predicate keyed on a root the walk never visits lets every file through, so
        this feeds the API-root listing a sibling's probe and an ordinary source file
        and requires both to be gone while this case's probe survives.
        """
        self.probe = self.positive_probe_path()
        foreign_probe = self.PROBE_ROOT / f"probe-boundary-{os.getpid() + 1}{self.PROBE_SUFFIX}"
        foreign_source = self.PROBE_ROOT / "neighbour.py"
        self.assertEqual(
            list(self._filtered_listing(self.API_ROOT, [self.probe, foreign_probe, foreign_source])),
            [self.probe],
        )
        # The root the walk does not visit stays untouched, which is the bug this
        # pins: `_node_boundary_failures()` only ever passes NODE_ROOTS entries.
        self.assertEqual(
            list(self._filtered_listing(self.PROBE_ROOT, [self.probe, foreign_probe])),
            [self.probe, foreign_probe],
        )

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


class StaleProbeSweepTests(unittest.TestCase):
    """The sweep runs before any test walks the tree, and never touches a live shard.

    A probe planted by this class is visible to `_node_boundary_failures()`, so these
    cases exist to pin when it may be deleted: a dead owner, a file older than the
    live owner's own start, or a leftover from a killed run whose pid we now hold —
    but never a probe a young or live owner just wrote.
    """

    def write_probe(self, pid: int) -> Path:
        probe = PROBE_ROOT / f"probe-boundary-{pid}{PROBE_SUFFIX}"
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_text("// deerflow vendor token\n", encoding="utf-8")
        self.addCleanup(probe.unlink, missing_ok=True)
        return probe

    def spawn_sleeper(self) -> subprocess.Popen:
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])

        def stop() -> None:
            child.kill()
            child.wait()

        self.addCleanup(stop)
        return child

    def test_a_dead_owner_probe_is_swept(self) -> None:
        probe = self.write_probe(999999)
        _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        self.assertFalse(probe.exists())

    def test_a_probe_older_than_its_live_owner_is_swept(self) -> None:
        probe = self.write_probe(self.spawn_sleeper().pid)
        stale = time.time() - 600
        os.utime(probe, (stale, stale))
        _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        self.assertFalse(probe.exists())

    def test_a_probe_a_live_owner_just_wrote_is_kept(self) -> None:
        probe = self.write_probe(self.spawn_sleeper().pid)
        _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        self.assertTrue(probe.exists())

    def test_this_process_probe_from_a_killed_run_is_swept(self) -> None:
        # A pid the namespace recycled can be ours now, yet the probe was written by
        # the run that was killed. Sweeping it is what stops that leftover from
        # reddening the real-tree walk, which is the residue this module exists to
        # clean up.
        probe = self.write_probe(os.getpid())
        stale = time.time() - 600
        os.utime(probe, (stale, stale))
        _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        self.assertFalse(probe.exists())

    def test_this_process_probe_is_kept_while_it_is_fresh(self) -> None:
        probe = self.write_probe(os.getpid())
        _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        self.assertTrue(probe.exists())

    def test_without_proc_the_age_fallback_decides(self) -> None:
        probe = self.write_probe(self.spawn_sleeper().pid)
        stale = time.time() - (PROBE_STALE_AGE_S + 5)
        os.utime(probe, (stale, stale))
        with mock.patch.object(sys.modules[__name__], "_process_started_at", return_value=None):
            _remove_stale_probes(PROBE_ROOT, PROBE_PATTERN)
        self.assertFalse(probe.exists())

    def test_process_start_time_is_none_when_proc_is_absent(self) -> None:
        real_open = open

        def without_proc(path, *args, **kwargs):
            if str(path).startswith("/proc/"):
                raise FileNotFoundError(path)
            return real_open(path, *args, **kwargs)

        with mock.patch("builtins.open", without_proc):
            self.assertIsNone(_process_started_at(os.getpid()))


if __name__ == "__main__":
    unittest.main()
