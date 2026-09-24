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
"""Opt-in: talks to a real JiuwenSwarm gateway whose model is the scripted stub.

    JIUWENSWARM_GATEWAY_URL=ws://127.0.0.1:20001/tui pytest tests/test_gateway_live.py

The stub (tests/stub_llm.py) must be serving the gateway's configured model.
JIUWENSWARM_LIVE_SCENARIO selects the scenario, and the stub must be freshly
started for it (its script is consumed one turn per request):

    plain  no STUB_LLM_SCRIPT; the stub answers "hello from stub"
    bash   STUB_LLM_SCRIPT=tests/fixtures/stub_script_bash.json
    approval  STUB_LLM_SCRIPT=tests/fixtures/stub_script_approval.json (user allows)
    deny      the same script (user denies)
    cancel    STUB_LLM_SCRIPT=tests/fixtures/stub_script_slow.json
    agent_run / agent_run_slow  STUB_LLM_SCRIPT=tests/fixtures/stub_script_agent_run.json, same env as mcp, plus
              STUB_LLM_LOG and STUB_LLM_BASE_URL (http://127.0.0.1:<stub>/v1) to also check the
              model reaches the provider (the server name is generated per run, so the script names the tool as ~run_shell)
    agent_run_recover  STUB_LLM_SCRIPT=tests/fixtures/stub_script_agent_run_recover.json; the first bridge
              call exceeds a one-second MCP timeout, then a second run proves the shared client recovered
    mcp       STUB_LLM_SCRIPT=tests/fixtures/stub_script_mcp_live.json, plus
              JIUWENSWARM_MGMT_URL=ws://127.0.0.1:<web port>/ws and an instance with
              `progressive_tool_enabled: false` (MCP tools are then direct tools)

The instance must run with `permissions.enabled: true` and `tools.bash: ask`
(the approval scenario runs `touch`, which the engine does not auto-allow; the
bash scenario runs `echo`/`pwd`, which it does).
"""

import asyncio
import json
import os
import uuid

import pytest

from sciencediscovery_adapter.events import RunEventMapper
from sciencediscovery_adapter.gateway import ChatRun, chat, rpc
from sciencediscovery_adapter.mcp_server import Toolset, ToolsetRegistry, mcp_router

URL = os.environ.get("JIUWENSWARM_GATEWAY_URL")
SCENARIO = os.environ.get("JIUWENSWARM_LIVE_SCENARIO", "plain")
# Out of the shared plan: it needs a live gateway and a stub scripted for one
# scenario, so it runs only when somebody selects it on purpose.
pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'), status='external')


def live(*scenarios: str) -> None:
    """Fail — never skip — when the gateway or the stub's scenario is not this test's.

    A selected case has to run, so a missing gateway or a stub loaded for another
    scenario is a failure that says what to set. Run one scenario at a time, e.g.
    ``JIUWENSWARM_LIVE_SCENARIO=bash pytest tests/test_gateway_live.py -k tool_round``.
    """
    if not URL:
        pytest.fail("needs a live JiuwenSwarm gateway: set JIUWENSWARM_GATEWAY_URL", pytrace=False)
    if SCENARIO not in scenarios:
        pytest.fail(f"needs the stub scripted for {' or '.join(scenarios)}, "
                    f"but JIUWENSWARM_LIVE_SCENARIO={SCENARIO}; select one scenario with -k", pytrace=False)


def params(session_id: str, text: str) -> dict:
    return {
        "session_id": session_id, "content": text, "query": text,
        "mode": "agent.work.normal", "cwd": "/tmp", "project_dir": "/tmp", "trusted_dirs": ["/tmp"],
        "supports_user_interaction": False, "agent_ref": {"mode": "agent.work.normal", "id": "default"},
    }


async def test_real_gateway_reply_maps_to_a_completed_run():
    live("plain")
    mapper = RunEventMapper()
    events = []
    async for frame in chat(URL, params(f"live-{uuid.uuid4().hex[:8]}", "say hi"), idle_timeout=60):
        events.extend(mapper.feed(frame))
    assert mapper.final_text == "hello from stub"
    assert events[0]["type"] == "agent.phase"
    assert "".join(e["delta"] for e in events if e["type"] == "assistant.delta") == "hello from stub"
    assert mapper.unmapped == []


async def test_real_gateway_tool_round_maps_to_tool_events():
    live("bash")
    mapper = RunEventMapper()
    events = []
    async for frame in chat(URL, params(f"live-{uuid.uuid4().hex[:8]}", "run it"), idle_timeout=60):
        events.extend(mapper.feed(frame))
    kinds = [e["type"] for e in events]
    assert kinds[:6] == ["agent.phase", "assistant.response.started", "assistant.response.settled",
                         "tool.started", "tool.output", "tool.completed"]
    completed = next(e for e in events if e["type"] == "tool.completed")["trace"]
    assert completed["status"] == "completed" and "J-MARK-1" in completed["output"]
    assert mapper.final_text == "tool finished ok"
    assert mapper.unmapped == []


async def test_real_gateway_approval_round_trip():
    live("approval", "deny")
    decision = "deny" if SCENARIO == "deny" else "allow_once"
    session = f"live-{uuid.uuid4().hex[:8]}"
    mapper = RunEventMapper(session_id=session)
    events = []
    async with ChatRun(URL, params(session, "run it"), idle_timeout=60) as run:
        async for frame in run:
            new = mapper.feed(frame)
            events.extend(new)
            if any(e["type"] == "permission.required" for e in new):
                request_id = next(e["request"]["id"] for e in new if e["type"] == "permission.required")
                answer, resolved = mapper.decide(request_id, decision)
                events.append(resolved)
                await run.answer(request_id, "permission_interrupt", answer)
    kinds = [e["type"] for e in events]
    assert kinds.index("permission.required") < kinds.index("permission.resolved") < kinds.index("tool.started")
    status = next(e for e in events if e["type"] == "tool.completed")["trace"]["status"]
    assert status == ("failed" if decision == "deny" else "completed")
    assert mapper.final_text == "approved and done"
    assert mapper.finished and mapper.unmapped == []


async def test_real_gateway_cancel_ends_the_run_as_cancelled():
    live("cancel")
    session = f"live-{uuid.uuid4().hex[:8]}"
    mapper = RunEventMapper(session_id=session)
    events = []
    async with ChatRun(URL, params(session, "go"), idle_timeout=30) as run:
        async for frame in run:
            events.extend(mapper.feed(frame))
            if mapper.turn == 1 and not mapper._cancel_requested:
                await asyncio.sleep(2)  # let the model call start
                mapper.request_cancel()
                await run.cancel()
    assert events[-1]["type"] == "run.cancelled"
    assert mapper.finished and mapper.unmapped == []


async def test_real_gateway_calls_a_tool_hosted_by_the_adapter():
    live("mcp")
    import socket

    import uvicorn
    from fastapi import FastAPI

    mgmt = os.environ["JIUWENSWARM_MGMT_URL"]
    calls = []

    async def call(name, arguments):
        calls.append((name, arguments))
        return f"bridge ran: {arguments['command']}", False

    registry = ToolsetRegistry()
    token = registry.add(Toolset(call=call, tools=[{
        "name": "run_shell", "description": "Run a shell command in the session workspace.",
        "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
    }]))
    app = FastAPI()
    app.include_router(mcp_router(registry))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    name = "scilive"
    try:
        await rpc(mgmt, "mcp.register_custom", {"name": name, "transport": "streamable-http", "url": f"http://127.0.0.1:{port}/mcp/{token}"})
        await rpc(mgmt, "mcp.connect", {"name": name})
        session = f"live-{uuid.uuid4().hex[:8]}"
        mapper = RunEventMapper(session_id=session, mcp_prefixes=(f"mcp_{name}_",))
        events = []
        async with ChatRun(URL, {**params(session, "use the tool"), "mcp": [name]}, idle_timeout=60) as run:
            async for frame in run:
                events.extend(mapper.feed(frame))
    finally:
        for method in ("mcp.disconnect", "mcp.delete_custom"):
            try:
                await rpc(mgmt, method, {"name": name})
            except Exception:
                pass
        server.should_exit = True
        await serving
    assert calls == [("run_shell", {"command": "echo J-LIVE-1"})]
    started = next(e for e in events if e["type"] == "tool.started")["trace"]
    assert started["name"] == "run_shell"
    completed = next(e for e in events if e["type"] == "tool.completed")["trace"]
    assert completed["status"] == "completed" and "bridge ran: echo J-LIVE-1" in completed["output"]
    assert mapper.final_text == "live mcp done" and mapper.finished



async def test_agent_runs_endpoint_drives_a_real_run_through_its_own_toolset():
    live("agent_run")
    import socket

    import httpx
    import uvicorn
    from fastapi import FastAPI

    from sciencediscovery_adapter.app import create_app
    from sciencediscovery_adapter.config import Settings

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

    bridge_calls = []
    bridge = FastAPI()

    @bridge.post("/bridge")
    async def bridge_call(body: dict):
        bridge_calls.append(body)
        if SCENARIO == "agent_run_slow":
            # Regression: JiuwenSwarm used its 30 s fallback even though the
            # adapter registered this server with a longer timeout.
            await asyncio.sleep(31)
        return {"text": f"bridge ran: {body['arguments']['command']}", "isError": False}

    adapter_port, bridge_port = free_port(), free_port()
    settings = Settings(
        host="127.0.0.1", port=adapter_port, legacy_url="http://127.0.0.1:1", gateway_url=URL,
        mgmt_url=os.environ["JIUWENSWARM_MGMT_URL"], public_url=f"http://127.0.0.1:{adapter_port}",
    )
    adapter_server, adapter_task = await serve(create_app(settings), adapter_port)
    bridge_server, bridge_task = await serve(bridge, bridge_port)
    try:
        body = {
            "sessionId": f"live-{uuid.uuid4().hex[:8]}", "prompt": "use the tool",
            "tools": [{"name": "run_shell", "description": "Run a shell command.",
                       "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}],
            "bridge": {"url": f"http://127.0.0.1:{bridge_port}/bridge", "token": "t"},
            "toolTimeoutSeconds": 60,
        }
        stub_log, stub_base = os.environ.get("STUB_LLM_LOG"), os.environ.get("STUB_LLM_BASE_URL")
        if stub_log and stub_base:  # also prove the requested model reaches the provider
            body["model"] = {"model": "live-model-x", "baseUrl": stub_base, "apiKey": "live-key"}
        lines = []
        async with httpx.AsyncClient(timeout=90) as client:
            async with client.stream("POST", f"http://127.0.0.1:{adapter_port}/agent/runs", json=body) as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    if line:
                        lines.append(json.loads(line))
    finally:
        for server, task in ((adapter_server, adapter_task), (bridge_server, bridge_task)):
            server.should_exit = True
            await task
    events = [line["event"] for line in lines if "event" in line]
    tool_events = [e for e in events if e["type"].startswith("tool.")]
    assert bridge_calls == [{"name": "run_shell", "arguments": {"command": "echo J-LIVE-1"}}], tool_events
    completed = next(e for e in events if e["type"] == "tool.completed")["trace"]
    assert completed["name"] == "run_shell" and "bridge ran: echo J-LIVE-1" in completed["output"]
    assert lines[-1]["done"]["finalText"] == "live mcp done"
    assert lines[-1]["done"]["unmapped"] == []
    if stub_log and stub_base:
        with open(stub_log) as log:
            assert {json.loads(row).get("model") for row in log if row.strip()} == {"live-model-x"}


async def test_a_timed_out_mcp_call_does_not_poison_the_next_agent_run():
    live("agent_run_recover")
    import socket

    import httpx
    import uvicorn
    from fastapi import FastAPI

    from sciencediscovery_adapter.app import create_app
    from sciencediscovery_adapter.config import Settings

    def free_port():
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    calls = 0
    bridge = FastAPI()

    @bridge.post("/bridge")
    async def bridge_call(body: dict):
        nonlocal calls
        calls += 1
        command = body["arguments"]["command"]
        if calls == 1:
            await asyncio.sleep(2)
        return {"text": f"bridge ran: {command}", "isError": False}

    async def serve(app, port):
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
        task = asyncio.create_task(server.serve())
        while not server.started:
            await asyncio.sleep(0.05)
        return server, task

    adapter_port, bridge_port = free_port(), free_port()
    settings = Settings(host="127.0.0.1", port=adapter_port, legacy_url="http://127.0.0.1:1", gateway_url=URL,
                        mgmt_url=os.environ["JIUWENSWARM_MGMT_URL"], public_url=f"http://127.0.0.1:{adapter_port}")
    adapter_server, adapter_task = await serve(create_app(settings), adapter_port)
    bridge_server, bridge_task = await serve(bridge, bridge_port)
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            outputs = []
            for index in range(2):
                body = {
                    "sessionId": f"recover-{index}-{uuid.uuid4().hex[:8]}", "prompt": "use the tool",
                    "tools": [{"name": "run_shell", "description": "Run a shell command.",
                               "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}],
                    "bridge": {"url": f"http://127.0.0.1:{bridge_port}/bridge", "token": "t"},
                    "toolTimeoutSeconds": 1,
                    "model": {"model": "live-model-x", "baseUrl": os.environ["STUB_LLM_BASE_URL"], "apiKey": "live-key"},
                }
                lines = []
                async with client.stream("POST", f"http://127.0.0.1:{adapter_port}/agent/runs", json=body) as response:
                    async for line in response.aiter_lines():
                        if line:
                            lines.append(json.loads(line))
                outputs.append(lines)
        assert any(line.get("done", {}).get("finalText") == "second call completed" for line in outputs[1])
        completed = [line["event"] for line in outputs[1] if line.get("event", {}).get("type") == "tool.completed"]
        assert any(event["trace"]["status"] == "completed" and "SECOND" in event["trace"]["output"] for event in completed)
    finally:
        for server, task in ((adapter_server, adapter_task), (bridge_server, bridge_task)):
            server.should_exit = True
            await task
