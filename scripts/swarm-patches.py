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


PATCH_ENCODING = "utf-8"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def patch_paths(patches, marker):
    return sorted({name for patch in patches for name in
                   re.findall(rf"^{re.escape(marker)} [ab]/(.+)$", patch.read_text(encoding=PATCH_ENCODING), re.M)})


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
    paths = patch_paths(patches, "+++")
    for name in paths:
        if not (target / name).resolve().is_relative_to(target):
            raise ValueError(f"Unsafe patch path: {name}")
    # New files have a +++ header too, but are intentionally absent before the
    # patch. Only the old-side headers name files a patch must find in the
    # checked-out JiuwenSwarm source.
    required_paths = patch_paths(patches, "---")
    missing = [name for name in required_paths if not (target / name).is_file()]
    if missing:
        expected = tag
        if (target / ".git").exists():
            pinned = subprocess.run(
                ["git", "-C", str(target), "rev-parse", f"{tag}^{{commit}}"],
                capture_output=True,
                text=True,
            )
            if pinned.returncode == 0:
                expected = f"{tag} ({pinned.stdout.strip()})"
        raise ValueError(
            "JiuwenSwarm source is incompatible with the ScienceDiscovery "
            f"patch set for {expected}: missing patch target(s): {', '.join(missing)}. "
            "Use scripts/jiuwenswarm.sh setup with the pinned source, or remove "
            "the stale JIUWENSWARM_ROOT before retrying."
        )
    expected = {"tag": tag, "patches": {p.name: digest(p) for p in patches}}
    if mode == "apply":
        # A wheel's site-packages may be nested inside the application Git tree.
        # Do not let git apply discover that unrelated repository.
        env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(target.parent)}
        # A patch revised in place no longer reverses cleanly over its old result,
        # and a revised new-file patch finds its file already there. Start a source
        # checkout from the pinned files whenever the recorded patch set changed.
        previous = json.loads(manifest.read_text()) if manifest.exists() else None
        # [windows-desktop] 0015 note: later patches may touch the same hunks
        # as earlier ones (0015 removes a call site 0001 added), so
        # reverse-checking 0001 over a fully patched tree fails even though
        # the tree is correct. Short-circuit first: an unchanged patch set
        # whose recorded file digests still match the tree IS the fully
        # patched state — nothing to apply, and no per-patch reverse check
        # can succeed (each later patch invalidates its predecessors'
        # reverse context). This covers both source checkouts and tag-less
        # scratch trees (patch tests).
        skip_apply = previous is not None and previous.get("patches") == expected["patches"] and all(
            (target / name).is_file() and digest(target / name) == recorded
            for name, recorded in previous.get("files", {}).items()
        ) and all((target / name).is_file() for name in paths)
        if previous and previous.get("patches") != expected["patches"] and (target / ".git").exists():
            restore_pinned(target, tag, set(paths) | set(previous.get("files", {})), env)
        # A source checkout with the tag available replays from the pinned
        # state (a few seconds of git apply) — correct even when the digest
        # short-circuit above did not trigger (mixed manual edits, missing
        # files). Fresh trees without .git (packaged site-packages) or without
        # the tag (scratch test dirs) keep the legacy forward/skip cycle.
        elif not skip_apply and (target / ".git").exists() and subprocess.run(
            ["git", "-C", str(target), "rev-parse", "-q", "--verify", f"{tag}^{{commit}}"],
            capture_output=True).returncode == 0:
            restore_pinned(target, tag, set(paths) | set(previous.get("files", {}) if previous else {}), env)
        if not skip_apply:
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
