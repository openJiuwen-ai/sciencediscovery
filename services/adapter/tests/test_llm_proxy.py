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
from dataclasses import replace

import httpx
from fastapi import FastAPI

from sciencediscovery_adapter.llm_proxy import LlmRoute, LlmRoutes, StreamingToolRewriter, llm_router, rewrite_request, rewrite_response
import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

ROUTE = LlmRoute(base_url="http://llm.test/v1", api_key="sk-real", model="gpt-real", tool_prefix="mcp_sci_",
                 tool_names=frozenset({"run_shell", "declare_artifact"}), system_prompt="You are the science agent.")


def test_streamed_run_tag_handles_empty_header_parallel_calls_and_overrides_forged_tag():
    route = replace(ROUTE, run_tag="real-run", recent_calls=[])
    rewrite = StreamingToolRewriter(route)
    chunks = []
    def send(calls, finish=None):
        payload = rewrite.rewrite({"choices": [{"index": 0, "delta": {"tool_calls": calls}, "finish_reason": finish}]})
        chunks.extend(payload["choices"][0]["delta"]["tool_calls"])
        return payload
    send([{"index": 0, "id": "a", "function": {"name": "run_shell", "arguments": ""}}])
    send([{"index": 1, "id": "b", "function": {"name": "declare_artifact", "arguments": "{}  "}}])
    first = send([{"index": 0, "function": {"arguments": '{"command":"echo '}}])
    assert first["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"].startswith('{"command":"ech')
    send([{"index": 0, "function": {"arguments": 'hi","_sd_run":"forged"} \n'}}])
    send([], "tool_calls")
    args = {index: json.loads("".join(c["function"].get("arguments", "") for c in chunks if c["index"] == index)) for index in (0, 1)}
    assert args == {0: {"command": "echo hi", "_sd_run": "real-run"}, 1: {"_sd_run": "real-run"}}
    assert route.recent_calls == [("mcp_sci_run_shell", {"command": "echo hi"}), ("mcp_sci_declare_artifact", {})]


def test_streamed_run_tag_survives_every_single_character_boundary_and_nested_braces():
    raw = json.dumps({"command": 'print("}\\\\\\\"")', "nested": {"items": [1, {"x": " 文 "}]}}, ensure_ascii=False) + " \n"
    route = replace(ROUTE, run_tag="r", recent_calls=[])
    rewrite = StreamingToolRewriter(route)
    output = []
    for index, fragment in enumerate(raw):
        function = {"arguments": fragment, **({"name": "run_shell"} if index == 0 else {})}
        result = rewrite.rewrite({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": function}]}}]})
        output.append(result["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"])
    result = rewrite.rewrite({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    output.append(result["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"])
    assert json.loads("".join(output)) == {**json.loads(raw), "_sd_run": "r"}


def test_stream_rewriters_do_not_share_partial_call_state_between_requests():
    route = replace(ROUTE, run_tag="r", recent_calls=[])
    first, second = StreamingToolRewriter(route), StreamingToolRewriter(route)
    first.rewrite({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "run_shell", "arguments": '{"command":'}}]}}]})
    result = second.rewrite({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "run_shell", "arguments": "{}"}}]}, "finish_reason": "tool_calls"}]})
    assert json.loads(result["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]) == {"_sd_run": "r"}


def tool(name):
    return {"type": "function", "function": {"name": name, "description": "d", "parameters": {"type": "object"}}}


def test_the_tool_list_is_cut_to_the_runs_toolset_with_original_names():
    body = {"model": "sd-1", "tools": [tool("mcp_sci_run_shell"), tool("bash"), tool("mcp_sci_declare_artifact"), tool("todo_create")],
            "messages": []}
    names = [t["function"]["name"] for t in rewrite_request(body, ROUTE)["tools"]]
    assert names == ["run_shell", "declare_artifact"]


def test_tool_contract_trace_reports_missing_tools_without_prompt_or_credentials(monkeypatch, capsys):
    from sciencediscovery_adapter import llm_proxy
    monkeypatch.setattr(llm_proxy, "_TRACE_TOOLS", True)
    rewrite_request({"tools": [tool("mcp_sci_run_shell")],
                     "messages": [{"role": "user", "content": "private research prompt"}]}, ROUTE)
    logged = capsys.readouterr().err
    record = json.loads(logged.split("[tool-contract] ", 1)[1].splitlines()[0])
    assert record["missing"] == ["declare_artifact"]
    assert record["llm"] == ["run_shell"]
    assert "private research prompt" not in logged
    assert ROUTE.api_key not in logged


def test_no_science_tools_means_no_tools_field_at_all():
    out = rewrite_request({"tools": [tool("bash")], "tool_choice": "auto", "messages": []}, ROUTE)
    assert "tools" not in out and "tool_choice" not in out


def test_the_model_id_is_the_real_one_and_the_rest_is_kept():
    out = rewrite_request({"model": "sd-alias", "stream": True, "temperature": 0.1, "messages": []}, ROUTE)
    assert out["model"] == "gpt-real" and out["stream"] is True and out["temperature"] == 0.1


def test_the_system_prompt_is_replaced_and_extra_system_messages_dropped():
    body = {"messages": [{"role": "system", "content": "You are JiuwenSwarm."}, {"role": "user", "content": "hi"},
                         {"role": "system", "content": "another"}]}
    out = rewrite_request(body, ROUTE)["messages"]
    assert out == [{"role": "system", "content": "You are the science agent."}, {"role": "user", "content": "hi"}]


def test_a_system_prompt_is_added_when_the_request_has_none():
    out = rewrite_request({"messages": [{"role": "user", "content": "hi"}]}, ROUTE)["messages"]
    assert out[0] == {"role": "system", "content": "You are the science agent."}


def test_without_a_route_system_prompt_the_messages_are_untouched():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt": None})
    body = {"messages": [{"role": "system", "content": "keep me"}, {"role": "user", "content": "hi"}]}
    assert rewrite_request(body, route)["messages"] == body["messages"]


def test_history_tool_calls_and_tool_names_lose_the_prefix():
    body = {"messages": [
        {"role": "assistant", "tool_calls": [{"id": "1", "type": "function", "function": {"name": "mcp_sci_run_shell", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "1", "name": "mcp_sci_run_shell", "content": "out"},
    ]}
    out = rewrite_request(body, ROUTE)["messages"]
    assert out[1]["tool_calls"][0]["function"]["name"] == "run_shell" and out[2]["name"] == "run_shell"


def test_tool_choice_by_name_is_unprefixed():
    out = rewrite_request({"tool_choice": {"type": "function", "function": {"name": "mcp_sci_run_shell"}},
                           "tools": [tool("mcp_sci_run_shell")], "messages": []}, ROUTE)
    assert out["tool_choice"]["function"]["name"] == "run_shell"


def test_response_tool_calls_get_the_prefix_back_but_unknown_names_do_not():
    payload = {"choices": [{"message": {"tool_calls": [
        {"function": {"name": "run_shell"}}, {"function": {"name": "not_ours"}}]}}]}
    calls = rewrite_response(payload, ROUTE)["choices"][0]["message"]["tool_calls"]
    assert [c["function"]["name"] for c in calls] == ["mcp_sci_run_shell", "not_ours"]


def test_a_stream_chunk_delta_is_rewritten_too():
    chunk = {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "declare_artifact", "arguments": ""}}]}}]}
    assert rewrite_response(chunk, ROUTE)["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "mcp_sci_declare_artifact"


def make_app(handler, route=ROUTE):
    routes = LlmRoutes()
    token = routes.add(route)
    app = FastAPI()
    upstream = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    app.include_router(llm_router(routes, lambda: upstream))
    return app, token


def streamed(status, body, headers):
    return httpx.Response(status, headers=headers, stream=httpx.ByteStream(body))


async def post(app, token, body):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter") as client:
        return await client.post(f"/llm/{token}/v1/chat/completions", json=body)


async def test_the_request_goes_upstream_rewritten_with_the_real_key():
    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return streamed(200, json.dumps({"choices": [{"message": {"content": "hi"}}]}).encode(), {"content-type": "application/json"})

    app, token = make_app(handler)
    response = await post(app, token, {"model": "sd-alias", "messages": [{"role": "user", "content": "x"}], "tools": [tool("mcp_sci_run_shell")]})
    assert response.json() == {"choices": [{"message": {"content": "hi"}}]}
    assert seen["url"] == "http://llm.test/v1/chat/completions" and seen["auth"] == "Bearer sk-real"
    assert seen["body"]["model"] == "gpt-real" and seen["body"]["tools"][0]["function"]["name"] == "run_shell"


async def test_a_streamed_tool_call_comes_back_prefixed_and_the_rest_is_untouched():
    def sse(payload):
        return b"data: " + json.dumps(payload).encode() + b"\n\n"

    body = (sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "run_shell", "arguments": ""}}]}}]})
            + sse({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "{\"command\":\"ls\"}"}}]}}]})
            + sse({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}) + b"data: [DONE]\n\n")
    app, token = make_app(lambda request: streamed(200, body, {"content-type": "text/event-stream"}))
    response = await post(app, token, {"stream": True, "messages": []})
    lines = [line for line in response.text.splitlines() if line.startswith("data:") and "[DONE]" not in line]
    parsed = [json.loads(line[5:]) for line in lines]
    assert parsed[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "mcp_sci_run_shell"
    assert parsed[1]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] == "{\"command\":\"ls\"}"
    assert "data: [DONE]" in response.text and response.headers["content-type"].startswith("text/event-stream")


async def test_upstream_errors_pass_through_with_their_status():
    app, token = make_app(lambda request: streamed(429, b'{"error":{"message":"rate limited"}}', {"content-type": "application/json"}))
    response = await post(app, token, {"messages": []})
    assert response.status_code == 429 and "rate limited" in response.text


async def test_an_unreachable_endpoint_is_a_502_and_an_unknown_token_a_404():
    def boom(request):
        raise httpx.ConnectError("down")

    app, token = make_app(boom)
    assert (await post(app, token, {"messages": []})).status_code == 502
    assert (await post(app, "nope", {"messages": []})).status_code == 404


def test_jiuwenswarms_own_tools_named_for_the_run_stay_visible_with_their_own_spec():
    route = LlmRoute(**{**ROUTE.__dict__, "native_tools": frozenset({"todo_create"})})
    todo = {"type": "function", "function": {"name": "todo_create", "description": "JiuwenSwarm's own", "parameters": {"type": "object", "properties": {"tasks": {}}}}}
    body = {"tools": [tool("mcp_sci_run_shell"), todo, tool("bash"), tool("todo_list")], "messages": []}
    tools = rewrite_request(body, route)["tools"]
    assert [t["function"]["name"] for t in tools] == ["run_shell", "todo_create"]
    assert tools[1]["function"]["description"] == "JiuwenSwarm's own"


def test_without_native_tools_none_of_them_is_visible():
    assert [t["function"]["name"] for t in rewrite_request({"tools": [tool("todo_create"), tool("mcp_sci_run_shell")], "messages": []}, ROUTE)["tools"]] == ["run_shell"]


def _client(routes, handler):
    upstream = httpx.MockTransport(handler)
    app = FastAPI()
    app.include_router(llm_router(routes, lambda: httpx.AsyncClient(transport=upstream)))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://adapter")


async def test_jiuwenswarms_own_model_calls_go_to_the_model_of_the_run_in_progress_untouched():
    routes = LlmRoutes()
    routes.add(LlmRoute(**{**ROUTE.__dict__, "base_url": "http://old.test/v1", "api_key": "old", "model": "old-model"}))
    routes.add(ROUTE)  # the run that started last
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(url=str(request.url), auth=request.headers["authorization"], body=json.loads(request.content),
                    purpose=request.headers.get("x-sciencediscovery-model-purpose"))
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "summary", "tool_calls": [
            {"id": "c", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}]}}]})

    body = {"model": "sd-default", "messages": [{"role": "system", "content": "Summarise this."}, {"role": "user", "content": "long text"}], "tools": [tool("bash")]}
    async with _client(routes, handler) as client:
        response = await client.post("/llm/default/v1/chat/completions", json=body, headers={"authorization": f"Bearer {routes.default_key}"})
    assert response.status_code == 200
    assert seen["url"] == "http://llm.test/v1/chat/completions" and seen["auth"] == "Bearer sk-real"
    assert seen["body"]["model"] == "gpt-real", "the real model id"
    assert seen["purpose"] == "housekeeping"
    assert seen["body"]["messages"][0]["content"] == "Summarise this.", "JiuwenSwarm's own system prompt, not the agent's"
    assert [t["function"]["name"] for t in seen["body"]["tools"]] == ["bash"], "no tool list cut or renamed"
    assert response.json()["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "run_shell", "names are not prefixed"


async def test_the_default_route_needs_its_own_key_and_a_run_in_progress():
    routes = LlmRoutes()
    async with _client(routes, lambda request: httpx.Response(200, json={})) as client:
        assert (await client.post("/llm/default/v1/chat/completions", json={})).status_code == 401
        assert (await client.post("/llm/default/v1/chat/completions", json={}, headers={"authorization": "Bearer wrong"})).status_code == 401
        no_run = await client.post("/llm/default/v1/chat/completions", json={}, headers={"authorization": f"Bearer {routes.default_key}"})
        assert no_run.status_code == 503 and "no run in progress" in no_run.json()["error"]["message"]


async def test_the_default_route_is_not_mistaken_for_a_runs_token():
    routes = LlmRoutes()
    async with _client(routes, lambda request: httpx.Response(200, json={})) as client:
        response = await client.post("/llm/default/v1/chat/completions", json={}, headers={"authorization": "Bearer x"})
    assert response.status_code == 401  # not "unknown route" (404) from the per-run handler


def test_a_jiuwenswarm_tool_spelled_like_one_of_ours_is_not_offered_as_a_second_copy():
    """JiuwenSwarm has its own read_file and list_files; the run's toolset has tools of those names too."""
    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"read_file", "list_files", "run_shell"})})
    body = {"tools": [tool("read_file"), tool("mcp_sci_read_file"), tool("list_files"), tool("mcp_sci_list_files"), tool("mcp_sci_run_shell")],
            "messages": []}
    names = [t["function"]["name"] for t in rewrite_request(body, route)["tools"]]
    assert names == ["read_file", "list_files", "run_shell"], "one of each, and each one is the run's own"


def test_a_prefixed_name_that_is_not_in_the_toolset_is_not_offered():
    assert rewrite_request({"tools": [tool("mcp_sci_bash")], "messages": []}, ROUTE).get("tools") is None


def test_append_keeps_jiuwenswarms_own_system_prompt_whole_and_adds_the_callers_after_it():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt_mode": "append"})
    body = {"messages": [{"role": "system", "content": "# 身份\n你是 JiuwenSwarm 的智能体。"}, {"role": "user", "content": "hi"}]}
    out = rewrite_request(body, route)["messages"]
    assert out[0]["content"] == "# 身份\n你是 JiuwenSwarm 的智能体。\n\nYou are the science agent."
    assert [m["role"] for m in out] == ["system", "user"]


def test_append_with_no_system_message_still_gives_the_model_the_callers_prompt():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt_mode": "append"})
    out = rewrite_request({"messages": [{"role": "user", "content": "hi"}]}, route)["messages"]
    assert out[0] == {"role": "system", "content": "You are the science agent."}


def test_append_leaves_a_second_system_message_out_as_replace_does():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt_mode": "append"})
    body = {"messages": [{"role": "system", "content": "A"}, {"role": "system", "content": "B"}, {"role": "user", "content": "hi"}]}
    assert [m["content"] for m in rewrite_request(body, route)["messages"]] == ["A\n\nYou are the science agent.", "hi"]


def test_all_native_tools_offers_jiuwenswarms_whole_toolset_and_ours_gives_way_on_a_clash():
    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"read_file", "run_shell"}), "all_native_tools": True})
    body = {"tools": [tool("read_file"), tool("bash"), tool("subagent_spawn"), tool("mcp_sci_read_file"), tool("mcp_sci_run_shell")], "messages": []}
    names = [t["function"]["name"] for t in rewrite_request(body, route)["tools"]]
    assert names == ["read_file", "bash", "subagent_spawn", "run_shell"]
    assert route.shadowed == {"read_file"}
    # A call to read_file is JiuwenSwarm's: it keeps its name; run_shell is ours and gets the prefix back.
    chunk = {"choices": [{"delta": {"tool_calls": [{"function": {"name": "read_file"}}, {"function": {"name": "run_shell"}}]}}]}
    calls = rewrite_response(chunk, route)["choices"][0]["delta"]["tool_calls"]
    assert [c["function"]["name"] for c in calls] == ["read_file", "mcp_sci_run_shell"]


def test_without_all_native_tools_only_the_listed_ones_are_offered():
    route = LlmRoute(**{**ROUTE.__dict__, "native_tools": frozenset({"todo_create"})})
    body = {"tools": [tool("bash"), tool("todo_create"), tool("mcp_sci_run_shell")], "messages": []}
    assert [t["function"]["name"] for t in rewrite_request(body, route)["tools"]] == ["todo_create", "run_shell"]


def test_prepend_puts_ours_first_jiuwenswarms_whole_in_the_middle_and_the_tail_last():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt_mode": "prepend", "system_prompt_tail": "<run_contract>x</run_contract>"})
    body = {"messages": [{"role": "system", "content": "# 身份\nJW"}, {"role": "user", "content": "hi"}]}
    out = rewrite_request(body, route)["messages"]
    assert out[0]["content"] == "You are the science agent.\n\n# 身份\nJW\n\n<run_contract>x</run_contract>"


def test_replace_keeps_the_tail_too():
    route = LlmRoute(**{**ROUTE.__dict__, "system_prompt_tail": "T"})
    out = rewrite_request({"messages": [{"role": "system", "content": "JW"}]}, route)["messages"]
    assert out[0]["content"] == "You are the science agent.\n\nT"


def test_a_jiuwenswarm_tool_keeps_its_own_schema_even_when_one_of_ours_has_its_name():
    ours = {"description": "ours", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}
    theirs = {"name": "read_file", "description": "theirs", "parameters": {"type": "object", "properties": {"file_path": {"type": "string"}}}}
    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"read_file"}), "tool_specs": {"read_file": ours}, "all_native_tools": True})
    body = {"tools": [{"type": "function", "function": theirs}, {"type": "function", "function": {"name": "mcp_sci_read_file", "description": "x", "parameters": {}}}], "messages": []}
    tools = rewrite_request(body, route)["tools"]
    assert len(tools) == 1 and tools[0]["function"] == theirs


def test_an_earlier_runs_tool_names_in_the_history_become_the_plain_names():
    body = {"messages": [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "a", "type": "function", "function": {"name": "mcp_sci0096f4fcd7_run_shell", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "a", "name": "mcp_sci0096f4fcd7_run_shell", "content": "ok"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "b", "type": "function", "function": {"name": "mcp_sci0096f4fcd7_not_ours", "arguments": "{}"}}]},
    ]}
    out = [m for m in rewrite_request(body, ROUTE)["messages"] if m["role"] != "system"]
    assert out[0]["tool_calls"][0]["function"]["name"] == "run_shell"
    assert out[1]["name"] == "run_shell"
    assert out[2]["tool_calls"][0]["function"]["name"] == "mcp_sci0096f4fcd7_not_ours", "a name that is not one of this run's tools is left alone"


def test_a_model_that_calls_an_earlier_runs_name_is_sent_to_this_runs_server():
    chunk = {"choices": [{"delta": {"tool_calls": [{"function": {"name": "mcp_sci0096f4fcd7_run_shell"}}]}}]}
    assert rewrite_response(chunk, ROUTE)["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "mcp_sci_run_shell"


def test_hidden_host_tools_are_not_offered_and_ours_of_the_same_name_take_their_place():
    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"read_file", "run_shell"}), "all_native_tools": True,
                        "hidden_native_tools": frozenset({"bash", "read_file", "write_file"}), "shadowed": set()})
    body = {"tools": [tool("read_file"), tool("bash"), tool("write_file"), tool("subagent_spawn"), tool("mcp_sci_read_file"), tool("mcp_sci_run_shell")],
            "messages": []}
    names = [t["function"]["name"] for t in rewrite_request(body, route)["tools"]]
    assert names == ["subagent_spawn", "read_file", "run_shell"]
    assert route.shadowed == set()
    # read_file now reaches ours; bash and write_file, which JiuwenSwarm would run on the host, reach nothing.
    chunk = {"choices": [{"delta": {"tool_calls": [{"function": {"name": n}} for n in ("read_file", "bash", "write_file", "subagent_spawn")]}}]}
    calls = rewrite_response(chunk, route)["choices"][0]["delta"]["tool_calls"]
    assert [c["function"]["name"] for c in calls] == ["mcp_sci_read_file", "unavailable__bash", "unavailable__write_file", "subagent_spawn"]


def test_platform_delegation_hides_native_lifecycle_but_keeps_web_tools():
    hidden = frozenset({"subagent_spawn", "subagent_wait", "subagent_list",
                        "subagent_send_input", "subagent_close", "subagent_resume"})
    for all_native in (False, True):
        route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"task"}),
                            "all_native_tools": all_native, "hidden_native_tools": hidden,
                            "native_tools": hidden, "shadowed": set()})
        body = {"tools": [*[tool(n) for n in sorted(hidden)], tool("free_search"),
                          tool("fetch_webpage"), tool("mcp_sci_task")], "messages": []}
        names = [t["function"]["name"] for t in rewrite_request(body, route)["tools"]]
        assert names == (["free_search", "fetch_webpage", "task"] if all_native else ["task"])
        # Even a stale/hallucinated native call must not reach Swarm's native dispatcher.
        chunk = {"choices": [{"delta": {"tool_calls": [
            {"function": {"name": n}} for n in [*sorted(hidden), "task"]]}}]}
        calls = rewrite_response(chunk, route)["choices"][0]["delta"]["tool_calls"]
        assert [c["function"]["name"] for c in calls] == [
            *["unavailable__" + n for n in sorted(hidden)], "mcp_sci_task"]


def test_our_calls_get_the_runs_tag_and_the_history_loses_it():
    route = LlmRoute(**{**ROUTE.__dict__, "run_tag": "run-a", "shadowed": set()})
    chunk = {"choices": [{"delta": {"tool_calls": [
        {"function": {"name": "run_shell", "arguments": '{"command": "ls"}'}},
        {"function": {"name": "run_shell", "arguments": ""}},
        {"function": {"name": "todo_list", "arguments": "{}"}}]}}]}
    calls = rewrite_response(chunk, route)["choices"][0]["delta"]["tool_calls"]
    assert json.loads(calls[0]["function"]["arguments"]) == {"command": "ls", "_sd_run": "run-a"}
    assert json.loads(calls[1]["function"]["arguments"]) == {"_sd_run": "run-a"}
    assert calls[2]["function"]["arguments"] == "{}"  # JiuwenSwarm's own tool: untouched
    history = {"messages": [{"role": "assistant", "tool_calls": [
        {"id": "c1", "function": {"name": "mcp_sci_run_shell", "arguments": '{"command": "ls", "_sd_run": "run-old"}'}}]}]}
    [message] = rewrite_request(history, route)["messages"][1:]
    assert json.loads(message["tool_calls"][0]["function"]["arguments"]) == {"command": "ls"}


def test_an_approval_question_is_described_by_the_call_it_stopped():
    from sciencediscovery_adapter.agent_runs import describe_approval

    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"run_shell", "read_file"}), "run_tag": "r1", "shadowed": set(), "recent_calls": []})
    chunk = {"choices": [{"delta": {"tool_calls": [
        {"function": {"name": "read_file", "arguments": '{"path": "a.txt"}'}},
        {"function": {"name": "run_shell", "arguments": '{"command": "rm -rf out"}'}},
        {"function": {"name": "run_shell", "arguments": '{"command": "ls"}'}}]}}]}
    rewrite_response(chunk, route)
    first = {"id": "q1", "summary": "mcp_sci_run_shell（当前模式默认需确认） > 选择「会话内记住」", "resource": "x"}
    second = {"id": "q2", "summary": "mcp_sci_run_shell（当前模式默认需确认）", "resource": "x"}
    unknown = {"id": "q3", "summary": "acp_chat（需确认）", "resource": "acp_chat"}
    for request in (first, second, unknown):
        describe_approval(request, route)
    assert first["summary"] == "run_shell: rm -rf out" and first["toolName"] == "run_shell" and first["resource"] == "x"
    assert second["summary"] == "run_shell: ls" and second["toolName"] == "run_shell"
    assert unknown["summary"] == "acp_chat（需确认）"  # no call seen: JiuwenSwarm's own words stay
    assert "toolName" not in unknown
    # JiuwenSwarm asks again about a call already described (parallel calls), on a later server generation:
    # still named by our tool, so a grant for that tool applies and the card is not JiuwenSwarm's wording.
    again = {"id": "q4", "summary": "mcp_sci0000000001_mcp__pubmed__search（当前模式默认需确认） > 选择「会话内记住」", "resource": "x"}
    describe_approval(again, route)
    assert again["summary"] == "mcp__pubmed__search" and again["toolName"] == "mcp__pubmed__search"


def test_an_approval_card_shows_the_arguments_that_run_with_the_command():
    from sciencediscovery_adapter.agent_runs import describe_approval

    route = LlmRoute(**{**ROUTE.__dict__, "tool_names": frozenset({"run_shell"}), "run_tag": "r1", "shadowed": set(), "recent_calls": []})
    arguments = json.dumps({"command": "python", "arguments": ["-c", "print('hi')"], "environment_id": "env"})
    rewrite_response({"choices": [{"delta": {"tool_calls": [{"function": {"name": "run_shell", "arguments": arguments}}]}}]}, route)
    request = {"id": "q1", "summary": "mcp_sci_run_shell（当前模式默认需确认）", "resource": "x"}
    describe_approval(request, route)
    assert request["summary"] == "run_shell: python -c 'print('\"'\"'hi'\"'\"')'"
