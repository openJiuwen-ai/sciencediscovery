# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Install pinned patches at build time; verify installed files without git at runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def restore_pinned(target, tag, paths, env):
    """Return patched paths to the pinned tag, so that patches revised in place apply again.

    Only a source checkout can do this: its Git history has the unpatched files. A
    path the tag does not have was created by a patch and is removed.
    """
    for name in sorted(paths):
        pinned = subprocess.run(["git", "-C", str(target), "cat-file", "-e", f"{tag}:{name}"],
                                env=env, capture_output=True).returncode == 0
        if pinned:
            subprocess.run(["git", "-C", str(target), "checkout", tag, "--", name], env=env, check=True)
        else:
            (target / name).unlink(missing_ok=True)


def process(mode, target, tag, patch_dir=None):
    target = Path(target).resolve()
    patch_dir = Path(patch_dir).resolve() if patch_dir else Path(__file__).resolve().parents[1] / "jiuwen_swarm" / "patches" / tag
    patches = sorted(patch_dir.glob("*.patch"))
    if not patches:
        raise ValueError(f"No supported Swarm patch set for {tag}")
    manifest = target / ".sciencediscovery-patches.json"
    paths = sorted({name for patch in patches for name in
                    re.findall(r"^\+\+\+ b/(.+)$", patch.read_text(), re.M)})
    for name in paths:
        if not (target / name).resolve().is_relative_to(target):
            raise ValueError(f"Unsafe patch path: {name}")
    expected = {"tag": tag, "patches": {p.name: digest(p) for p in patches}}
    if mode == "apply":
        # A wheel's site-packages may be nested inside the application Git tree.
        # Do not let git apply discover that unrelated repository.
        env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(target.parent)}
        # A patch revised in place no longer reverses cleanly over its old result,
        # and a revised new-file patch finds its file already there. Start a source
        # checkout from the pinned files whenever the recorded patch set changed.
        previous = json.loads(manifest.read_text()) if manifest.exists() else None
        if previous and previous.get("patches") != expected["patches"] and (target / ".git").exists():
            restore_pinned(target, tag, set(paths) | set(previous.get("files", {})), env)
        for patch in patches:
            command = ["git", "-C", str(target), "apply"]
            if subprocess.run(command + ["--reverse", "--check", str(patch)],
                              env=env, capture_output=True).returncode == 0:
                continue
            subprocess.run(command + ["--check", str(patch)], env=env, check=True)
            subprocess.run(command + [str(patch)], env=env, check=True)
        expected["files"] = {name: digest(target / name) for name in paths}
        manifest.write_text(json.dumps(expected, indent=2) + "\n")
    else:
        actual = json.loads(manifest.read_text())
        expected["files"] = {name: digest(target / name) for name in paths}
        if actual != expected:
            raise ValueError("Swarm patch verification failed; rebuild or run setup before starting")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["apply", "verify"])
    parser.add_argument("target", help="Directory containing the jiuwenswarm package")
    parser.add_argument("tag")
    parser.add_argument("--patch-dir", help="Patch set to use instead of jiuwen_swarm/patches/<tag>")
    args = parser.parse_args()
    process(args.mode, args.target, args.tag, args.patch_dir)
