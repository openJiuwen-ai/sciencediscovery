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
import re
import socket
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
        "SCIENCE_AGENT_JIUWENSWARM_OVERRIDES": "1",
        "JIUWENSWARM_ROOT": str(REPORT / "install-state")}
BASE.pop("JIUWENSWARM_DATA_DIR", None)
roots = {name: REPORT / name for name in ("standalone", "embedded")}
roots["embedded"] = REPORT / "user/.sciencediscovery/jiuwenswarm"
steps = []
children = []


def command(root, arguments, *, check=True, environment=None):
    env = {**BASE, "JIUWENSWARM_HOME": str(roots[root])}
    if root == "embedded":
        # Default SD startup must ignore a complete inherited standalone setup.
        env.update(HOME=str(REPORT / "user"), SCIENCE_AGENT_JIUWENSWARM_OVERRIDES="0",
                   JIUWENSWARM_HOME=str(roots["standalone"]), JIUWENSWARM_SRC="/foreign/install",
                   JIUWENSWARM_ROOT="/foreign/data", JIUWENSWARM_DATA_DIR=str(roots["standalone"]),
                   JIUWENSWARM_GATEWAY_URL="ws://foreign:1/tui", JIUWENSWARM_MGMT_URL="ws://foreign:2/ws",
                   JIUWENSWARM_CONTEXT_WINDOW_TOKENS="1234", AGENT_SERVER_URL="ws://foreign:1",
                   OPENAI_API_KEY="standalone-marker", JIUWENSWARM_CONFIG="/foreign/config.yaml")
    env.update(environment or {})
    result = subprocess.run(arguments, cwd=REPO,
                            env=env,
                            capture_output=True, text=True, timeout=210)
    (REPORT / f"{len(list(REPORT.glob('*-command.log'))):03d}-command.log").write_text(
        f"{root}: {' '.join(arguments)}\nexit={result.returncode}\n{result.stdout}\n{result.stderr}")
    if check:
        assert result.returncode == 0, result.stdout + result.stderr
    return result


def wrapper(root, action, **kwargs):
    if root == "standalone":
        if action == "env":
            return subprocess.CompletedProcess([], 0,
                f"export JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:{ports(root)['gateway']}/tui\n"
                f"export JIUWENSWARM_MGMT_URL=ws://127.0.0.1:{ports(root)['web']}/ws\n", "")
        result = command(root, [str(SOURCE / ".venv/bin/jiuwenswarm-start"), "--" + action, NAME], check=False)
        if action == "status" and not re.search(r"^Status:\s+running$", result.stdout, re.M):
            result.returncode = 1
        if action == "status" and result.returncode == 0:
            try:
                for service in ("agent_server", "web", "gateway"):
                    with socket.create_connection(("127.0.0.1", ports(root)[service]), timeout=1):
                        pass
            except OSError:
                result.returncode = 1
        if kwargs.get("check", True):
            assert result.returncode == 0, result.stdout + result.stderr
        return result
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
        workspace(root) / "config/.env", *workspace(root).glob("agent/workspace/skills/standalone-marker/*"))}


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
    assert (REPO / ".sciencediscovery-data/jiuwenswarm/src/.venv/bin/jiuwenswarm-start").is_file(), "BLOCKED: default SD installation is required to verify inherited install overrides are ignored"
    command("standalone", [str(SOURCE / ".venv/bin/jiuwenswarm-init"), "--name", NAME])
    config = workspace("standalone") / "config/config.yaml"
    standalone_settings = yaml.safe_load(config.read_text())
    standalone_settings["progressive_tool_enabled"] = True
    standalone_settings["react"]["agent_name"] = "standalone-marker-agent"
    standalone_settings["react"]["max_iterations"] = 7
    standalone_settings["models"]["defaults"][0]["model_client_config"].update(
        model_name="standalone-marker-model", api_base="http://127.0.0.1:9/v1", api_key="disposable-marker")
    config.write_text(yaml.safe_dump(standalone_settings, allow_unicode=True))
    skill = workspace("standalone") / "agent/workspace/skills/standalone-marker/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: standalone-marker\ndescription: Disposable standalone-only marker.\n---\nStandalone marker.\n")
    before = snapshot("standalone")
    for action in ("setup", "start", "status", "env", "stop"):
        refused = command("embedded", ["bash", "scripts/jiuwenswarm.sh", action], check=False,
                          environment={"SCIENCE_AGENT_JIUWENSWARM_OVERRIDES": "1", "JIUWENSWARM_SRC": str(SOURCE)})
        assert refused.returncode != 0 and "Refusing unowned" in refused.stderr
    assert snapshot("standalone") == before
    wrapper("embedded", "setup")
    wrapper("embedded", "setup")
    assert snapshot("standalone") == before
    assert "progressive_tool_enabled: false" in (workspace("embedded") / "config/config.yaml").read_text()
    record("1. PASS: repeated embedded setup leaves standalone registry/configuration unchanged.")
    record("1a. PASS: inherited install/home/config controls are ignored; explicit adoption of unowned standalone data is refused.")

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
        # A standalone settings edit must not change SD's active configuration,
        # endpoint identity, or session visibility while both services are live.
        embedded_before = snapshot("embedded")
        standalone_config = workspace("standalone") / "config/config.yaml"
        standalone_settings = yaml.safe_load(standalone_config.read_text())
        standalone_settings["react"]["agent_name"] = "changed-standalone-marker-agent"
        standalone_settings["models"]["defaults"][0]["model_client_config"]["model_name"] = "changed-standalone-marker-model"
        standalone_config.write_text(yaml.safe_dump(standalone_settings, allow_unicode=True))
        skill.write_text(skill.read_text() + "\nChanged standalone skill.\n")
        assert snapshot("embedded") == embedded_before
        assert not (workspace("embedded") / "agent/workspace/skills/standalone-marker").exists()
        assert "standalone-marker" not in (workspace("embedded") / "config/config.yaml").read_text()
        assert created["embedded"] in json.dumps(asyncio.run(session("embedded", "session.list")))
        record(f"2. PASS ({first} first): independent live PIDs, ports, endpoints and session lists.")
        wrapper("embedded", "start")  # idempotent while both are live
        stop(second)
        wrapper(first, "status")
        assert (workspace(first) / ".instance.pid").read_bytes() == first_pid
        assert wrapper(second, "status", check=False).returncode != 0
        stop(first)
        record(f"3. PASS ({second} stopped first): sibling stays live; selected instance stops.")
    assert (roots["embedded"] / f"jiuwenswarm-{NAME}.log").is_file()
    custom = REPORT / "custom-sd-runtime"
    custom_env = {"SCIENCE_AGENT_JIUWENSWARM_OVERRIDES": "1", "JIUWENSWARM_HOME": str(custom),
                  "JIUWENSWARM_SRC": str(SOURCE), "JIUWENSWARM_ROOT": str(REPORT / "install-state"),
                  "JIUWENSWARM_CONTEXT_WINDOW_TOKENS": "32768"}
    try:
        start("standalone")
        standalone_before = snapshot("standalone")
        invalid = command("embedded", ["bash", "scripts/jiuwenswarm.sh", "setup"], check=False,
                          environment={**custom_env, "JIUWENSWARM_CONTEXT_WINDOW_TOKENS": "invalid"})
        assert invalid.returncode != 0 and "must be a positive integer" in invalid.stderr
        for action in ("setup", "setup", "start", "status", "env"):
            command("embedded", ["bash", "scripts/jiuwenswarm.sh", action], environment=custom_env)
        assert (custom / ".sciencediscovery-owned").read_text().strip() == "sciencediscovery"
        config = yaml.safe_load((custom / ".jiuwenswarm-instances" / NAME / "config/config.yaml").read_text())
        assert config["react"]["context_engine_config"]["context_window_tokens"] == 32768
        command("embedded", ["bash", "scripts/jiuwenswarm.sh", "stop"], environment=custom_env)
        wrapper("standalone", "status")
        assert snapshot("standalone") == standalone_before
        record("4. PASS: explicit fresh SD root supports repeated setup/start/status/env/stop and SD config changes without changing or stopping standalone.")
    finally:
        command("embedded", ["bash", "scripts/jiuwenswarm.sh", "stop"], environment=custom_env, check=False)
        stop("standalone")
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
