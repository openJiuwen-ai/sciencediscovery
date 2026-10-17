# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import prepare


def blob(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


class PrepareTests(unittest.TestCase):
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
