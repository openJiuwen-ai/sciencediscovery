# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Keep normal upstream core dependencies while preserving Swarm compatibility."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class UpstreamCorePreparationTests(unittest.TestCase):
    def assert_upstream_core(self, source):
        for replacement in (
            "build-core-wheel.py", "verify-core-interrupt.py",
            "prepare_core_runtime", "core_wheels", "openjiuwen-*.whl",
        ):
            self.assertNotIn(replacement, source)

    def test_source_setup_keeps_upstream_dependency_and_swarm_patches(self):
        source = (ROOT / "scripts/jiuwenswarm.sh").read_text()
        self.assert_upstream_core(source)
        setup = source.split("cmd_setup() {", 1)[1].split("\nis_up()", 1)[0]
        self.assertIn("uv sync --python 3.12", setup)
        self.assertIn("apply_compatibility_patches", setup)
        self.assertLess(setup.index("uv sync"), setup.index("jw jiuwenswarm-init"))

    def test_runtime_verifies_swarm_without_rewriting_or_hash_gating_core(self):
        source = (ROOT / "scripts/jiuwenswarm.sh").read_text()
        hook = source.split("verify_compatibility_patches() {", 1)[1].split("\n}", 1)[0]
        self.assertIn('swarm-patches.py" verify', hook)
        self.assertIn('find_spec("jiuwenswarm")', hook)
        self.assertNotIn("openjiuwen", hook)
        self.assertNotIn("pip install", hook)
        self.assertNotIn(" apply", hook)
        self.assert_upstream_core(hook)
        self.assertIn("verify_compatibility_patches", source.split("cmd_start() {", 1)[1])

    def test_docker_keeps_swarm_wheel_without_replacing_core(self):
        source = (ROOT / "Dockerfile").read_text()
        self.assert_upstream_core(source)
        self.assertIn('"workswarm==${jiuwenswarm_pypi_version}"', source)
        self.assertIn("/tmp/swarm-wheels/*.whl", source)
        self.assertIn("scripts/swarm-patches.py verify", source)

    def test_binary_keeps_swarm_wheel_without_replacing_core(self):
        source = (ROOT / "scripts/binary-release/build-payload.sh").read_text()
        self.assert_upstream_core(source)
        self.assertIn('"$swarm_wheels"/*.whl', source)
        self.assertIn('scripts/swarm-patches.py" verify', source)

    def test_no_distributed_core_patch_or_replacement_helpers(self):
        for relative in (
            "scripts/build-core-wheel.py", "scripts/verify-core-interrupt.py",
            "scripts/check-configuration-core-interrupt.py", "jiuwen_swarm/CORE-INTERRUPT.md",
        ):
            self.assertFalse((ROOT / relative).exists(), relative)
        self.assertEqual(list((ROOT / "jiuwen_swarm/core-patches").glob("**/*.patch")), [])


if __name__ == "__main__":
    unittest.main()
