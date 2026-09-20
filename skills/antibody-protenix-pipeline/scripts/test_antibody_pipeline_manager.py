#!/usr/bin/env python3
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

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("antibody_pipeline_manager.py")
SPEC = importlib.util.spec_from_file_location("antibody_pipeline_manager", SCRIPT)
assert SPEC and SPEC.loader
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


class SandboxConfigTests(unittest.TestCase):
    def test_hotspot_list_is_normalized(self) -> None:
        self.assertEqual(
            manager.normalize_hotspots(["A45", "A46", "A49"]),
            "[A45,A46,A49]",
        )

    def test_hotspots_must_exist_in_target_pdb(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target.pdb"
            target.write_text(
                "ATOM      1  CA  ALA A  45      0.000   0.000   0.000  1.00  0.00           C\n"
                "ATOM      2  CA  GLY A  46      1.000   0.000   0.000  1.00  0.00           C\n",
                encoding="utf-8",
            )
            valid = {"target_pdb": target, "hotspots": "[A45,A46]"}
            invalid = {"target_pdb": target, "hotspots": "[B45,A49]"}

            self.assertEqual(manager.hotspot_target_errors(valid), [])
            self.assertEqual(
                manager.hotspot_target_errors(invalid),
                [
                    f"hotspots do not exist in target_pdb {target}: "
                    "B45,A49 (available chains: A)"
                ],
            )

    def test_checkpoint_download_is_atomic_and_verified(self) -> None:
        payload = b"verified-checkpoint"
        digest = manager.hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "model.ckpt"
            response = mock.MagicMock()
            response.__enter__.return_value = mock.Mock(read=mock.Mock(side_effect=[payload, b""]))
            response.__exit__.return_value = False
            with mock.patch.object(manager.urllib.request, "urlopen", return_value=response):
                manager.download_file(
                    "https://example.test/model.ckpt",
                    destination,
                    size=len(payload),
                    sha256=digest,
                )
            self.assertEqual(destination.read_bytes(), payload)
            self.assertFalse(destination.with_suffix(".ckpt.part").exists())

    def test_existing_verified_checkpoint_is_reused_without_network(self) -> None:
        payload = b"verified-checkpoint"
        digest = manager.hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "model.ckpt"
            destination.write_bytes(payload)
            with mock.patch.object(manager.urllib.request, "urlopen") as urlopen:
                manager.download_file(
                    "https://example.test/model.ckpt",
                    destination,
                    size=len(payload),
                    sha256=digest,
                )
            urlopen.assert_not_called()

    def test_mindscience_source_and_checkpoints_are_pinned(self) -> None:
        self.assertRegex(manager.MINDSCIENCE_REF, r"^[0-9a-f]{40}$")
        self.assertRegex(manager.SHARKER_REF, r"^[0-9a-f]{40}$")
        self.assertEqual(manager.SHARKER_REPO_URL, "https://gitee.com/sunhaoneng/gnn.git")
        self.assertEqual(manager.RF_DIFFUSION_CKPT["size"], 480_719_938)
        self.assertEqual(manager.PROTEINMPNN_CKPT["size"], 6_654_507)
        self.assertEqual(manager.PROTENIX_CKPT["size"], 1_472_707_161)
        self.assertRegex(str(manager.RF_DIFFUSION_CKPT["sha256"]), r"^[0-9a-f]{64}$")
        self.assertRegex(str(manager.PROTEINMPNN_CKPT["sha256"]), r"^[0-9a-f]{64}$")
        self.assertRegex(str(manager.PROTENIX_CKPT["sha256"]), r"^[0-9a-f]{64}$")

    def test_existing_mindscience_checkout_moves_to_pinned_detached_ref(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory) / "mindscience"
            subprocess.run(["git", "init", str(checkout)], check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", str(checkout), "config", "user.email", "test@example.com"],
                check=True,
            )
            subprocess.run(
                ["git", "-C", str(checkout), "config", "user.name", "Skill Test"],
                check=True,
            )
            source = checkout / "source.txt"
            source.write_text("pinned\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(checkout), "add", "source.txt"], check=True)
            subprocess.run(
                ["git", "-C", str(checkout), "commit", "-m", "pinned"],
                check=True,
                capture_output=True,
            )
            pinned = subprocess.run(
                ["git", "-C", str(checkout), "rev-parse", "HEAD"],
                check=True,
                text=True,
                capture_output=True,
            ).stdout.strip()
            source.write_text("newer\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(checkout), "commit", "-am", "newer"],
                check=True,
                capture_output=True,
            )

            with mock.patch.object(manager, "MINDSCIENCE_REF", pinned):
                manager.ensure_mindscience_checkout(checkout)

            head = subprocess.run(
                ["git", "-C", str(checkout), "rev-parse", "HEAD"],
                check=True,
                text=True,
                capture_output=True,
            ).stdout.strip()
            symbolic = subprocess.run(
                ["git", "-C", str(checkout), "symbolic-ref", "-q", "HEAD"],
                text=True,
                capture_output=True,
            )
            self.assertEqual(head, pinned)
            self.assertNotEqual(symbolic.returncode, 0)

    def test_rfdiffusion_io_patch_is_applied_once_and_then_reused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / "mindscience"
            checkout.mkdir()
            subprocess.run(["git", "init", str(checkout)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(checkout), "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(checkout), "config", "user.name", "Skill Test"], check=True)
            source = checkout / "writer.py"
            source.write_text("value = tensor\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(checkout), "add", "writer.py"], check=True)
            subprocess.run(["git", "-C", str(checkout), "commit", "-m", "base"], check=True, capture_output=True)
            source.write_text("value = int(tensor)\n", encoding="utf-8")
            patch = root / "compat.patch"
            patch.write_text(
                subprocess.run(
                    ["git", "-C", str(checkout), "diff", "--", "writer.py"],
                    check=True,
                    text=True,
                    capture_output=True,
                ).stdout,
                encoding="utf-8",
            )
            patch.write_bytes(patch.read_bytes().replace(b"\n", b"\r\n"))
            subprocess.run(["git", "-C", str(checkout), "checkout", "--", "writer.py"], check=True)

            manager.apply_rfdiffusion_io_patch(checkout, patch)
            self.assertEqual(source.read_text(encoding="utf-8"), "value = int(tensor)\n")
            self.assertEqual(manager.rfdiffusion_io_patch_errors(checkout, patch), [])

            with mock.patch.object(manager.subprocess, "run", wraps=subprocess.run) as run:
                manager.apply_rfdiffusion_io_patch(checkout, patch)
            apply_calls = [
                call for call in run.call_args_list
                if "apply" in call.args[0] and "--check" not in call.args[0]
            ]
            self.assertEqual(apply_calls, [])

    def test_rfdiffusion_io_patch_rejects_unexpected_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkout = root / "mindscience"
            checkout.mkdir()
            subprocess.run(["git", "init", str(checkout)], check=True, capture_output=True)
            source = checkout / "writer.py"
            source.write_text("unexpected\n", encoding="utf-8")
            patch = root / "compat.patch"
            patch.write_text(
                "diff --git a/writer.py b/writer.py\n"
                "--- a/writer.py\n+++ b/writer.py\n"
                "@@ -1 +1 @@\n-old\n+new\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                manager.apply_rfdiffusion_io_patch(checkout, patch)

    def test_sharker_install_is_pinned_and_replaces_unverified_copy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            package = source / "sharker"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("VERSION = 'pinned'\n", encoding="utf-8")
            destination = root / "rf_diffusion" / "env" / "sharker"
            destination.mkdir(parents=True)
            (destination / "__init__.py").write_text("VERSION = 'old'\n", encoding="utf-8")

            manager.install_sharker(source, destination)

            self.assertEqual(
                (destination / "__init__.py").read_text(encoding="utf-8"),
                "VERSION = 'pinned'\n",
            )
            marker = manager.read_json(destination / ".sciencediscovery-source.json")
            self.assertEqual(marker["revision"], manager.SHARKER_REF)
            self.assertFalse(destination.with_name("sharker.part").exists())

            with mock.patch.object(manager.shutil, "copytree") as copytree:
                manager.install_sharker(source, destination)
            copytree.assert_not_called()

    def test_validate_paths_reports_missing_sharker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rf_dir = root / "rf_diffusion"
            rf_dir.mkdir()
            cfg = {
                "app_dir": root,
                "rf_diffusion_dir": rf_dir,
                "proteinmpnn_dir": root,
                "protenix_dir": root,
                "target_pdb": root / "target.pdb",
                "framework_pdb": root / "framework.pdb",
                "ckpt": root / "rf.ckpt",
                "proteinmpnn_ckpt": root / "proteinmpnn.ckpt",
                "protenix_ckpt": root / "protenix.ckpt",
                "python": Path(os.sys.executable),
                "pipeline_env": "",
                "hmmer_home": "",
                "cann_set_env": "",
                "protenix_use_msa": False,
            }
            for key in ("target_pdb", "framework_pdb", "ckpt", "proteinmpnn_ckpt", "protenix_ckpt"):
                Path(cfg[key]).touch()
            with mock.patch.object(manager, "managed_python_errors", return_value=[]):
                errors, _ = manager.validate_paths(cfg)
            self.assertTrue(any("sharker package" in item for item in errors), errors)

            package = rf_dir / "env" / "sharker"
            package.mkdir(parents=True)
            (package / "__init__.py").touch()
            with mock.patch.object(manager, "managed_python_errors", return_value=[]):
                errors, _ = manager.validate_paths(cfg)
            self.assertFalse(any("sharker package" in item for item in errors), errors)

            Path(cfg["proteinmpnn_ckpt"]).unlink()
            with mock.patch.object(manager, "managed_python_errors", return_value=[]):
                errors, _ = manager.validate_paths(cfg)
            self.assertTrue(any("proteinmpnn_ckpt" in item for item in errors), errors)

    def test_sharker_import_uses_rfdiffusion_env_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app_dir = root / "mindscience" / "MindSPONGE" / "applications"
            rf_dir = app_dir / "rf_diffusion"
            package = rf_dir / "env" / "sharker"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("VALUE = 'ok'\n", encoding="utf-8")
            cfg = {
                "app_dir": app_dir,
                "rf_diffusion_dir": rf_dir,
                "python": os.fspath(Path(os.sys.executable).resolve()),
            }
            self.assertEqual(manager.sharker_import_errors(cfg), [])

            (package / "__init__.py").write_text("raise RuntimeError('broken sharker')\n", encoding="utf-8")
            errors = manager.sharker_import_errors(cfg)
            self.assertTrue(any("broken sharker" in item for item in errors), errors)

    def test_selected_environment_python_precedes_legacy_aliases(self) -> None:
        with mock.patch.dict(os.environ, {
            "SCIENCE_ENV_PYTHON": "/opt/science-env/bin/python",
            "SCIENCE_AGENT_MANAGED_PYTHON": "/home/user/legacy/bin/python",
            "PYTHON_BIN": "/home/user/other/bin/python",
            "ANTIBODY_PIPELINE_PYTHON": "/home/user/pipeline/bin/python",
        }), mock.patch.object(manager, "executable_file", return_value=True):
            self.assertEqual(manager.discover_python(), "/opt/science-env/bin/python")

    def test_defaults_resolve_inside_runner_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            raw = {
                "workspace": "antibody_pipeline",
                "target_pdb": "antibody_pipeline/inputs/target.pdb",
                "framework_pdb": "antibody_pipeline/inputs/framework.pdb",
                "hotspots": "B45",
                "num_designs": 1,
            }
            cfg = manager.resolve_config(raw, workspace_root=root)
            self.assertEqual(manager.sandbox_config_errors(raw, cfg, workspace_root=root), [])
            for key in manager.WORKSPACE_PATH_KEYS:
                value = cfg.get(key)
                if value:
                    Path(value).resolve().relative_to(root)

    def test_absolute_host_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            raw = {
                "workspace": "antibody_pipeline",
                "mindscience_root": str((root.parent / "shared-models").resolve()),
                "hotspots": "B45",
                "num_designs": 1,
            }
            cfg = manager.resolve_config(raw, workspace_root=root)
            errors = manager.sandbox_config_errors(raw, cfg, workspace_root=root)
            self.assertTrue(any("mindscience_root must be relative" in item for item in errors), errors)

    def test_parent_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            raw = {
                "workspace": "antibody_pipeline",
                "ckpt": "../shared/RFdiffusion_Ab.ckpt",
                "hotspots": "B45",
                "num_designs": 1,
            }
            cfg = manager.resolve_config(raw, workspace_root=root)
            errors = manager.sandbox_config_errors(raw, cfg, workspace_root=root)
            self.assertTrue(any("ckpt escapes" in item for item in errors), errors)

    def test_symlink_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory).resolve()
            link = root / "linked-models"
            try:
                link.symlink_to(Path(outside).resolve(), target_is_directory=True)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")
            raw = {
                "workspace": "antibody_pipeline",
                "mindscience_root": "linked-models/mindscience",
                "hotspots": "B45",
                "num_designs": 1,
            }
            cfg = manager.resolve_config(raw, workspace_root=root)
            errors = manager.sandbox_config_errors(raw, cfg, workspace_root=root)
            self.assertTrue(any("mindscience_root escapes" in item for item in errors), errors)

    def test_runtime_owned_fields_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            raw = {
                "workspace": "antibody_pipeline",
                "python": "/host/venv/bin/python",
                "scripts_dir": "/tmp/copied-skill",
                "hotspots": "B45",
                "num_designs": 1,
            }
            cfg = manager.resolve_config(raw, workspace_root=root)
            errors = manager.sandbox_config_errors(raw, cfg, workspace_root=root)
            self.assertTrue(any(item.startswith("python is runtime-owned") for item in errors), errors)
            self.assertTrue(any(item.startswith("scripts_dir is runtime-owned") for item in errors), errors)

    def test_command_uses_frozen_skill_helper_without_nohup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            raw = {
                "workspace": "antibody_pipeline",
                "target_pdb": "antibody_pipeline/inputs/target.pdb",
                "framework_pdb": "antibody_pipeline/inputs/framework.pdb",
                "hotspots": "B45",
                "num_designs": 1,
            }
            previous = os.environ.get("ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV")
            os.environ["ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV"] = "0"
            try:
                cfg = manager.resolve_config(raw, workspace_root=root)
                cfg["python"] = os.fspath(Path(os.sys.executable).resolve())
                command = manager.command_for_full_run(cfg)
            finally:
                if previous is None:
                    os.environ.pop("ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV", None)
                else:
                    os.environ["ANTIBODY_REQUIRE_SCIENCEDISCOVERY_ENV"] = previous
            self.assertEqual(command[0], "bash")
            self.assertTrue(command[1].endswith("run_full_antibody_pipeline.sh"), command)
            self.assertNotIn("nohup", command)

    def test_numpy2_schedule_cache_is_quarantined_for_numpy1(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            schedules = Path(directory) / "rf_diffusion" / "schedules"
            schedules.mkdir(parents=True)
            incompatible = schedules / "T_200_schedule_linear.pkl"
            compatible = schedules / "T_200_legacy.pkl"
            quarantined = schedules / "T_200_old.numpy2-incompatible.pkl"
            other = schedules / "T_40_schedule_linear.pkl"
            incompatible.write_bytes(b"pickle-prefix numpy._core.numeric pickle-suffix")
            compatible.write_bytes(b"pickle-prefix numpy.core.numeric pickle-suffix")
            quarantined.write_bytes(b"pickle-prefix numpy._core.numeric pickle-suffix")
            other.write_bytes(b"numpy._core.numeric")
            moved = manager.quarantine_incompatible_numpy_caches({
                "rf_diffusion_dir": str(schedules.parent),
                "diffuser_t": 200,
            }, numpy_major=1)
            self.assertEqual(len(moved), 1)
            self.assertFalse(incompatible.exists())
            self.assertTrue(moved[0][1].exists())
            self.assertTrue(compatible.exists())
            self.assertTrue(quarantined.exists())
            self.assertNotIn(quarantined, [source for source, _ in moved])
            self.assertTrue(other.exists())


if __name__ == "__main__":
    unittest.main()
