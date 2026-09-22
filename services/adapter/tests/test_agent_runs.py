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

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from sciencediscovery_adapter.agent_runs import AgentRunner, stream_with_keepalive
from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings

FIXTURES = Path(__file__).parent / "fixtures"
SETTINGS = Settings(host="127.0.0.1", port=4310, legacy_url="http://legacy.test",
                    gateway_url="ws://gw/tui", mgmt_url="ws://gw/ws", public_url="http://adapter.test")


async def test_keepalive_does_not_cancel_pending_tool_or_fabricate_progress():
    release = asyncio.Event()
    closed = asyncio.Event()

    async def source():
        try:
            await release.wait()
            yield '{"done":{"finalText":"ok"}}\n'
        finally:
            closed.set()

    stream = stream_with_keepalive(source(), interval=0.01)
    try:
        assert await asyncio.wait_for(anext(stream), 1) == "\n"
        assert not closed.is_set()
        release.set()
        assert json.loads(await asyncio.wait_for(anext(stream), 1))["done"]["finalText"] == "ok"
    finally:
        await stream.aclose()
    assert closed.is_set()


async def test_closing_keepalive_cancels_pending_source_and_finalizes_it():
    closed = asyncio.Event()

    async def source():
        try:
            await asyncio.Event().wait()
            yield "unreachable"
        finally:
            closed.set()

    stream = stream_with_keepalive(source(), interval=0.01)
    assert await asyncio.wait_for(anext(stream), 1) == "\n"
    await asyncio.wait_for(stream.aclose(), 1)
    assert closed.is_set()


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
    assert lines[-1] == {"done": {"status": "completed", "finalText": "hello from stub", "unmapped": [], "cancelled": False}}


async def test_truncated_gateway_stream_is_failure_not_success(harness):
    app, runner, _ = harness
    class Truncated(FakeRun):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.frames = []
    runner.chat_run = Truncated
    _, lines = await post(app, {"sessionId": "s", "prompt": "go"})
    failed = [line["event"] for line in lines if line.get("event", {}).get("type") == "run.failed"]
    assert len(failed) == 1
    assert "without a terminal event" in failed[0]["error"]
    assert lines[-1]["done"]["status"] == "failed"



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
    mcp = [(m, p) for _, m, p in rpcs if m.startswith("mcp.")]
    # First run: any earlier registration is replaced, then connected. Second: nothing (same tools). Third: reconnect.
    assert [m for m, _ in mcp] == ["mcp.disconnect", "mcp.delete_custom", "mcp.register_custom", "mcp.connect", "mcp.connect"]
    assert all(p["name"] == "sci" for _, p in mcp)
    register = next(p for m, p in mcp if m == "mcp.register_custom")
    assert register["url"].startswith("http://adapter.test/mcp/") and register["transport"] == "streamable-http"
    assert all(run.params["mcp"] == ["sci"] for run in FakeRun.instances)


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


async def test_the_run_binds_a_private_route_without_registering_a_model_alias(harness):
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
            seen["entry"] = params["run_model"]
            seen["route"] = runner.routes.get(seen["entry"]["api_key"])

    runner.chat_run = Spy
    await post(app, {"sessionId": "s1", "prompt": "hi", "systemPrompt": "Be a scientist.",
                     "tools": [{"name": "run_shell"}], "bridge": {"url": "http://legacy.test/b"},
                     "model": {"model": "gpt-x", "baseUrl": "http://llm/v1/", "apiKey": "sk"}})
    entry, route = seen["entry"], seen["route"]
    assert seen["alias"] == "gpt-x", "routing identity must not change the model name"
    assert entry["api_base"] == f"http://adapter.test/llm/{entry['api_key']}/v1"
    assert (route.base_url, route.api_key, route.model, route.system_prompt) == ("http://llm/v1", "sk", "gpt-x", "Be a scientist.")
    assert route.tool_names == frozenset({"run_shell"}) and route.tool_prefix.startswith("mcp_sci")
    # Only startup bootstraps the default; no run-level global registration.
    replacements = [p for _, m, p in rpcs if m == "models.replace_all"]
    assert len(replacements) == 1
    assert [m["model_name"] for m in listed["models"]] == ["sciencediscovery-default"], "only the default-model entry is left"
    assert runner.routes.get(entry["api_key"]) is None


async def test_concurrent_same_model_runs_have_isolated_routes_and_no_catalog_writes(harness):
    from sciencediscovery_adapter.agent_runs import AgentRunRequest
    _, runner, rpcs = harness
    ready = asyncio.Event()
    checked = asyncio.Event()
    checks = []
    bindings = []
    class Concurrent(FakeRun):
        async def __aenter__(self):
            bindings.append(self.params["run_model"])
            if len(bindings) == 2:
                ready.set()
            await asyncio.wait_for(ready.wait(), 2)
            assert all(runner.routes.get(b["api_key"]) is not None for b in bindings)
            checks.append(True)
            if len(checks) == 2:
                checked.set()
            await asyncio.wait_for(checked.wait(), 2)
            return self
    runner.chat_run = Concurrent
    async def execute(sid):
        request = AgentRunRequest(sessionId=sid, prompt="go", model={
            "model": "same-model", "baseUrl": "http://llm/v1", "apiKey": "fixture"})
        return [json.loads(line) async for line in runner.stream(request)]
    results = await asyncio.gather(execute("child-a"), execute("child-b"))
    assert all("done" in result[-1] for result in results)
    assert {b["model_name"] for b in bindings} == {"same-model"}
    assert bindings[0]["api_key"] != bindings[1]["api_key"]
    assert not any(method.startswith("models.") for _, method, _ in rpcs)
    assert all(runner.routes.get(b["api_key"]) is None for b in bindings)


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
    assert calls == [
        ("config.set", {"permissions_enabled": True}),
        ("permissions.tools.update", {"tool": "mcp_sci_run_shell", "level": "ask"}),
        ("permissions.tools.update", {"tool": "mcp_sci_read_file", "level": "allow"}),
        ("permissions.tools.update", {"tool": "mcp_sci_declare_claim", "level": "allow"}),
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


@pytest.mark.parametrize("cancelled, expected", [(False, 502), (True, 200)])
async def test_approval_delivery_failure_is_visible_unless_already_cancelled(harness, cancelled, expected):
    from sciencediscovery_adapter.events import RunEventMapper
    from sciencediscovery_adapter.gateway import GatewayError
    app, runner, _ = harness
    class Broken:
        async def answer(self, *args):
            raise GatewayError("closed")
    mapper = RunEventMapper(session_id="s1")
    mapper._cancel_requested = cancelled
    mapper._permissions["q1"] = ["本次允许", "拒绝"]
    mapper._pending_requests["q1"] = {"id": "q1", "state": "pending"}
    runner.pending_approvals["q1"] = (Broken(), mapper)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        response = await client.post("/agent/approvals/q1", json={"decision": "allow_once"})
    assert response.status_code == expected
