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

import json
from pathlib import Path

import httpx
import pytest

from sciencediscovery_adapter.agent_runs import JIUWENSWARM_HOST_TOOLS, AgentRunner
from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings
from sciencediscovery_adapter.llm_proxy import rewrite_response

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

FIXTURES = Path(__file__).parent / "fixtures"
SETTINGS = Settings(host="127.0.0.1", port=4310, legacy_url="http://legacy.test",
                    gateway_url="ws://gw/tui", mgmt_url="ws://gw/ws", public_url="http://adapter.test")


def recorded(name):
    lines = [line.strip() for line in (FIXTURES / name).read_text().splitlines() if line.strip()]
    return [json.loads(line.removeprefix("ACK ")) for line in lines]


class FakeRun:
    """Stands in for gateway.ChatRun: replays a recorded run."""

    instances = []

    def __init__(self, url, params, **kwargs):
        self.url, self.params, self.cancelled = url, params, False
        FakeRun.instances.append(self)
        self.frames = recorded(FakeRun.fixture)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def cancel(self):
        self.cancelled = True

    def __aiter__(self):
        async def frames():
            for frame in self.frames:
                yield frame
        return frames()


@pytest.fixture
def harness(monkeypatch):
    FakeRun.instances = []
    FakeRun.fixture = "jw_chat_plain.raw"
    rpcs = []

    async def fake_rpc(url, method, params=None, **kwargs):
        if method == "models.list" and not rpcs and not FakeRun.instances:
            return {}  # the clean-up at start-up (see test_start_up_removes_stale_aliases), not part of a run
        rpcs.append((url, method, params))
        return {}

    app = create_app(SETTINGS)
    runner = app.state.agent_runner
    runner.chat_run = FakeRun
    runner.rpc = fake_rpc
    return app, runner, rpcs


async def post(app, body, headers=None):
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            response = await client.post("/agent/runs", json=body, headers=headers or {})
            lines = [json.loads(line) for line in response.text.splitlines() if line]
            return response, lines


async def test_streams_run_events_then_a_done_line(harness):
    app, *_ = harness
    response, lines = await post(app, {"sessionId": "s1", "prompt": "hi"})
    assert response.headers["content-type"].startswith("application/x-ndjson")
    events = [line["event"]["type"] for line in lines if "event" in line]
    assert events[0] == "agent.phase" and "assistant.delta" in events
    assert lines[-1] == {"done": {"finalText": "hello from stub", "unmapped": [], "cancelled": False}}


async def test_the_run_is_sent_to_the_gateway_with_the_session_and_prompt(harness):
    app, *_ = harness
    await post(app, {"sessionId": "s1", "prompt": "hi", "cwd": "/work"})
    params = FakeRun.instances[0].params
    assert FakeRun.instances[0].url == "ws://gw/tui"
    assert params["session_id"] == "s1" and params["content"] == "hi" and params["project_dir"] == "/work"
    assert "mcp" not in params


async def test_tools_go_to_the_one_shared_mcp_server_which_is_only_given_again_when_they_change(harness):
    app, _, rpcs = harness
    FakeRun.fixture = "jw_chat_mcp_direct.raw"
    tools = [{"name": "run_shell", "description": "d", "inputSchema": {"type": "object"}}]
    bridge = {"url": "http://legacy.test/bridge", "token": "t"}
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge})
    await post(app, {"sessionId": "s2", "prompt": "go", "tools": tools, "bridge": bridge})
    wider = [*tools, {"name": "declare_artifact", "description": "d", "inputSchema": {"type": "object"}}]
    await post(app, {"sessionId": "s3", "prompt": "go", "tools": wider, "bridge": bridge})
    mcp = [(m, p["name"]) for _, m, p in rpcs if m.startswith("mcp.")]
    # First run: any earlier registration is replaced, then connected. Second: nothing (same tools). Third: a new
    # tool arrived, and a bare reconnect does not make JiuwenSwarm re-read the tool list, so the list goes to the
    # next generation's name; the first, which no run is on any more, is then disconnected.
    second = "sci0000000001"
    assert mcp == [
        ("mcp.disconnect", "sci"), ("mcp.delete_custom", "sci"), ("mcp.register_custom", "sci"), ("mcp.connect", "sci"),
        ("mcp.disconnect", second), ("mcp.delete_custom", second), ("mcp.register_custom", second), ("mcp.connect", second),
        ("mcp.disconnect", "sci"), ("mcp.delete_custom", "sci"),
    ]
    register = next(p for _, m, p in rpcs if m == "mcp.register_custom")
    assert register["url"].startswith("http://adapter.test/mcp/") and register["transport"] == "streamable-http"
    assert [run.params["mcp"] for run in FakeRun.instances] == [["sci"], ["sci"], [second]]


async def test_new_tools_never_disconnect_the_server_a_running_run_is_calling_through(harness):
    """A `task` sub-agent's run is started while its parent's run waits on that very `task` call: the sub-agent's
    new tools must not cut the parent's call (a disconnect is global in JiuwenSwarm), or the parent hangs."""
    _, runner, rpcs = harness
    parent_tools = [{"name": "task", "description": "d", "inputSchema": {"type": "object"}}]
    child_tools = [{"name": "run_shell", "description": "d", "inputSchema": {"type": "object"}}]
    parent = await runner.ensure_shared_tools(parent_tools, 60)
    rpcs.clear()
    child = await runner.ensure_shared_tools(child_tools, 60)
    assert (parent, child) == ("sci", "sci0000000001")
    assert ("mcp.disconnect", "sci") not in [(m, p["name"]) for _, m, p in rpcs if m.startswith("mcp.")], "the parent's server stays connected"
    await runner.release_shared_tools(child)
    assert ("mcp.disconnect", "sci") not in [(m, p["name"]) for _, m, p in rpcs if m.startswith("mcp.")]
    await runner.release_shared_tools(parent)
    assert [(m, p["name"]) for _, m, p in rpcs if m.startswith("mcp.")][-2:] == [("mcp.disconnect", "sci"), ("mcp.delete_custom", "sci")]
    assert runner.registry.shared.keys() == {"task", "run_shell"}, "the newest generation serves every tool"


async def test_new_mcp_generation_retries_after_a_failed_connect(harness):
    from sciencediscovery_adapter.gateway import GatewayError

    _, runner, rpcs = harness
    first_tools = [{"name": "first", "inputSchema": {"type": "object"}}]
    wider = [*first_tools, {"name": "second", "inputSchema": {"type": "object"}}]
    first = await runner.ensure_shared_tools(first_tools, 60)
    await runner.release_shared_tools(first)
    original_rpc = runner.rpc
    failed = False

    async def fail_once(url, method, params=None, **kwargs):
        nonlocal failed
        if method == "mcp.connect" and params["name"] != first and not failed:
            failed = True
            raise GatewayError("one-time connect failure")
        return await original_rpc(url, method, params, **kwargs)

    runner.rpc = fail_once
    with pytest.raises(GatewayError, match="one-time connect failure"):
        await runner.ensure_shared_tools(wider, 60)
    assert runner._server == first
    assert set(runner.registry.shared) == {"first"}

    rpcs.clear()
    recovered = await runner.ensure_shared_tools(wider, 60)
    assert recovered != first
    assert ("mcp.connect", recovered) in [(method, params["name"]) for _, method, params in rpcs
                                           if method.startswith("mcp.")]
    await runner.release_shared_tools(recovered)


async def test_new_generations_discard_tools_from_finished_runs(harness):
    _, runner, rpcs = harness
    for index in range(20):
        tools = [{"name": f"custom_{index}", "inputSchema": {"type": "object"}}]
        server = await runner.ensure_shared_tools(tools, 60)
        await runner.release_shared_tools(server)

    assert set(runner.registry.shared) == {"custom_19"}
    assert set(runner._approval_levels) == {"custom_19"}
    approvals = [method for _, method, _ in rpcs if method == "permissions.tools.update"]
    assert len(approvals) == 20


async def test_tools_without_a_bridge_fail_the_run_cleanly(harness):
    app, _, rpcs = harness
    _, lines = await post(app, {"sessionId": "s1", "prompt": "go", "tools": [{"name": "x"}]})
    failed = [line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed"]
    assert failed and "bridge" in failed[0]["error"]
    assert [m for _, m, _ in rpcs if not m.startswith("models.")] == [] and "done" in lines[-1]


async def test_a_gateway_that_cannot_register_the_toolset_fails_the_run(harness):
    from sciencediscovery_adapter.gateway import GatewayError

    app, runner, rpcs = harness

    async def refusing(url, method, params=None, **kwargs):
        rpcs.append(method)
        if method == "mcp.connect":
            raise GatewayError("mcp.connect refused: boom")
        return {}

    runner.rpc = refusing
    _, lines = await post(app, {"sessionId": "s1", "prompt": "go", "tools": [{"name": "x"}],
                                "bridge": {"url": "http://legacy.test/b"}})
    failed = next(line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed")
    assert "mcp.connect refused" in failed["error"]
    assert "mcp.connect" in rpcs


async def test_the_token_is_enforced_when_configured(harness):
    _, runner, _ = harness
    guarded = Settings(**{**SETTINGS.__dict__, "agent_token": "secret"})
    app = create_app(guarded)
    assert (await post(app, {"sessionId": "s", "prompt": "p"}))[0].status_code == 401
    assert (await post(app, {"sessionId": "s", "prompt": "p"}, {"authorization": "Bearer wrong"}))[0].status_code == 401


async def test_bridge_calls_go_to_the_callers_url_with_its_token(harness):
    from sciencediscovery_adapter.agent_runs import Bridge, bridge_caller

    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return httpx.Response(200, json={"text": "out", "isError": True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        text, is_error = await bridge_caller(Bridge(url="http://legacy.test/bridge", token="tok"), client)("run_shell", {"command": "x"})
    assert (text, is_error) == ("out", True)
    assert seen == {"url": "http://legacy.test/bridge", "auth": "Bearer tok",
                    "body": {"name": "run_shell", "arguments": {"command": "x"}}}


async def test_closing_the_stream_cancels_the_gateway_run(harness):
    import asyncio

    from sciencediscovery_adapter.agent_runs import AgentRunRequest

    _, runner, _ = harness

    class Endless(FakeRun):
        def __aiter__(self):
            async def frames():
                yield recorded("jw_chat_plain.raw")[2]  # processing_status: the run has started
                await asyncio.Event().wait()            # ...and never ends by itself
            return frames()

    runner.chat_run = Endless
    stream = runner.stream(AgentRunRequest(sessionId="s1", prompt="go"))
    first = await anext(stream)
    assert json.loads(first)["event"]["type"] == "agent.phase"
    await stream.aclose()  # what the HTTP layer does when the client disconnects
    assert FakeRun.instances[0].cancelled is True


async def test_the_run_talks_to_a_private_alias_that_routes_to_the_real_model(harness):
    app, runner, rpcs = harness
    listed = {"models": []}

    async def rpc(url, method, params=None, **kwargs):
        rpcs.append((url, method, params))
        if method == "models.list":
            return {"models": [dict(m) for m in listed["models"]]}
        if method == "models.replace_all":
            listed["models"] = params["models"]
        return {}

    runner.rpc = rpc
    seen = {}
    original = runner.chat_run

    class Spy(original):
        def __init__(self, url, params, **kwargs):
            super().__init__(url, params, **kwargs)
            seen["alias"] = params["model_name"]
            seen["entry"] = next(m for m in listed["models"] if m["model_name"] == params["model_name"])
            seen["route"] = runner.routes.get(seen["entry"]["api_key"])

    runner.chat_run = Spy
    await post(app, {"sessionId": "s1", "prompt": "hi", "systemPrompt": "Be a scientist.",
                     "tools": [{"name": "run_shell"}], "bridge": {"url": "http://legacy.test/b"},
                     "model": {"model": "gpt-x", "baseUrl": "http://llm/v1/", "apiKey": "sk"}})
    entry, route = seen["entry"], seen["route"]
    assert seen["alias"].startswith("gpt-x-") and len(seen["alias"]) == len("gpt-x-") + 6, "named after the real model"
    assert entry["api_base"] == f"http://adapter.test/llm/{entry['api_key']}/v1"
    assert (route.base_url, route.api_key, route.model, route.system_prompt) == ("http://llm/v1", "sk", "gpt-x", "Be a scientist.")
    assert route.tool_names == frozenset({"run_shell"}) and route.tool_prefix.startswith("mcp_sci")
    # Listed tools and no hidden ones asked for: a bash call the model makes anyway still reaches nothing on the host.
    assert JIUWENSWARM_HOST_TOOLS <= route.hidden_native_tools
    chunk = {"choices": [{"delta": {"tool_calls": [{"function": {"name": "bash", "arguments": '{"command": "touch /tmp/x"}'}}]}}]}
    assert rewrite_response(chunk, route)["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "unavailable__bash"
    # after the run: the alias is gone from the list and the route is closed
    assert [m["model_name"] for m in listed["models"]] == ["sciencediscovery-default"], "only the default-model entry is left"
    assert runner.routes.get(entry["api_key"]) is None


async def test_a_protocol_other_than_openai_chat_is_refused_clearly(harness):
    app, *_ = harness
    _, lines = await post(app, {"sessionId": "s1", "prompt": "hi",
                                "model": {"model": "claude-x", "baseUrl": "http://a/v1", "provider": "Anthropic"}})
    failed = next(line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed")
    assert "Anthropic protocol is not supported" in failed["error"]


async def test_no_model_leaves_the_gateways_default_in_charge(harness):
    app, *_ = harness
    await post(app, {"sessionId": "s1", "prompt": "hi"})
    assert "model_name" not in FakeRun.instances[0].params


async def test_start_up_removes_stale_aliases_left_by_an_earlier_process():
    calls = []

    async def rpc(url, method, params=None, **kwargs):
        calls.append(method)
        if method == "models.list":
            return {"models": [{"model_name": "old", "api_base": "http://adapter.test/llm/x/v1", "is_default": False}, {"model_name": "kept", "is_default": True}]}
        return {}

    app = create_app(SETTINGS)
    app.state.agent_runner.models._rpc = rpc
    async with app.router.lifespan_context(app):
        pass
    assert calls == ["models.list", "models.replace_all", "models.list", "models.replace_all"], "the default model, then prune"


async def test_the_per_run_mcp_server_gets_a_tool_timeout_far_beyond_jiuwenswarms_30_seconds(harness):
    app, _, rpcs = harness
    FakeRun.fixture = "jw_chat_mcp_direct.raw"
    tools = [{"name": "run_shell", "description": "d", "inputSchema": {"type": "object"}}]
    bridge = {"url": "http://legacy.test/bridge", "token": "t"}
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge})
    assert next(p for _, m, p in rpcs if m == "mcp.register_custom")["timeout_s"] == 3600
    rpcs.clear()
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge, "toolTimeoutSeconds": 7200})
    assert next(p for _, m, p in rpcs if m == "mcp.register_custom")["timeout_s"] == 7200


async def test_the_session_key_names_the_jiuwenswarm_session_and_the_prompt_goes_as_it_is(harness):
    app, _, rpcs = harness
    await post(app, {"sessionId": "s1", "sessionKey": "s1--sub-7", "prompt": "hi"})
    assert FakeRun.instances[0].params["session_id"] == "s1--sub-7"
    assert FakeRun.instances[0].params["content"] == "hi"
    assert "session.get_metadata" not in [m for _, m, _ in rpcs], "the adapter does not look at JiuwenSwarm's history"


async def test_a_request_carries_no_history_field(harness):
    from sciencediscovery_adapter.agent_runs import AgentRunRequest
    assert "history" not in AgentRunRequest.model_fields



async def get(app, path, headers=None):
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            return await client.get(path, headers=headers or {})


async def test_info_says_which_backend_runs_and_whether_jiuwenswarm_answers(harness):
    app, *_ = harness
    body = (await get(app, "/agent/info")).json()
    assert body["adapter"] is True and body["executor"] == "native"
    assert body["jiuwenswarm"]["reachable"] is True and body["jiuwenswarm"]["managementUrl"] == "ws://gw/ws"
    assert body["toolTimeoutSeconds"] == 3600


async def test_info_reports_an_executor_of_jiuwenswarm_and_a_gateway_that_does_not_answer():
    # Nothing listens on the management URL of these settings, which is what a JiuwenSwarm that is down looks like.
    app = create_app(Settings(**{**SETTINGS.__dict__, "executor": "jiuwenswarm", "mgmt_url": "ws://127.0.0.1:1/ws"}))
    body = (await get(app, "/agent/info")).json()
    assert body["executor"] == "jiuwenswarm" and body["jiuwenswarm"]["reachable"] is False
    assert "unreachable" in body["jiuwenswarm"]["error"]


async def test_info_needs_a_token_when_there_is_one():
    guarded = create_app(Settings(**{**SETTINGS.__dict__, "agent_token": "secret"}))
    assert (await get(guarded, "/agent/info")).status_code == 401
    assert (await get(guarded, "/agent/info", {"authorization": "Bearer wrong"})).status_code == 401
    assert (await get(guarded, "/agent/info", {"authorization": "Bearer secret"})).status_code == 200


async def test_info_also_opens_with_the_apis_own_access_token():
    app = create_app(Settings(**{**SETTINGS.__dict__, "api_token": "api-token"}))
    assert (await get(app, "/agent/info")).status_code == 401
    assert (await get(app, "/agent/info", {"authorization": "Bearer api-token"})).status_code == 200


async def test_the_system_prompt_mode_reaches_the_route(harness):
    app, runner, _ = harness
    modes = []
    original = runner.routes.add

    def spy(route):
        modes.append((route.system_prompt, route.system_prompt_mode))
        return original(route)

    runner.routes.add = spy
    model = {"model": "m", "baseUrl": "http://llm.test/v1", "apiKey": "k"}
    await post(app, {"sessionId": "s1", "prompt": "hi", "model": model, "systemPrompt": "ours", "systemPromptMode": "append"})
    await post(app, {"sessionId": "s1", "prompt": "hi", "model": model, "systemPrompt": "ours"})
    assert modes == [("ours", "append"), ("ours", "replace")]


def test_a_model_id_becomes_a_safe_entry_name():
    from sciencediscovery_adapter.agent_runs import model_alias_base
    assert model_alias_base("DeepSeek-V4-Flash-0731") == "DeepSeek-V4-Flash-0731"
    assert model_alias_base("openai/gpt 5:latest") == "openai-gpt-5-latest"
    assert model_alias_base("///") == "model"
    assert len(model_alias_base("x" * 100)) == 48


async def post_config(app, values, headers=None):
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
            return await client.post("/agent/jiuwenswarm-config", json={"values": values}, headers=headers or {})


async def test_web_settings_are_applied_to_jiuwenswarm_with_config_set(harness):
    app, _, rpcs = harness
    values = {"free_search_ddg_enabled": "true", "bocha_api_key": "k"}
    response = await post_config(app, values)
    assert response.status_code == 200
    assert [(m, p) for _, m, p in rpcs if m == "config.set"] == [("config.set", values)]


async def test_only_web_search_settings_are_accepted(harness):
    app, _, rpcs = harness
    response = await post_config(app, {"free_search_ddg_enabled": "true", "model_name": "x"})
    assert response.status_code == 400 and "model_name" in response.json()["detail"]
    assert not [m for _, m, _ in rpcs if m == "config.set"]


async def test_the_config_route_needs_the_agent_token_when_there_is_one():
    app = create_app(Settings(**{**SETTINGS.__dict__, "agent_token": "secret"}))
    assert (await post_config(app, {"free_search_ddg_enabled": "true"})).status_code == 401


async def test_jiuwenswarms_permission_engine_is_switched_on_and_each_new_tool_gets_its_level_once(harness):
    app, _, rpcs = harness
    FakeRun.fixture = "jw_chat_mcp_direct.raw"
    bridge = {"url": "http://legacy.test/bridge", "token": "t"}
    tools = [{"name": "run_shell", "description": "d", "approval": "ask"}, {"name": "read_file", "description": "d"}]
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge})
    await post(app, {"sessionId": "s2", "prompt": "go", "tools": [*tools, {"name": "declare_claim", "description": "d"}], "bridge": bridge})
    calls = [(m, p) for _, m, p in rpcs if m in ("config.set", "permissions.tools.update")]
    # The new tool moves the tool list to the next generation of the server, whose names need every level again,
    # each still the one it was first given.
    assert calls == [
        ("config.set", {"permissions_enabled": True}),
        ("permissions.tools.update", {"tool": "mcp_sci_run_shell", "level": "ask"}),
        ("permissions.tools.update", {"tool": "mcp_sci_read_file", "level": "allow"}),
        ("permissions.tools.update", {"tool": "mcp_sci0000000001_run_shell", "level": "ask"}),
        ("permissions.tools.update", {"tool": "mcp_sci0000000001_read_file", "level": "allow"}),
        ("permissions.tools.update", {"tool": "mcp_sci0000000001_declare_claim", "level": "allow"}),
    ]


async def test_an_approval_answer_resumes_the_run_waiting_on_that_question(harness):
    from sciencediscovery_adapter.events import RunEventMapper

    app, runner, _ = harness
    answered = []

    class Waiting:
        async def answer(self, request_id, source, answer):
            answered.append((request_id, source, answer))

    mapper = RunEventMapper(session_id="s1")
    mapper._permissions["q1"] = ["本次允许", "本会话允许", "总是允许", "拒绝"]
    mapper._pending_requests["q1"] = {"id": "q1", "state": "pending"}
    runner.pending_approvals["q1"] = (Waiting(), mapper)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        ok = await client.post("/agent/approvals/q1", json={"decision": "allow_matching"})
        missing = await client.post("/agent/approvals/q1", json={"decision": "deny"})
    assert ok.status_code == 200 and missing.status_code == 404
    assert answered == [("q1", "permission_interrupt", {"selected_options": ["本会话允许"], "custom_input": "本会话允许"})]


async def test_the_language_is_set_on_the_tui_channel(harness):
    app, runner, rpcs = harness

    async def tui(url, method, params=None, **kwargs):
        rpcs.append((url, method, params))
        return {"updated": ["preferred_language"]} if method == "config.set" else {}

    runner.rpc = tui
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        ok = await client.post("/agent/language", json={"language": "en"})
        bad = await client.post("/agent/language", json={"language": "fr"})
    assert ok.status_code == 200 and bad.status_code == 422
    assert rpcs[-1] == ("ws://gw/tui", "config.set", {"preferred_language": "en"})
