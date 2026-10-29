#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Download/verify a pinned public task; stage only its data as a local E2E fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tomllib

MANIFEST = Path(__file__).with_name("manifest.json")


def safe_path(root, name):
    parts = PurePosixPath(name).parts
    if not parts or name.startswith("/") or "\\" in name or any(p in ("..", ".") or ":" in p for p in parts):
        raise ValueError("Unsafe benchmark path")
    root = Path(root).resolve()
    path = root.joinpath(*parts)
    if not path.resolve().is_relative_to(root) or any(p.is_symlink() for p in [path, *path.parents] if p != root):
        raise ValueError("Symlink/escaped benchmark path")
    return path


def verify_file(path, item):
    size = path.stat().st_size
    if not path.is_file() or size != item["bytes"]:
        raise ValueError(f"Pinned input size mismatch: {item['path']}")
    digest = hashlib.sha256() if "lfs_pointer_bytes" in item else hashlib.sha1(f"blob {size}\0".encode())
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if "lfs_pointer_bytes" in item:
        # HF's gated tree redacts the LFS SHA256 but exposes the Git pointer OID.
        # Reconstruct that canonical pointer from the actual bytes; check both.
        pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{actual}\nsize {size}\n".encode()
        if len(pointer) != item["lfs_pointer_bytes"]:
            raise ValueError("Unsupported LFS pointer format")
        actual = hashlib.sha1(f"blob {len(pointer)}\0".encode() + pointer).hexdigest()
    if actual != item["oid"]:
        raise ValueError(f"Pinned input hash mismatch: {item['path']}")


def task_inputs(root, task):
    directory = safe_path(root, task["id"])
    for item in task["files"]:
        verify_file(safe_path(directory, item["path"]), item)
    # Fail on unsupported rubrics BEFORE making any paid generation calls.
    from judge import levels
    levels((directory / "tests/rubric.txt").read_text(encoding="utf-8"))
    from rubrics import local_rubric_path
    local = local_rubric_path(task['id'])
    if local:
        levels(local.read_text(encoding="utf-8"))
    return directory


def require_capacity(directory, data_bytes, copies=1):
    free = shutil.disk_usage(directory).free
    required = copies * data_bytes + 5 * 1024**3
    if free < required:
        raise RuntimeError(f"BLOCKED: need {required} free bytes for benchmark data/output; have {free}")


def stage(root, task, data_root, project, session):
    source = task_inputs(root, task)
    # The CI driver grants this fixture scope only for its disposable local stack.
    isolated = os.environ.get("E2E_BIOMNI_FIXTURE_ROOT")
    if not isolated or Path(isolated).resolve() != Path(data_root).resolve():
        raise RuntimeError("BLOCKED: fixture requires the CI driver's isolated data root")
    if not all(part and all(c.isalnum() or c in "_-" for c in part) for part in (project, session)):
        raise ValueError("Invalid fixture identity")
    workspace = safe_path(data_root, f"projects/{project}/sessions/{session}/workspace")
    if not workspace.is_dir():
        raise RuntimeError("BLOCKED: create the disposable session before staging input data")
    inputs = [f for f in task["files"] if f["path"].startswith("environment/data/")]
    require_capacity(workspace, sum(f["bytes"] for f in inputs))
    # Do not share writable hardlinks with the source cache, or copy tests/reference answers.
    for item in inputs:
        destination = safe_path(workspace, item["path"][len("environment/"):])
        destination.parent.mkdir(parents=True, exist_ok=True)
        with safe_path(source, item["path"]).open("rb") as src, destination.open("xb") as dst:
            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
        verify_file(destination, item)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["download", "verify", "stage"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--case", required=True)
    parser.add_argument("--data-root")
    parser.add_argument("--project")
    parser.add_argument("--session")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    task = next((t for t in manifest["tasks"] if t["id"] == args.case), None)
    if task is None:
        raise ValueError("Unknown public task")
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    if args.action == "download":
        if not os.environ.get("HF_TOKEN"):
            raise RuntimeError("BLOCKED: authorized HF_TOKEN required for the gated dataset")
        require_capacity(root, sum(f["bytes"] for f in task["files"]), copies=2)
        from huggingface_hub import hf_hub_download
        for item in task["files"]:
            hf_hub_download(repo_id=manifest["repository"], repo_type="dataset", revision=manifest["revision"],
                            filename=f"{task['id']}/{item['path']}", local_dir=root, token=os.environ["HF_TOKEN"])
    directory = task_inputs(root, task)
    config = tomllib.loads((directory / "task.toml").read_text(encoding="utf-8"))
    if args.action == "stage":
        if not all([args.data_root, args.project, args.session]):
            parser.error("stage requires --data-root, --project and --session")
        stage(root, task, args.data_root, args.project, args.session)
    print(json.dumps({"case_id": task["id"], "files": len(task["files"]), "revision": manifest["revision"],
                      "upstream_environment": config.get("environment", {})}))


if __name__ == "__main__":
    main()
