# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
# Licensed under the Apache License, Version 2.0 (the "License");
"""DEV-CFG-10: read-only deployment evidence and explicit configuration support.

The legacy gateway's approvals are in-memory. Neither config.set nor /agent/runs
implements the conditional operation and durable configuration interrupt contracts.
Discovering a newer core package must never automatically enable those contracts.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any


def deployment_evidence(source: str | None = None) -> dict[str, Any]:
    evidence: dict[str, Any] = {"workswarmCommit": None, "coreCommit": None, "patches": []}
    # Only an operator-selected local install root; never a URL/path supplied by an Agent.
    selected = source if source is not None else os.environ.get("JIUWENSWARM_SRC")
    if not selected:
        return evidence
    root = Path(selected).resolve()
    try:
        commit = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel", "HEAD"],
                                capture_output=True, text=True, timeout=2, check=True).stdout.strip()
        parts = commit.splitlines()
        if len(parts) == 2 and Path(parts[0]).resolve() == root and re.fullmatch(r"[a-f0-9]{40}", parts[1]):
            evidence["workswarmCommit"] = parts[1]
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        manifest = json.loads((root / ".sciencediscovery-patches.json").read_text(encoding="utf-8"))
        files = manifest.get("files", {})
        # A manifest is evidence only if the installed files still match its recorded hashes.
        patches = manifest.get("patches", {})
        if isinstance(patches, dict) and patches and all(isinstance(name, str) and len(name) <= 160
            and Path(name).name == name and isinstance(checksum, str) and re.fullmatch(r"[a-f0-9]{64}", checksum)
            for name, checksum in patches.items()) and isinstance(files, dict) and files and all(
            isinstance(name, str) and not Path(name).is_absolute() and ".." not in Path(name).parts
            and (root / name).resolve().is_relative_to(root)
            and isinstance(expected, str) and re.fullmatch(r"[a-f0-9]{64}", expected)
            and hashlib.sha256((root / name).read_bytes()).hexdigest() == expected
            for name, expected in files.items()
        ):
            evidence["patches"] = sorted(patches)
    except (OSError, ValueError, TypeError):
        pass
    # Read metadata in the selected environment without importing/executing upstream code.
    for site in sorted((root / ".venv" / "lib").glob("python*/site-packages")):
        for distribution in importlib.metadata.distributions(path=[str(site)]):
            if distribution.metadata.get("Name", "").lower() != "openjiuwen":
                continue
            try:
                direct = json.loads(distribution.read_text("direct_url.json") or "{}")
                commit = direct.get("vcs_info", {}).get("commit_id")
                if isinstance(commit, str) and re.fullmatch(r"[a-f0-9]{40}", commit):
                    evidence["coreCommit"] = commit
            except (ValueError, TypeError):
                pass
    return evidence


def configuration_capabilities() -> dict[str, Any]:
    return {
        "protocolVersion": 1,
        "backendId": "jiuwenswarm",
        "baseline": deployment_evidence(),
        "control": {"conditionalWrite": False, "idempotentOperations": False, "queryOperation": False},
        "runtime": {"durableInterrupt": False, "exactResume": False,
                    "targetToolRefresh": False, "durableWaitBinding": False},
        "settings": [],
        "unavailableReasons": [
            "The adapter has no authoritative conditional configuration operation service.",
            "The adapter has no durable configuration interrupt/checkpoint and exact-resume binding.",
            "Global config.set or reload does not prove activation in the paused target run.",
        ],
    }
