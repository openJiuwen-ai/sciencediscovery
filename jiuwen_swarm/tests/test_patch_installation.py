# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Apply the exact shipped patch sequence twice to clean pinned sources."""
import io
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


class PatchInstallationTests(unittest.TestCase):
    def test_package_build_and_read_only_verification(self):
        repo = Path(__file__).resolve().parents[2]
        source = Path(os.environ.get("JIUWENSWARM_SRC", str(repo / ".sciencediscovery-data/jiuwenswarm/src")))
        helper = repo / "scripts/swarm-patches.py"
        archive = subprocess.run(["git", "-C", str(source), "archive", "workswarm0.2.6", "jiuwenswarm"],
                                 check=True, capture_output=True).stdout
        # Deliberately nest a non-Git package directory inside a Git repository,
        # like a wheel installed in a build workspace's virtualenv.
        with tempfile.TemporaryDirectory(prefix="swarm-wheel-") as directory:
            subprocess.run(["git", "init", "-q", directory], check=True)
            target = Path(directory) / "site-packages"
            target.mkdir()
            with tarfile.open(fileobj=io.BytesIO(archive)) as contents:
                contents.extractall(target, filter="data")
            command = [sys.executable, str(helper)]
            for mode in ("apply", "verify", "apply", "verify"):
                subprocess.run(command + [mode, str(target), "workswarm0.2.6"], check=True)
            manifest = target / ".sciencediscovery-patches.json"
            before = manifest.stat().st_mtime_ns
            subprocess.run(command + ["verify", str(target), "workswarm0.2.6"], check=True)
            self.assertEqual(before, manifest.stat().st_mtime_ns)
            client = target / "jiuwenswarm/server/runtime/mcp/sci_http_client.py"
            client.write_text(client.read_text() + "\n# changed\n")
            result = subprocess.run(command + ["verify", str(target), "workswarm0.2.6"], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            result = subprocess.run(command + ["apply", str(target), "unsupported"], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_clean_install_and_repeated_start_are_idempotent(self):
        repo = Path(__file__).resolve().parents[2]
        source = Path(os.environ.get("JIUWENSWARM_SRC", str(repo / ".sciencediscovery-data/jiuwenswarm/src")))
        patches = sorted((repo / "jiuwen_swarm/patches/workswarm0.2.6").glob("*.patch"))
        self.assertTrue(patches)
        paths = sorted({path for patch in patches for path in
                        re.findall(r"^--- a/(.+)$", patch.read_text(), re.M)})
        archive = subprocess.run(["git", "-C", str(source), "archive", "workswarm0.2.6", *paths],
                                 check=True, capture_output=True).stdout
        with tempfile.TemporaryDirectory(prefix="sci-mcp-patches-") as directory:
            with tarfile.open(fileobj=io.BytesIO(archive)) as contents:
                contents.extractall(directory, filter="data")
            subprocess.run(["git", "init", "-q", directory], check=True, capture_output=True)
            applied = []
            for attempt in range(2):
                for patch in patches:
                    reverse = subprocess.run(["git", "-C", directory, "apply", "--reverse", "--check", str(patch)],
                                             capture_output=True)
                    if reverse.returncode == 0:
                        continue
                    self.assertEqual(attempt, 0, f"Second start tries to reapply {patch.name}: {reverse.stderr.decode()}")
                    result = subprocess.run(["git", "-C", directory, "apply", str(patch)], capture_output=True)
                    self.assertEqual(result.returncode, 0, f"{patch.name}: {result.stderr.decode()}")
                    applied.append(patch.name)
            self.assertEqual(applied, [p.name for p in patches])
            actual = Path(directory) / "jiuwenswarm/server/runtime/mcp/sci_http_client.py"
            installed = source / "jiuwenswarm/server/runtime/mcp/sci_http_client.py"
            self.assertEqual(actual.read_text(), installed.read_text(), "Tests must exercise exactly the shipped client")


if __name__ == "__main__":
    unittest.main()
