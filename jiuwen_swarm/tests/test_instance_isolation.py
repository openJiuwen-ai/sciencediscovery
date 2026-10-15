# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Named instances and fixture edits stay within their selected runtime root."""
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import unittest

import jiuwenswarm
import yaml


class InstanceIsolationTests(unittest.TestCase):
    def test_same_name_in_two_roots_has_independent_registry_and_fixture_state(self):
        repo = Path(__file__).resolve().parents[2]
        source = Path(jiuwenswarm.__file__).resolve().parent.parent
        name = "sd-e2e-mocked-research"
        with tempfile.TemporaryDirectory(prefix="swarm-isolation-") as directory:
            homes = [Path(directory) / "run a", Path(directory) / "run b"]
            configs = []
            for home in homes:
                env = {**os.environ, "JIUWENSWARM_HOME": str(home),
                       "JIUWENSWARM_INSTANCE": name, "JIUWENSWARM_SRC": str(source)}
                env.pop("JIUWENSWARM_DATA_DIR", None)
                init = subprocess.run([sys.executable, "-m", "jiuwenswarm.init_workspace", "--name", name],
                                      cwd=repo, env=env, input="", text=True, capture_output=True, timeout=60)
                self.assertEqual(init.returncode, 0, init.stderr)
                workspace = home / ".jiuwenswarm-instances" / name
                registry = yaml.safe_load((home / ".jiuwenswarm/instances.yaml").read_text())
                self.assertEqual(Path(registry["instances"][name]["workspace"]), workspace)
                self.assertIn(f"JIUWENSWARM_DATA_DIR={workspace}", (workspace / ".env").read_text())
                configs.append(workspace / "config/config.yaml")

                # The wrapper and early bootstrap must both resolve a relative
                # selection before their children change working directory.
                env["JIUWENSWARM_HOME"] = os.path.relpath(home, repo)
                ports = subprocess.run(["bash", "scripts/jiuwenswarm.sh", "env"], cwd=repo,
                                       env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(ports.returncode, 0, ports.stderr)
                self.assertIn("export JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:", ports.stdout)

            sibling = configs[1].read_bytes()
            configured = subprocess.run([sys.executable, ".ci/prepare-research-fixture.py"], cwd=repo,
                                        env={**os.environ, "JIUWENSWARM_HOME": str(homes[0]),
                                             "JIUWENSWARM_INSTANCE": name},
                                        text=True, capture_output=True, timeout=30)
            self.assertEqual(configured.returncode, 0, configured.stderr)
            context = yaml.safe_load(configs[0].read_text())["react"]["context_engine_config"]
            self.assertEqual(context["context_window_tokens"], 32768)
            self.assertEqual(configs[1].read_bytes(), sibling)

            # A sibling listening on the configured port must not make a
            # stopped instance look running, even when its name is identical.
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen()
                registry_path = homes[1] / ".jiuwenswarm/instances.yaml"
                registry = yaml.safe_load(registry_path.read_text())
                registry["instances"][name]["ports"]["gateway"] = listener.getsockname()[1]
                registry_path.write_text(yaml.safe_dump(registry))
                status = subprocess.run(["bash", "scripts/jiuwenswarm.sh", "status"], cwd=repo,
                                        env={**env, "JIUWENSWARM_HOME": str(homes[1])},
                                        text=True, capture_output=True, timeout=30)
                self.assertNotEqual(status.returncode, 0)
                self.assertIn("gateway: not reachable", status.stdout)

    def test_research_fixture_requires_an_explicit_absolute_home(self):
        repo = Path(__file__).resolve().parents[2]
        for home in (None, "relative"):
            env = {**os.environ, "JIUWENSWARM_INSTANCE": "sd-e2e-mocked-research"}
            env.pop("JIUWENSWARM_HOME", None)
            if home is not None:
                env["JIUWENSWARM_HOME"] = home
            result = subprocess.run([sys.executable, ".ci/prepare-research-fixture.py"],
                                    cwd=repo, env=env, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("JIUWENSWARM_HOME", result.stderr)


if __name__ == "__main__":
    unittest.main()
