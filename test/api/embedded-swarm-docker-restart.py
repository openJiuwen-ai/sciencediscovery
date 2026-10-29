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

"""Verify the documented Docker bind mount survives a container restart.

Run: SCIENCE_AGENT_IMAGE=sciencediscovery:local python3 test/api/embedded-swarm-docker-restart.py
Repeat with SWARM_DOCKER_CUSTOM_HOME=1 to verify the explicit persisted override.

E2E-META
Purpose: Retain embedded Swarm identity/config/sessions across a Docker restart.
Steps: Start Compose; seed standalone data and an embedded session/config marker;
       restart the same container; check persistence and standalone non-interference.
Environment: Linux Docker Engine and Compose, locally built image at the current SHA.
Type: Docker/CLI journey with real services; no model calls.
External capabilities: None at runtime; image must already be built.
Credentials: None; the stack generates its own disposable access token.
Cost/side effects: One isolated Compose project, loopback port and disposable bind mounts.
Reports: .tmp/swarm-docker-restart-*/report.md and redacted command logs.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time


REPO = Path(__file__).resolve().parents[2]
(REPO / ".tmp").mkdir(exist_ok=True)
REPORT = Path(tempfile.mkdtemp(prefix="swarm-docker-restart-", dir=REPO / ".tmp"))
DATA = REPORT / "data"
STANDALONE = REPORT / "standalone"
DATA.mkdir()
STANDALONE.mkdir()
PROJECT = "sd-restart-" + REPORT.name.rsplit("-", 1)[-1]
CUSTOM = os.environ.get("SWARM_DOCKER_CUSTOM_HOME") == "1"
RUNTIME = "/app/data/custom-sd-runtime" if CUSTOM else "/app/data/.home"
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    PORT = listener.getsockname()[1]
ENV = {**os.environ, "SCIENCE_AGENT_IMAGE": os.environ.get("SCIENCE_AGENT_IMAGE", "sciencediscovery:local"),
       "SCIENCE_AGENT_DATA_HOST_DIR": str(DATA), "SCIENCE_AGENT_UID": str(os.getuid()),
       "SCIENCE_AGENT_GID": str(os.getgid()), "SCIENCE_AGENT_PUBLISH_PORT": str(PORT), "SCIENTIFIC_ENVS": "0"}
ENV.update(SCIENCE_AGENT_JIUWENSWARM_OVERRIDES="1" if CUSTOM else "0",
           JIUWENSWARM_HOME=RUNTIME if CUSTOM else "/standalone")
OVERRIDE = REPORT / "compose.json"
OVERRIDE.write_text(json.dumps({"services": {"sciencediscovery": {
    "volumes": [f"{STANDALONE}:/standalone"],
    "environment": {"SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED": "0"}}}}))
COMPOSE = ["docker", "compose", "-p", PROJECT, "-f", str(REPO / "docker-compose.yml"), "-f", str(OVERRIDE)]
steps = []
sequence = 0


def command(args, timeout=240, check=True):
    global sequence
    result = subprocess.run(args, cwd=REPO, env=ENV, text=True, capture_output=True, timeout=timeout)
    output = result.stdout + result.stderr
    # Startup may print a generated bearer token; evidence must not publish it.
    token = DATA / "secrets/auth-token"
    if token.exists() and token.read_text().strip():
        output = output.replace(token.read_text().strip(), "[REDACTED]")
    output = re.sub(r"(?i)(token=)[^\s]+", r"\1[REDACTED]", output)
    (REPORT / f"{sequence:03d}-command.log").write_text(f"{' '.join(args)}\nexit={result.returncode}\n{output}")
    sequence += 1
    if check:
        assert result.returncode == 0, output[-5000:]
    return result.stdout.strip()


def compose(*args, **kwargs):
    return command([*COMPOSE, *args], **kwargs)


def inside(script):
    # docker exec does not inherit exports made by the entrypoint's shell.
    return compose("exec", "-T", "sciencediscovery", "bash", "-ec",
                   f'export HOME=/app/data/.home JIUWENSWARM_HOME={RUNTIME} '
                   'JIUWENSWARM_ROOT=/app/data/jiuwenswarm SCIENCE_AGENT_JIUWENSWARM_OVERRIDES=1; ' + script)


def ready():
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        result = subprocess.run([*COMPOSE, "exec", "-T", "sciencediscovery", "curl", "-fsS",
                                 "http://127.0.0.1:4310/health"], cwd=REPO, env=ENV,
                                capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            inside("scripts/jiuwenswarm.sh status")
            return
        time.sleep(2)
    raise AssertionError("Stack did not become ready within 300s")


def rpc(method, params=None):
    script = f"""
import asyncio, json, sys
sys.path.insert(0, '/app/services/adapter/src')
from sciencediscovery_adapter.gateway import rpc
print(json.dumps(asyncio.run(rpc('{gateway}', '{method}', {params!r}, timeout=40))))
"""
    return json.loads(compose("exec", "-T", "sciencediscovery",
                              "/opt/sciencediscovery/envs/adapter/bin/python", "-c", script))


def snapshot(root):
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


verdict = "FAIL"
image_id = "unavailable"
try:
    metadata = json.loads(command(["docker", "image", "inspect", ENV["SCIENCE_AGENT_IMAGE"]]))[0]
    image_id = metadata["Id"]
    compose("up", "-d", "--no-build", "--pull", "never")
    ready()
    container = compose("ps", "-q", "sciencediscovery")
    identity = inside("printf '%s\\n' \"$HOME\"; scripts/jiuwenswarm.sh env")
    assert identity.splitlines()[0] == "/app/data/.home", identity
    gateway = next(line.split("=", 1)[1] for line in identity.splitlines() if "GATEWAY_URL=" in line)
    runtime = DATA / Path(RUNTIME).relative_to("/app/data")
    workspace = runtime / ".jiuwenswarm-instances/sciencediscovery"
    registry = runtime / ".jiuwenswarm/instances.yaml"
    registry_before = registry.read_bytes()
    assert f"{RUNTIME}/.jiuwenswarm-instances/sciencediscovery".encode() in registry_before
    config = workspace / "config/config.yaml"
    marker = "# SD persisted-volume restart marker: " + PROJECT
    config.write_text(config.read_text() + "\n" + marker + "\n")
    created = rpc("session.create", {"mode": "react", "persist_session": True})["session_id"]
    assert created in json.dumps(rpc("session.list"))
    steps.append(f"1. PASS: embedded registry/workspace use {RUNTIME}; persisted session and config marker created.")
    inside('HOME=/standalone JIUWENSWARM_HOME=/standalone JIUWENSWARM_DATA_DIR=/standalone/.jiuwenswarm '
           '/opt/sciencediscovery/jiuwenswarm/src/.venv/bin/jiuwenswarm-init --name sciencediscovery >/dev/null')
    standalone_before = snapshot(STANDALONE)
    assert standalone_before, "Standalone fixture is empty"
    steps.append("2. PASS: a distinct standalone registry and same-name workspace exist on a separate bind mount.")
    compose("restart", "--timeout", "30", "sciencediscovery")
    ready()
    assert compose("ps", "-q", "sciencediscovery") == container
    assert inside("printf '%s\\n' \"$HOME\"; scripts/jiuwenswarm.sh env") == identity
    assert registry.read_bytes() == registry_before
    assert marker in config.read_text()
    assert created in json.dumps(rpc("session.list"))
    assert snapshot(STANDALONE) == standalone_before
    steps.append("3. PASS: same container/endpoints/registry after restart; config marker and session survive; standalone files unchanged.")
    verdict = "PASS"
except Exception as error:
    steps.append(f"{type(error).__name__}: {error}")
    raise
finally:
    compose("logs", "--no-color", check=False)
    compose("down", "--timeout", "30", check=False)
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    (REPORT / "report.md").write_text(f"# Docker embedded Swarm restart: {verdict}\n\nDriver SHA: {sha}\n\n"
        f"Product image source SHA: {os.environ.get('SWARM_IMAGE_REVISION', 'UNVERIFIED; exploratory run')}\n\n"
        f"Image: {ENV['SCIENCE_AGENT_IMAGE']} ({image_id})\n\nProject: {PROJECT}; published loopback port: {PORT}\n\n"
        f"Runtime root: {RUNTIME}; explicit override: {CUSTOM}\n\n"
        "Command: SCIENCE_AGENT_IMAGE=<built image> python3 test/api/embedded-swarm-docker-restart.py\n\n"
        + "\n\n".join(steps) + "\n\nStandalone config/state were co-tested; a live standalone service was not started.\n")
    print(f"{verdict}: {REPORT / 'report.md'}", flush=True)
