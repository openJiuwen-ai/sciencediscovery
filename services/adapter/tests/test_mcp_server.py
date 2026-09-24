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

import httpx
import pytest
from fastapi import FastAPI

from sciencediscovery_adapter.mcp_server import RUN_ARG, Toolset, ToolsetRegistry, mcp_router

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

TOOLS = [{"name": "run_shell", "description": "Run a command.",
          "inputSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}]


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
