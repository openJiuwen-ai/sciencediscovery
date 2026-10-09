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


def process(mode, target, tag):
    target = Path(target).resolve()
    patch_dir = Path(__file__).resolve().parents[1] / "jiuwen_swarm" / "patches" / tag
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
    args = parser.parse_args()
    process(args.mode, args.target, args.tag)
