# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import prepare


def blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


class PrepareTests(unittest.TestCase):
    def test_local_pin_is_checked_during_task_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            data = b'Criterion 1: Example\nLevels: A=100 B=50 C=0\n'
            path = Path(directory) / 'da-13-3/tests/rubric.txt'
            path.parent.mkdir(parents=True)
            path.write_bytes(data)
            task = {'id': 'da-13-3', 'files': [{'path': 'tests/rubric.txt', 'bytes': len(data), 'oid': blob(data)}]}
            with patch('rubrics.local_rubric_path', side_effect=ValueError('Local rubric pin mismatch')) as local:
                with self.assertRaisesRegex(ValueError, 'Local rubric pin mismatch'):
                    prepare.task_inputs(directory, task)
            local.assert_called_once_with('da-13-3')

    def test_download_uses_pinned_hub_inputs_and_verifies_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {"task.toml": b'[environment]\n',
                     "tests/rubric.txt": b'Criterion 1: Analysis\nLevels: A=100 B=50 C=0\n'}
            task = {"id": "da-1-1", "files": [
                {"path": name, "bytes": len(data), "oid": blob(data)} for name, data in files.items()]}
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"repository": "fixture/benchmark", "revision": "pinned-revision", "tasks": [task]}))

            def download(**kwargs):
                self.assertEqual(kwargs["repo_id"], "fixture/benchmark")
                self.assertEqual(kwargs["repo_type"], "dataset")
                self.assertEqual(kwargs["revision"], "pinned-revision")
                path = Path(kwargs["local_dir"]) / kwargs["filename"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(files[kwargs["filename"].removeprefix("da-1-1/")])
                return str(path)

            # Import and call the installed Hub API, replacing only network I/O.
            with patch.object(prepare, "MANIFEST", manifest), patch.dict(os.environ, {"HF_TOKEN": "fixture"}), \
                 patch("sys.argv", ["prepare", "download", "--root", str(root / "inputs"), "--case", task["id"]]), \
                 patch("huggingface_hub.hf_hub_download", side_effect=download) as hub:
                prepare.main()
            self.assertEqual(hub.call_count, len(files))
            (root / "inputs/da-1-1/task.toml").write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                prepare.task_inputs(root / "inputs", task)

    def test_regular_and_lfs_stream_checksums_reject_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            data = b"scientific data"
            path.write_bytes(data)
            pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{hashlib.sha256(data).hexdigest()}\nsize {len(data)}\n".encode()
            for item in [{"path": "input", "bytes": len(data), "oid": blob(data)},
                         {"path": "input", "bytes": len(data), "oid": blob(pointer), "lfs_pointer_bytes": len(pointer)}]:
                prepare.verify_file(path, item)
                with self.assertRaises(ValueError):
                    prepare.verify_file(path, {**item, "oid": "a" * 40})
                with self.assertRaises(ValueError):
                    prepare.verify_file(path, {**item, "bytes": len(data) + 1})

    def test_input_paths_cannot_escape_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ["../outside", "/outside", "C:/outside", "data\\escape"]:
                with self.assertRaises(ValueError):
                    prepare.safe_path(directory, name)
            link = Path(directory) / "link"
            link.symlink_to(Path(directory).parent, target_is_directory=True)
            with self.assertRaises(ValueError):
                prepare.safe_path(directory, "link/file")

    def test_staging_preserves_nested_files_without_reference_answers_or_writable_hardlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source/da-1-1"
            path = source / "environment/data/nested/input.txt"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"original")
            (source / "rubric.txt").write_text("secret answer")
            runtime = root / "runtime"
            workspace = runtime / "projects/p/sessions/s/workspace"
            workspace.mkdir(parents=True)
            task = {"id":"da-1-1", "files":[{"path":"environment/data/nested/input.txt", "bytes":8, "oid":blob(b"original")}]}
            with patch.object(prepare, "task_inputs", return_value=source), patch.object(prepare, "require_capacity"), patch.dict(os.environ, {"E2E_BIOMNI_FIXTURE_ROOT":str(runtime)}):
                prepare.stage(root / "source", task, runtime, "p", "s")
                self.assertEqual(list(workspace.rglob("*.txt")), [workspace / "data/nested/input.txt"])
                (workspace / "data/nested/input.txt").write_text("changed")
                self.assertEqual(path.read_bytes(), b"original")
                with self.assertRaises(FileExistsError):
                    prepare.stage(root / "source", task, runtime, "p", "s")
            with patch.object(prepare, "task_inputs", return_value=source), patch.dict(os.environ, {"E2E_BIOMNI_FIXTURE_ROOT":""}):
                with self.assertRaises(RuntimeError):
                    prepare.stage(root / "source", task, runtime, "p", "s")

    def test_insufficient_storage_is_blocked_before_download(self):
        with patch.object(prepare.shutil, "disk_usage") as disk:
            disk.return_value.free = 1
            with self.assertRaisesRegex(RuntimeError, "BLOCKED"):
                prepare.require_capacity(".", 100)


if __name__ == "__main__":
    unittest.main()
