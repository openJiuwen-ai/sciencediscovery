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
"""Opt-in: a real model behind /agent/runs, a real JiuwenSwarm gateway, a fake bridge.

    REAL_LLM_BASE_URL=https://host/v1 REAL_LLM_MODEL=... REAL_LLM_KEY=... \
    JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:20001/tui JIUWENSWARM_MGMT_URL=ws://127.0.0.1:20000/ws \
    pytest tests/test_real_llm.py

The key is only ever read from the environment. Wording and tool choice vary
between runs, so the assertions are about the loop working, not about text.
"""

import asyncio
import json
import os
import socket
import uuid

import httpx
import pytest
import uvicorn
from fastapi import FastAPI

from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings

BASE = os.environ.get("REAL_LLM_BASE_URL")
MODEL = os.environ.get("REAL_LLM_MODEL")
KEY = os.environ.get("REAL_LLM_KEY")
GATEWAY = os.environ.get("JIUWENSWARM_GATEWAY_URL")
MGMT = os.environ.get("JIUWENSWARM_MGMT_URL")
# Out of the shared plan: a live model and a live gateway, selected on purpose.
pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'), model='real', status='external')


def live() -> None:
    """Fail — never skip — when the model or the gateway this test drives is not configured."""
    if not all((BASE, MODEL, KEY, GATEWAY, MGMT)):
        pytest.fail("needs REAL_LLM_BASE_URL, REAL_LLM_MODEL, REAL_LLM_KEY, JIUWENSWARM_GATEWAY_URL and "
                    "JIUWENSWARM_MGMT_URL", pytrace=False)

TOOLS = [{
    "name": "run_shell", "description": "Run a shell command in the session workspace and return its output.",
    "inputSchema": {"type": "object", "properties": {"command": {"type": "string", "description": "The command."}},
                    "required": ["command"]},
}]


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def serve(app, port):
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    return server, task


async def run_agent(prompt, session, calls, *, timeout=180):
    bridge = FastAPI()

    @bridge.post("/bridge")
    async def bridge_call(body: dict):
        calls.append(body)
        return {"text": "REAL-MARKER-4242\n", "isError": False}

    adapter_port, bridge_port = free_port(), free_port()
    settings = Settings(host="127.0.0.1", port=adapter_port, legacy_url="http://127.0.0.1:1", gateway_url=GATEWAY,
                        mgmt_url=MGMT, public_url=f"http://127.0.0.1:{adapter_port}")
    servers = [await serve(create_app(settings), adapter_port), await serve(bridge, bridge_port)]
    body = {
        "sessionId": session, "prompt": prompt, "tools": TOOLS,
        "systemPrompt": "You are a careful research assistant. Use the run_shell tool to run commands; never guess their output.",
        "bridge": {"url": f"http://127.0.0.1:{bridge_port}/bridge", "token": "t"},
        "model": {"model": MODEL, "baseUrl": BASE, "apiKey": KEY},
    }
    lines = []
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"http://127.0.0.1:{adapter_port}/agent/runs", json=body) as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    if line:
                        lines.append(json.loads(line))
    finally:
        for server, task in servers:
            server.should_exit = True
            await task
    return lines


def summarize(lines):
    return [line["event"]["type"] if "event" in line else "done" for line in lines]


async def test_a_real_model_uses_the_tool_and_answers_from_its_output():
    live()
    calls = []
    lines = await run_agent(
        "Run the shell command `cat marker.txt` and tell me exactly what it printed.", f"real-{uuid.uuid4().hex[:8]}", calls)
    failed = [line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed"]
    assert not failed, failed
    assert calls, summarize(lines)
    assert all(call["name"] == "run_shell" for call in calls)  # the real name, not mcp_<server>_run_shell
    assert any("marker" in call["arguments"].get("command", "") for call in calls), calls
    started = [line["event"]["trace"] for line in lines if line.get("event", {}).get("type") == "tool.started"]
    assert started and started[0]["name"] == "run_shell"
    final = lines[-1]["done"]["finalText"]
    assert "REAL-MARKER-4242" in final, final
    assert lines[-1]["done"]["unmapped"] == []


async def test_a_real_model_keeps_the_conversation_across_turns():
    live()
    session = f"real-{uuid.uuid4().hex[:8]}"
    await run_agent("Remember this codeword for later: PELICAN-77. Just acknowledge it.", session, [])
    lines = await run_agent("What was the codeword I asked you to remember?", session, [])
    assert "PELICAN-77" in lines[-1]["done"]["finalText"], lines[-1]
