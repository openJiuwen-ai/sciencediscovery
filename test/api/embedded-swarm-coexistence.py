#!/usr/bin/env python3
# Copyright (C) 2026 Huawei Technologies Co., Ltd
# SPDX-License-Identifier: Apache-2.0
"""Two same-name Swarm installations coexist through the supported CLIs.

Run from the repository root with the pinned Swarm Python:
  JIUWENSWARM_SRC=/absolute/pinned/src PYTHONPATH=services/adapter/src \
    /absolute/pinned/src/.venv/bin/python test/api/embedded-swarm-coexistence.py

E2E-META
Purpose: Preserve standalone state while operating an embedded same-name instance.
Steps: Initialize both roots; start both orders; create/list sessions; stop/restart independently.
Environment: Pinned patched Swarm installation with its dependencies, free loopback ports.
Type: local CLI journey, real services, no model calls.
External capabilities: None at runtime; installation must already be provisioned.
Credentials: None.
Cost/side effects: Only disposable roots and local processes owned by this driver.
Reports: .tmp/embedded-swarm-*/report.md and per-command logs, preserved on all outcomes.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

import yaml
from sciencediscovery_adapter.gateway import rpc

REPO = Path(__file__).resolve().parents[2]
(REPO / ".tmp").mkdir(exist_ok=True)
REPORT = Path(tempfile.mkdtemp(prefix="embedded-swarm-", dir=REPO / ".tmp"))
SOURCE = Path(os.environ.get("JIUWENSWARM_SRC", REPO / ".sciencediscovery-data/jiuwenswarm/src")).resolve()
NAME = "sciencediscovery"
BASE = {**os.environ, "JIUWENSWARM_SRC": str(SOURCE), "JIUWENSWARM_INSTANCE": NAME,
        "JIUWENSWARM_ROOT": str(REPORT / "install-state")}
BASE.pop("JIUWENSWARM_DATA_DIR", None)
roots = {name: REPORT / name for name in ("standalone", "embedded")}
steps = []
children = []


def command(root, arguments, *, check=True):
    result = subprocess.run(arguments, cwd=REPO,
                            env={**BASE, "JIUWENSWARM_HOME": str(roots[root])},
                            capture_output=True, text=True, timeout=210)
    (REPORT / f"{len(list(REPORT.glob('*-command.log'))):03d}-command.log").write_text(
        f"{root}: {' '.join(arguments)}\nexit={result.returncode}\n{result.stdout}\n{result.stderr}")
    if check:
        assert result.returncode == 0, result.stdout + result.stderr
    return result


def wrapper(root, action, **kwargs):
    return command(root, ["bash", "scripts/jiuwenswarm.sh", action], **kwargs)


def workspace(root):
    return roots[root] / ".jiuwenswarm-instances" / NAME


def ports(root):
    registry = yaml.safe_load((roots[root] / ".jiuwenswarm/instances.yaml").read_text())
    assert Path(registry["instances"][NAME]["workspace"]) == workspace(root)
    return registry["instances"][NAME]["ports"]


def snapshot(root):
    return {str(p.relative_to(roots[root])): p.read_bytes() for p in (
        roots[root] / ".jiuwenswarm/instances.yaml", workspace(root) / "config/config.yaml",
        workspace(root) / "config/.env")}


def start(root):
    if root == "embedded":
        wrapper(root, "start")
    else:
        log = open(REPORT / f"standalone-start-{len(children)}.log", "w")
        child = subprocess.Popen([str(SOURCE / ".venv/bin/jiuwenswarm-start"), "--name", NAME, "app"],
                                 cwd=REPORT, env={**BASE, "JIUWENSWARM_HOME": str(roots[root])},
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        log.close()
        children.append(child)
        # A user shell reaps the launcher; do likewise so stop can observe its exit.
        threading.Thread(target=child.wait, daemon=True).start()
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if wrapper(root, "status", check=False).returncode == 0:
            return
        time.sleep(1)
    raise AssertionError(f"{root} did not become ready")


def stop(root):
    if root == "embedded":
        wrapper(root, "stop")
    else:
        command(root, [str(SOURCE / ".venv/bin/jiuwenswarm-start"), "--stop", NAME])


async def session(root, method, params=None):
    return await rpc(f"ws://127.0.0.1:{ports(root)['gateway']}/tui", method, params, timeout=40)


def record(text):
    steps.append(text)
    print(text, flush=True)


verdict = "FAIL"
try:
    assert (SOURCE / ".venv/bin/jiuwenswarm-start").is_file(), "BLOCKED: missing pinned installation"
    command("standalone", [str(SOURCE / ".venv/bin/jiuwenswarm-init"), "--name", NAME])
    config = workspace("standalone") / "config/config.yaml"
    config.write_text(config.read_text().replace("progressive_tool_enabled: false", "progressive_tool_enabled: true"))
    before = snapshot("standalone")
    wrapper("embedded", "setup")
    wrapper("embedded", "setup")
    assert snapshot("standalone") == before
    assert "progressive_tool_enabled: false" in (workspace("embedded") / "config/config.yaml").read_text()
    record("1. PASS: repeated embedded setup leaves standalone registry/configuration unchanged.")

    # Both were initialized while stopped, so they may have selected identical
    # ports. Starting the second must detect occupancy and persist new ports.
    for first, second in [("standalone", "embedded"), ("embedded", "standalone")]:
        start(first)
        first_pid = (workspace(first) / ".instance.pid").read_bytes()
        first_state = snapshot(first)
        start(second)
        assert not set(ports(first).values()) & set(ports(second).values())
        assert (workspace(first) / ".instance.pid").read_bytes() == first_pid
        assert snapshot(first) == first_state
        for root in roots:
            current = wrapper(root, "env").stdout
            assert f":{ports(root)['gateway']}/tui" in current
        created = {}
        for root in roots:
            response = asyncio.run(session(root, "session.create", {"mode": "react", "persist_session": True}))
            created[root] = response["session_id"]
        for root in roots:
            listing = json.dumps(asyncio.run(session(root, "session.list")))
            assert created[root] in listing, listing
            other = "embedded" if root == "standalone" else "standalone"
            assert created[other] not in listing, listing
        record(f"2. PASS ({first} first): independent live PIDs, ports, endpoints and session lists.")
        wrapper("embedded", "start")  # idempotent while both are live
        stop(second)
        wrapper(first, "status")
        assert (workspace(first) / ".instance.pid").read_bytes() == first_pid
        assert wrapper(second, "status", check=False).returncode != 0
        stop(first)
        record(f"3. PASS ({second} stopped first): sibling stays live; selected instance stops.")
    assert (roots["embedded"] / f"jiuwenswarm-{NAME}.log").is_file()
    verdict = "PASS"
except (Exception, KeyboardInterrupt) as error:
    if "BLOCKED:" in str(error):
        verdict = "BLOCKED"
    steps.append(f"{type(error).__name__}: {error}")
    raise
finally:
    for root in roots:
        try:
            stop(root)
        except Exception as error:
            steps.append(f"Cleanup {root}: {error}")
    for child in children:
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.terminate()
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    (REPORT / "report.md").write_text(f"# Embedded Swarm coexistence: {verdict}\n\nSHA: {sha}\n\n"
                                        f"Command: JIUWENSWARM_SRC={SOURCE} PYTHONPATH=services/adapter/src "
                                        f"{sys.executable} test/api/embedded-swarm-coexistence.py\n\n"
                                        + "\n\n".join(steps) + "\n")
    print(f"{verdict}: {REPORT / 'report.md'}", flush=True)
