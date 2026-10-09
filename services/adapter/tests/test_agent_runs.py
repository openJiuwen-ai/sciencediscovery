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

from sciencediscovery_adapter.agent_runs import JIUWENSWARM_HOST_TOOLS, AgentRunner, stream_with_keepalive
from sciencediscovery_adapter.app import create_app
from sciencediscovery_adapter.config import Settings
from sciencediscovery_adapter.llm_proxy import rewrite_response

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

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


async def test_bound_tools_map_skill_paths_and_keep_run_timeout_and_context(harness):
    app, runner, _ = harness
    seen = []
    runner.skills.directories["/jw/skills/demo"] = "demo"

    def bridge(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"text": "ran skill", "isError": False})

    class SkillRun(FakeRun):
        def __aiter__(self):
            async def frames():
                toolset, = runner.registry._sets.values()
                assert toolset.timeout_s == 7200
                assert toolset.trace_context == {
                    "run_id": "r1", "agent_id": "a1", "session_id": "s1", "swarm_session": "s1",
                }
                assert await toolset.call("run_shell", {
                    "command": "python /jw/skills/demo/scripts/run.py",
                }) == ("ran skill", False)
                for frame in self.frames:
                    yield frame
            return frames()

    runner.chat_run = SkillRun
    async with httpx.AsyncClient(transport=httpx.MockTransport(bridge)) as client:
        runner.client = lambda: client
        _, lines = await post(app, {
            "sessionId": "s1", "runId": "r1", "agentId": "a1", "prompt": "run the skill",
            "tools": [{"name": "run_shell"}], "bridge": {"url": "http://legacy.test/bridge"},
            "toolTimeoutSeconds": 7200,
        })
    assert lines[-1]["done"]["status"] == "completed"
    assert seen == [{"name": "run_shell", "arguments": {
        "command": 'python "$SCIENCEDISCOVERY_SKILLS_DIR"/demo/scripts/run.py',
    }}]
    assert not runner.registry._sets
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
    assert not any(server != first for server, _ in runner._tool_approvals), "failed generation must retry permissions"

    rpcs.clear()
    recovered = await runner.ensure_shared_tools(wider, 60)
    assert recovered != first
    assert ("mcp.connect", recovered) in [(method, params["name"]) for _, method, params in rpcs
                                           if method.startswith("mcp.")]
    assert ("permissions.tools.update", f"mcp_{recovered}_second") in [
        (method, params["tool"]) for _, method, params in rpcs if method == "permissions.tools.update"
    ]
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


async def test_child_skill_subset_reuses_parent_mcp_generation_and_permissions(harness):
    _, runner, rpcs = harness

    def skill_tool(ids):
        choices = [{"const": value, "type": "string"} for value in ids]
        return {"name": "read_skill", "inputSchema": {"type": "object", "properties": {
            "skillId": choices[0] if len(choices) == 1 else {"anyOf": choices},
        }}}

    parent_tool = skill_tool(["literature", "planning", "coding"])
    parent = await runner.ensure_shared_tools([parent_tool], 60)
    calls_before_child = len(rpcs)
    for ids in (["literature", "coding"], ["literature"]):
        child = await runner.ensure_shared_tools([skill_tool(ids)], 10)
        assert child == parent
        assert len(rpcs) == calls_before_child, "Equivalent skill schemas must not re-register tools or permissions"
        await runner.release_shared_tools(child)
    assert parent_tool["inputSchema"]["properties"]["skillId"]["anyOf"][0]["const"] == "literature"
    await runner.release_shared_tools(parent)


async def test_retired_generations_remove_persisted_permissions_without_touching_live_rules(harness):
    _, runner, _ = harness
    persisted = {"unrelated_user_tool": "ask"}
    original_rpc = runner.rpc

    async def track_permissions(url, method, params=None, **kwargs):
        result = await original_rpc(url, method, params, **kwargs)
        if method == "permissions.tools.update":
            persisted[params["tool"]] = params["level"]
        elif method == "permissions.tools.delete":
            del persisted[params["tool"]]
        return result

    runner.rpc = track_permissions
    first = await runner.ensure_shared_tools([{"name": "parent", "approval": "ask"}], 60)
    second = await runner.ensure_shared_tools([{"name": "child"}], 60)
    assert persisted[f"mcp_{first}_parent"] == "ask"
    await runner.release_shared_tools(first)
    assert f"mcp_{first}_parent" not in persisted
    assert persisted[f"mcp_{second}_child"] == "allow"
    await runner.release_shared_tools(second)
    for index in range(20):
        server = await runner.ensure_shared_tools([{"name": f"next_{index}"}], 60)
        await runner.release_shared_tools(server)
        assert persisted == {"unrelated_user_tool": "ask", f"mcp_{server}_next_{index}": "allow"}


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
    app.state.agent_runner.rpc = runner.rpc
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
    # Listed tools and no hidden ones asked for: a bash call the model makes anyway still reaches nothing on the host.
    assert JIUWENSWARM_HOST_TOOLS <= route.hidden_native_tools
    chunk = {"choices": [{"delta": {"tool_calls": [{"function": {"name": "bash", "arguments": '{"command": "touch /tmp/x"}'}}]}}]}
    assert rewrite_response(chunk, route)["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "unavailable__bash"
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


async def test_tool_deadlines_are_per_run_without_replacing_shared_transport(harness, monkeypatch):
    app, runner, rpcs = harness
    deadlines = []
    original_add = runner.registry.add

    def add(toolset):
        deadlines.append(toolset.timeout_s)
        return original_add(toolset)

    monkeypatch.setattr(runner.registry, "add", add)
    FakeRun.fixture = "jw_chat_mcp_direct.raw"
    tools = [{"name": "run_shell", "description": "d", "inputSchema": {"type": "object"}}]
    bridge = {"url": "http://legacy.test/bridge", "token": "t"}
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge})
    assert next(p for _, m, p in rpcs if m == "mcp.register_custom")["timeout_s"] == 3600
    rpcs.clear()
    await post(app, {"sessionId": "s1", "prompt": "go", "tools": tools, "bridge": bridge, "toolTimeoutSeconds": 7200})
    assert not any(m in {"mcp.disconnect", "mcp.delete_custom", "mcp.register_custom"}
                   for _, m, _ in rpcs), "A longer run must not rebuild the shared transport"
    assert deadlines == [3600, 7200]


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
    from unittest.mock import AsyncMock
    guarded = create_app(Settings(**{**SETTINGS.__dict__, "agent_token": "secret"}))
    guarded.state.agent_runner.rpc = AsyncMock(return_value={})
    assert (await get(guarded, "/agent/info")).status_code == 401
    assert (await get(guarded, "/agent/info", {"authorization": "Bearer wrong"})).status_code == 401
    assert (await get(guarded, "/agent/info", {"authorization": "Bearer secret"})).status_code == 200


async def test_info_also_opens_with_the_apis_own_access_token():
    from unittest.mock import AsyncMock
    app = create_app(Settings(**{**SETTINGS.__dict__, "api_token": "api-token"}))
    app.state.agent_runner.rpc = AsyncMock(return_value={})
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
    runner.pending_approvals["q1"] = (Waiting(), mapper, "q1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        ok = await client.post("/agent/approvals/q1", json={"decision": "allow_matching"})
        missing = await client.post("/agent/approvals/q1", json={"decision": "deny"})
        duplicate = await client.post("/agent/approvals/q1", json={"decision": "allow_matching"})
    assert ok.status_code == 200 and missing.status_code == 409
    assert duplicate.status_code == 200
    assert answered == [("q1", "permission_interrupt", {"selected_options": ["本会话允许"], "custom_input": "本会话允许"})]


async def test_reused_gateway_question_ids_answer_each_run_once(harness):
    from sciencediscovery_adapter.events import RunEventMapper

    _, runner, _ = harness
    answered = []

    class Waiting:
        def __init__(self, run):
            self.run = run

        async def answer(self, request_id, source, answer):
            answered.append((self.run, request_id, answer["selected_options"]))

    public_ids = []
    for run in ("first", "second"):
        mapper = RunEventMapper(session_id=run)
        mapper._permissions["call-python-1"] = ["本次允许", "拒绝"]
        mapper._pending_requests["call-python-1"] = {"id": "call-python-1", "state": "pending"}
        event = {"type": "permission.required", "request": {
            "id": "call-python-1", "toolCallId": "call-python-1"}}
        runner.register_approval(event, Waiting(run), mapper)
        public_ids.append(event["request"]["id"])
        assert event["request"]["toolCallId"] == "call-python-1"
        await runner.answer_approval(public_ids[-1], "allow_once")

    assert public_ids[0] != public_ids[1]
    assert answered == [
        ("first", "call-python-1", ["本次允许"]),
        ("second", "call-python-1", ["本次允许"]),
    ]


async def test_concurrent_approval_retries_share_one_delivery(harness):
    from sciencediscovery_adapter.events import RunEventMapper
    _, runner, _ = harness
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    class Waiting:
        async def answer(self, *args):
            calls.append(args)
            entered.set()
            await release.wait()
    mapper = RunEventMapper(session_id="s1")
    mapper._permissions["q1"] = ["本次允许", "拒绝"]
    mapper._pending_requests["q1"] = {"id": "q1", "state": "pending"}
    runner.pending_approvals["q1"] = (Waiting(), mapper, "q1")
    first = asyncio.create_task(runner.answer_approval("q1", "allow_once"))
    await asyncio.wait_for(entered.wait(), 1)
    first.cancel()  # Lost HTTP caller must not cancel the downstream delivery.
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(runner.answer_approval("q1", "allow_once"))
    release.set()
    await asyncio.wait_for(second, 1)
    await runner.answer_approval("q1", "allow_once")
    assert len(calls) == 1


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
    runner.pending_approvals["q1"] = (Broken(), mapper, "q1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        response = await client.post("/agent/approvals/q1", json={"decision": "allow_once"})
    assert response.status_code == expected


async def test_boundary_longer_child_timeout_preserves_active_shared_transport(harness):
    """A child must not disconnect the transport serving its waiting parent."""
    from sciencediscovery_adapter.mcp_server import Toolset
    from unittest.mock import AsyncMock
    _, runner, rpcs = harness
    tools = [{"name": "task", "description": "delegate", "inputSchema": {}}]
    await runner.ensure_shared_tools(tools, 3600)
    tag = runner.registry.add(Toolset(tools=tools, call=AsyncMock()))
    rpcs.clear()
    try:
        await runner.ensure_shared_tools(tools, 7200)
        destructive = [method for _, method, _ in rpcs
                       if method in {"mcp.disconnect", "mcp.delete_custom"}]
        assert destructive == [], f"Active parent transport was torn down: {destructive}"
    finally:
        runner.registry.remove(tag)


@pytest.mark.parametrize("first,second", [("allow", "ask"), ("ask", "allow")])
async def test_boundary_same_tool_permission_conflict_is_not_silently_ignored(harness, first, second):
    """A later ask policy must not silently inherit an earlier allow policy."""
    _, runner, rpcs = harness
    tool = {"name": "run_shell", "description": "shell", "inputSchema": {}}
    await runner.ensure_shared_tools([{**tool, "approval": first}], 3600)
    rpcs.clear()
    with pytest.raises(ValueError, match="Conflicting approval policy"):
        await runner.ensure_shared_tools([{**tool, "approval": second}], 3600)
    assert rpcs == [], "A rejected run must not change another run's permissions or transport"
    assert runner._approval_levels["run_shell"] == first


async def test_permission_rpc_failure_is_retried_without_publishing_unconfigured_tool(harness):
    from sciencediscovery_adapter.gateway import GatewayError
    _, runner, _ = harness
    calls = []

    async def rpc(url, method, params=None, **kwargs):
        if method == "permissions.tools.update":
            calls.append(params)
            if len(calls) == 1:
                raise GatewayError("fixture permission update failure")
        return {}

    runner.rpc = rpc
    tools = [{"name": "run_shell", "approval": "ask", "inputSchema": {}}]
    with pytest.raises(GatewayError):
        await runner.ensure_shared_tools(tools, 3600)
    assert "run_shell" not in runner.registry.shared
    assert ("sci", "run_shell") not in runner._tool_approvals
    await runner.ensure_shared_tools(tools, 3600)
    assert len(calls) == 2
    assert runner._tool_approvals[("sci", "run_shell")] == "ask"


@pytest.mark.parametrize("same_run", [True, False])
async def test_boundary_independent_approvals_can_finish_out_of_order(harness, same_run):
    from sciencediscovery_adapter.events import RunEventMapper
    _, runner, _ = harness
    started, release = asyncio.Event(), asyncio.Event()
    answers = []

    class Waiting:
        async def answer(self, request_id, source, answer):
            if request_id == "parent-approval":
                started.set()
                await release.wait()
            answers.append((request_id, answer["selected_options"]))

    shared_mapper = RunEventMapper(session_id="parent")
    for session in ("parent", "child"):
        question = f"{session}-approval"
        mapper = shared_mapper if same_run else RunEventMapper(session_id=session)
        mapper._permissions[question] = ["本次允许", "拒绝"]
        mapper._pending_requests[question] = {"id": question, "state": "pending"}
        runner.pending_approvals[question] = (Waiting(), mapper, question)
    parent = asyncio.create_task(runner.answer_approval("parent-approval", "allow_once"))
    try:
        await asyncio.wait_for(started.wait(), 1)
        assert "child-approval" in runner.pending_approvals
        await asyncio.wait_for(runner.answer_approval("child-approval", "deny"), 1)
        assert answers == [("child-approval", ["拒绝"])]
        assert not parent.done()
        release.set()
        await asyncio.wait_for(parent, 1)
        assert answers[-1] == ("parent-approval", ["本次允许"])
    finally:
        release.set()
        await parent


async def test_boundary_cancel_one_run_keeps_sibling_routes_and_approval(harness):
    from sciencediscovery_adapter.agent_runs import AgentRunRequest
    from sciencediscovery_adapter.events import RunEventMapper
    app, runner, _ = harness

    class Endless(FakeRun):
        def __aiter__(self):
            async def frames():
                yield recorded("jw_chat_plain.raw")[2]
                await asyncio.Event().wait()
            return frames()

    runner.chat_run = Endless
    streams = []
    async with app.router.lifespan_context(app):
        try:
            for session in ("parent", "sibling"):
                stream = runner.stream(AgentRunRequest(sessionId=session, prompt="go",
                    tools=[{"name": "run_shell"}], bridge={"url": "http://legacy.test/bridge"},
                    model={"provider": "OpenAI", "model": "fixture", "baseUrl": "http://mock", "apiKey": "fixture"}))
                streams.append(stream)
                await asyncio.wait_for(anext(stream), 1)
            sibling = FakeRun.instances[-1]
            route = sibling.params["run_model"]["api_key"]
            mapper = RunEventMapper(session_id="sibling")
            runner.pending_approvals["sibling-question"] = (sibling, mapper, "sibling-question")
            assert len(runner.registry._sets) == len(runner.routes._routes) == 2
            await streams[0].aclose()
            assert FakeRun.instances[0].cancelled
            assert not sibling.cancelled
            assert runner.routes.get(route) is not None
            assert len(runner.registry._sets) == len(runner.routes._routes) == 1
            assert "sibling-question" in runner.pending_approvals
        finally:
            for stream in streams:
                await stream.aclose()
            runner.pending_approvals.pop("sibling-question", None)
        assert not runner.registry._sets
        assert not runner.routes._routes


async def test_boundary_failed_start_releases_private_routes_and_toolsets(harness):
    from sciencediscovery_adapter.gateway import GatewayError
    app, runner, _ = harness

    async def broken_rpc(url, method, params=None, **kwargs):
        if method == "mcp.connect":
            raise GatewayError("fixture connect failure")
        return {}

    runner.rpc = broken_rpc
    _, lines = await post(app, {"sessionId": "failed-start", "prompt": "go",
        "tools": [{"name": "run_shell"}], "bridge": {"url": "http://legacy.test/bridge"},
        "model": {"provider": "OpenAI", "model": "fixture", "baseUrl": "http://mock", "apiKey": "fixture"}})
    assert lines[-1]["done"]["status"] == "failed"
    assert not runner.routes._routes
    assert not runner.registry._sets
    assert not runner.pending_approvals
