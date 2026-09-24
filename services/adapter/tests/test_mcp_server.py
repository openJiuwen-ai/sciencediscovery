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
import httpx
import pytest
from fastapi import FastAPI

from sciencediscovery_adapter.mcp_server import RUN_ARG, Toolset, ToolsetRegistry, mcp_router

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

TOOLS = [{"name": "run_shell", "description": "Run a command.",
          "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}]


async def test_cancel_notification_is_scoped_to_connection_and_request(setup):
    client, _, _, registry = setup
    entered = {name: asyncio.Event() for name in ("a", "b")}
    cancelled = {name: asyncio.Event() for name in ("a", "b")}
    release = asyncio.Event()

    async def call(name, args):
        label = args["command"]
        entered[label].set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled[label].set()
            raise
        return label, False

    tag = registry.add(Toolset(TOOLS, call))
    tasks = []
    async with client:
        try:
            for label in ("a", "b"):
                tasks.append(asyncio.create_task(client.post(f"/mcp/{registry.token}",
                    headers={"x-sci-mcp-connection": label}, json={"jsonrpc": "2.0", "id": 1,
                        "method": "tools/call", "params": call_of(tag, "run_shell", command=label)})))
            await asyncio.wait_for(asyncio.gather(*(e.wait() for e in entered.values())), 2)
            result = await client.post(f"/mcp/{registry.token}", headers={"x-sci-mcp-connection": "a"},
                json={"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}})
            assert result.status_code == 202
            await asyncio.wait_for(cancelled["a"].wait(), 1)
            assert not cancelled["b"].is_set()
            assert (await tasks[0]).json()["error"]["code"] == -32800
            release.set()
            assert (await tasks[1]).json()["result"]["content"][0]["text"] == "b"
        finally:
            release.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


async def test_per_run_deadline_cancels_only_its_own_bridge_call(setup):
    client, _, _, registry = setup
    expired = asyncio.Event()

    async def short_call(name, arguments):
        try:
            await asyncio.Event().wait()
        finally:
            expired.set()

    async def long_call(name, arguments):
        await expired.wait()
        return "sibling completed", False

    short = registry.add(Toolset(tools=TOOLS, call=short_call, timeout_s=.02))
    long = registry.add(Toolset(tools=TOOLS, call=long_call, timeout_s=2))
    async with client:
        first, second = await asyncio.wait_for(asyncio.gather(
            rpc(client, registry, "tools/call", call_of(short, "run_shell", command="short"), id=1),
            rpc(client, registry, "tools/call", call_of(long, "run_shell", command="long"), id=2),
        ), 3)
        failure = first.json()["result"]
        assert failure["isError"] is True
        assert "timed out" in failure["content"][0]["text"]
        assert "inspect state" in failure["content"][0]["text"]
        assert second.json()["result"]["isError"] is False
        assert second.json()["result"]["content"][0]["text"] == "sibling completed"
        # A timeout has not poisoned the shared endpoint for subsequent calls.
        again = await rpc(client, registry, "tools/call", call_of(long, "run_shell", command="again"))
        assert again.json()["result"]["isError"] is False


@pytest.fixture
def setup():
    calls = []

    async def call(name, arguments):
        calls.append((name, arguments))
        return (f"ran {arguments.get('command')}", arguments.get("command") == "fail")

    registry = ToolsetRegistry()
    tag = registry.add(Toolset(tools=[dict(t) for t in TOOLS], call=call))
    registry.merge(TOOLS)
    app = FastAPI()
    app.include_router(mcp_router(registry))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter")
    return client, tag, calls, registry


async def rpc(client, registry, method, params=None, id=1, token=None):
    body = {"jsonrpc": "2.0", "method": method, **({"id": id} if id is not None else {}), **({"params": params} if params else {})}
    return await client.post(f"/mcp/{token or registry.token}", json=body)


def call_of(tag, name, **arguments):
    return {"name": name, "arguments": {**arguments, RUN_ARG: tag}}


async def test_initialize_echoes_the_clients_protocol_version(setup):
    client, _, _, registry = setup
    response = await rpc(client, registry, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {}})
    result = response.json()["result"]
    assert result["protocolVersion"] == "2024-11-05"
    assert result["capabilities"] == {"tools": {"listChanged": False}}
    assert result["serverInfo"]["name"] == "sci"


async def test_the_list_is_every_runs_tools_open_and_with_the_run_argument(setup):
    client, _, _, registry = setup
    [tool] = (await rpc(client, registry, "tools/list")).json()["result"]["tools"]
    assert tool["name"] == "run_shell" and tool["description"] == "Run a command."
    assert tool["inputSchema"] == {"type": "object", "properties": {
        "command": {"type": "string"}, RUN_ARG: {"type": "string", "description": "Set by the runtime."}}}


async def test_merging_says_when_jiuwenswarm_must_read_the_list_again():
    registry = ToolsetRegistry()
    assert registry.merge(TOOLS) is True
    assert registry.merge(TOOLS) is False  # the same tools again
    with_enum = [{"name": "run_shell", "description": "x", "inputSchema": {"type": "object", "properties": {"command": {"type": "string", "enum": ["a"]}}}}]
    assert registry.merge(with_enum) is False  # another run's enum changes nothing JiuwenSwarm holds
    assert "enum" not in registry.shared["run_shell"]["inputSchema"]["properties"]["command"]
    wider = [{"name": "run_shell", "description": "x", "inputSchema": {"type": "object", "properties": {"runner_id": {"type": "string"}}}}]
    assert registry.merge(wider) is True
    assert set(registry.shared["run_shell"]["inputSchema"]["properties"]) == {"command", "runner_id", RUN_ARG}
    assert registry.merge([{"name": "declare_artifact", "description": "d", "inputSchema": {"type": "object"}}]) is True


async def test_merging_refreshes_a_changed_property_type():
    registry = ToolsetRegistry()
    first = [{"name": "custom_lookup", "inputSchema": {"type": "object", "properties": {"value": {"type": "string"}}}}]
    changed = [{"name": "custom_lookup", "inputSchema": {"type": "object", "properties": {"value": {"type": "integer"}}}}]
    assert registry.merge(first) is True
    assert registry.merge(changed) is True
    assert registry.shared["custom_lookup"]["inputSchema"]["properties"]["value"]["type"] == "integer"


async def test_a_call_goes_to_the_run_its_tag_names_without_the_tag(setup):
    client, tag, calls, registry = setup
    response = await rpc(client, registry, "tools/call", call_of(tag, "run_shell", command="echo hi"))
    assert response.json()["result"] == {"content": [{"type": "text", "text": "ran echo hi"}], "isError": False}
    assert calls == [("run_shell", {"command": "echo hi"})]


async def test_two_runs_each_get_their_own_calls(setup):
    client, tag, calls, registry = setup
    other = []

    async def call_other(name, arguments):
        other.append((name, arguments))
        return ("other", False)

    second = registry.add(Toolset(tools=[dict(t) for t in TOOLS], call=call_other))
    await rpc(client, registry, "tools/call", call_of(second, "run_shell", command="b"))
    await rpc(client, registry, "tools/call", call_of(tag, "run_shell", command="a"))
    assert calls == [("run_shell", {"command": "a"})] and other == [("run_shell", {"command": "b"})]


async def test_a_call_without_a_live_runs_tag_runs_nothing(setup):
    client, tag, calls, registry = setup
    no_tag = (await rpc(client, registry, "tools/call", {"name": "run_shell", "arguments": {"command": "x"}})).json()["result"]
    registry.remove(tag)
    ended = (await rpc(client, registry, "tools/call", call_of(tag, "run_shell", command="x"))).json()["result"]
    assert no_tag["isError"] and ended["isError"] and "no running run" in ended["content"][0]["text"] and calls == []


async def test_a_failed_tool_is_a_tool_error_not_a_protocol_error(setup):
    client, tag, _, registry = setup
    result = (await rpc(client, registry, "tools/call", call_of(tag, "run_shell", command="fail"))).json()["result"]
    assert result["isError"] is True


async def test_a_tool_the_run_does_not_have_is_a_tool_error(setup):
    client, tag, calls, registry = setup
    result = (await rpc(client, registry, "tools/call", call_of(tag, "nope"))).json()["result"]
    assert result["isError"] is True and "not one of this run's tools" in result["content"][0]["text"] and calls == []


async def test_a_crashing_callback_becomes_an_error_result(setup):
    client, tag, _, registry = setup

    async def boom(name, arguments):
        raise ConnectionError("bridge down")

    registry.get(tag).call = boom
    result = (await rpc(client, registry, "tools/call", call_of(tag, "run_shell"))).json()["result"]
    assert result["isError"] is True and "bridge down" in result["content"][0]["text"]


async def test_notifications_get_202_and_unknown_methods_are_errors(setup):
    client, _, _, registry = setup
    assert (await rpc(client, registry, "notifications/initialized", id=None)).status_code == 202
    assert (await rpc(client, registry, "resources/list")).json()["error"]["code"] == -32601


async def test_an_unknown_token_is_404_and_get_is_refused(setup):
    client, _, _, registry = setup
    assert (await rpc(client, registry, "tools/list", token="wrong")).status_code == 404
    assert (await client.get(f"/mcp/{registry.token}")).status_code == 405


async def test_a_required_empty_list_dropped_upstream_is_restored_before_the_call(setup):
    client, tag, calls, registry = setup
    registry.get(tag).tools.append({"name": "update_plan", "description": "d",
                                    "inputSchema": {"type": "object", "required": ["plan"], "properties": {"plan": {"type": "array"}}}})
    await rpc(client, registry, "tools/call", call_of(tag, "update_plan"))
    assert calls[-1] == ("update_plan", {"plan": []})
