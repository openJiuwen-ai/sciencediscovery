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
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest
import websockets

from sciencediscovery_adapter.gateway import ChatRun, GatewayError, chat, rpc

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))


DONE = {"type": "event", "event": "chat.processing_status", "payload": {"is_processing": False, "is_complete": True}}


@pytest.mark.parametrize("approved", [True, False])
@pytest.mark.parametrize("mcp", [["sci"], []])
async def test_approval_preserves_run_context_without_replaying_input(approved, mcp):
    context = {
        "mode": "deep", "agent_ref": "researcher", "model_name": "private-route",
        "run_model": {"endpoint_id": "test-route", "config": {"model": "test-model"}},
        "cwd": "/workspace/research", "project_dir": "/workspace/research",
        "trusted_dirs": ["/workspace/research"], "mcp": mcp,
        "agent_template_name": "research", "plugin_names": [],
    }
    expected = deepcopy(context)
    params = {**context, "session_id": "parent", "query": "original task",
              "attachments": [{"name": "input.csv"}], "sci_persistent_output": True}
    run = ChatRun("ws://unused", params)
    run._connection = AsyncMock()
    # Callers may mutate their configuration after constructing this run.
    params["mcp"].append("unrelated")
    params["run_model"]["config"]["model"] = "changed"
    for question in ("shell-approval", "artifact-approval"):
        await run.answer(question, "permission_interrupt", {"approved": approved})
    for call in run._connection.send.call_args_list:
        payload = json.loads(call.args[0])["params"]
        assert {key: payload[key] for key in expected} == expected
        assert payload["query"] == ""
        assert "attachments" not in payload
        assert payload["answers"] == [{"approved": approved}]
        assert payload["sci_persistent_output"] is True


async def test_parallel_parent_and_child_approval_contexts_are_isolated():
    runs = []
    for session, connector in (("parent", "sci"), ("child", "custom-scoped")):
        run = ChatRun("ws://unused", {"session_id": session, "mcp": [connector],
                                     "cwd": f"/workspace/{session}", "model_name": session})
        run._connection = AsyncMock()
        runs.append(run)
    await asyncio.gather(*(run.answer("permission", "permission_interrupt", {"approved": True})
                           for run in runs))
    for run, session, connector in zip(runs, ("parent", "child"), ("sci", "custom-scoped")):
        payload = json.loads(run._connection.send.call_args.args[0])["params"]
        assert payload["mcp"] == [connector]
        assert payload["cwd"] == f"/workspace/{session}"
        assert payload["model_name"] == session


async def test_approval_does_not_turn_omitted_equipment_into_explicit_clear():
    run = ChatRun("ws://unused", {"session_id": "legacy-client"})
    run._connection = AsyncMock()
    await run.answer("question", "permission_interrupt", {"approved": True})
    payload = json.loads(run._connection.send.call_args.args[0])["params"]
    assert not {"mcp", "plugin_names", "agent_template_name", "run_model"} & payload.keys()


@pytest.mark.parametrize("event", ["chat.error", "chat.final"])
async def test_startup_failure_without_output_owner_terminates_immediately(event):
    async def handler(connection):
        await connection.send(json.dumps({"event": "connection.ack"}))
        request = json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": event,
            "stream_request_id": request["id"], "payload": {"error": "model binding rejected"}}))
        await connection.wait_closed()
    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with ChatRun(f"ws://127.0.0.1:{port}", {"session_id": "s", "sci_persistent_output": True}, idle_timeout=1) as run:
            frames = [frame async for frame in run]
    assert len(frames) == 1
    assert frames[0]["event"] == "chat.error"



async def test_persistent_output_owner_survives_two_control_request_completions():
    seen = []
    async def handler(connection):
        await connection.send(json.dumps({"event": "connection.ack"}))
        initial = json.loads(await connection.recv())
        owner = initial["id"]
        await connection.send(json.dumps({"type": "event", "event": "runtime.output_owner", "stream_request_id": owner}))
        for question in ("q1", "q2"):
            await connection.send(json.dumps({"type": "event", "event": "chat.ask_user_question",
                "stream_request_id": owner, "payload": {"request_id": question}}))
        for _ in range(2):
            answer = json.loads(await connection.recv())
            assert answer["params"]["sci_persistent_output"] is True
            await connection.send(json.dumps({"type": "event", "event": "runtime.accepted", "stream_request_id": answer["id"]}))
            await connection.send(json.dumps({**DONE, "stream_request_id": answer["id"]}))
            await connection.send(json.dumps({"type": "event", "event": "chat.final", "stream_request_id": answer["id"],
                                             "payload": {"content": "not the task result"}}))
        await connection.send(json.dumps({"type": "event", "event": "chat.final", "stream_request_id": owner,
                                         "payload": {"content": "complete research"}}))
        await connection.send(json.dumps({**DONE, "stream_request_id": owner}))
    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with ChatRun(f"ws://127.0.0.1:{port}", {"session_id": "s1", "sci_persistent_output": True}, idle_timeout=3) as run:
            async for frame in run:
                seen.append(frame)
                if frame.get("event") == "chat.ask_user_question":
                    await run.answer(frame["payload"]["request_id"], "permission_interrupt", {})
    assert [f["event"] for f in seen] == ["chat.ask_user_question", "chat.ask_user_question", "chat.final", "chat.processing_status"]
    assert seen[-2]["payload"]["content"] == "complete research"


async def test_late_completion_from_previous_approval_stream_cannot_end_resumed_run():
    from sciencediscovery_adapter.events import RunEventMapper

    mapper = RunEventMapper()
    seen = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        for index in range(2):
            previous = request["id"]
            await connection.send(json.dumps({"type": "event", "event": "chat.ask_user_question",
                "stream_request_id": previous, "payload": {"request_id": f"permission-{index}"}}))
            request = json.loads(await connection.recv())
            # The resumed request has already progressed when the old request's
            # final bookkeeping arrives (the ordering from the failed DRB run).
            await connection.send(json.dumps({"type": "event", "event": "chat.delta",
                "stream_request_id": request["id"], "payload": {"content": "working"}}))
            await connection.send(json.dumps({**DONE, "stream_request_id": previous}))
            await connection.send(json.dumps({"type": "event", "event": "chat.final",
                "stream_request_id": previous, "payload": {"content": "stale answer"}}))
            await connection.send(json.dumps({"type": "event", "event": "chat.usage_metadata",
                "stream_request_id": previous, "payload": {}}))
        await connection.send(json.dumps({"type": "event", "event": "chat.final",
            "stream_request_id": request["id"], "payload": {"content": "finished after both approvals"}}))
        await connection.send(json.dumps({**DONE, "stream_request_id": request["id"]}))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/tui"
        async with ChatRun(url, {"session_id": "s1"}, reconnects=0) as run:
            async for frame in run:
                seen.append(frame)
                if frame.get("event") == "chat.ask_user_question":
                    await run.answer(frame["payload"]["request_id"], "permission_interrupt", {"selected_options": ["once"]})
                else:
                    mapper.feed(frame)
                    if frame.get("event") != "chat.processing_status":
                        assert not mapper.finished
    assert mapper.final_text == "finished after both approvals"
    assert mapper.finished
    assert len([f for f in seen if f.get("event") == "chat.processing_status"]) == 1
    assert len([f for f in seen if f.get("event") == "chat.usage_metadata"]) == 2


@pytest.mark.parametrize("event", ["chat.error", "execution.error", "runtime.error", "error"])
async def test_runtime_failure_ends_stream_without_waiting_for_processing_status(event):
    from sciencediscovery_adapter.events import RunEventMapper

    release = asyncio.Event()
    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": event,
            "stream_request_id": request["id"], "payload": {"message": "model client closed", "code": "round_execution_error"}}))
        await release.wait()  # No terminal status follows this failure.

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        try:
            frames = await asyncio.wait_for(collect(f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/tui", {}), 1)
            mapper = RunEventMapper()
            events = [e for f in frames for e in mapper.feed(f)]
            assert mapper.finished
            assert events[-1]["type"] == "run.failed"
            assert events[-1]["error"] == "model client closed"
        finally:
            release.set()


def serve(script):
    """A fake gateway: send the ack, read one request, then play `script(request)`."""
    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        for frame in script(request):
            await connection.send(json.dumps(frame))
    return websockets.serve(handler, "127.0.0.1", 0)


async def collect(url, params):
    return [frame async for frame in chat(url, params)]


async def test_sends_chat_send_and_yields_frames_until_final():
    seen = {}

    def script(request):
        seen.update(request)
        yield {"type": "res", "id": request["id"], "ok": True, "payload": {"accepted": True}}
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "hi"}}
        yield {"type": "event", "event": "chat.final", "payload": {"content": "hi"}}
        yield DONE
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "after the end"}}

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "content": "yo"})
    assert seen["method"] == "chat.send" and seen["is_stream"] is True
    assert seen["params"] == {"session_id": "s1", "content": "yo"}
    assert [f.get("event", f["type"]) for f in frames] == ["res", "chat.delta", "chat.final", "chat.processing_status"]


async def test_stops_after_a_refused_request():
    def script(request):
        yield {"type": "res", "id": request["id"], "ok": False, "error": "nope"}

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {})
    assert len(frames) == 1 and frames[0]["ok"] is False


async def test_unreachable_gateway_is_a_gateway_error():
    with pytest.raises(GatewayError, match="unreachable"):
        await collect("ws://127.0.0.1:9/tui", {})


def serve_connections(*scripts):
    """A fake gateway whose n-th connection plays scripts[n](request); later connections get no answer."""
    counter = {"n": 0}
    requests = []

    async def handler(connection):
        index = counter["n"]
        counter["n"] += 1
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        requests.append(request)
        if index < len(scripts):
            for frame in scripts[index](request):
                await connection.send(json.dumps(frame))

    return websockets.serve(handler, "127.0.0.1", 0), requests


async def drain(url, params, **kwargs):
    async with ChatRun(url, params, reconnect_delay=0.01, **kwargs) as run:
        return [frame async for frame in run], run


DELTA = lambda text: {"type": "event", "event": "chat.delta", "payload": {"content": text}}  # noqa: E731
RESUMED = [{"type": "res", "id": "resume-x", "ok": True, "payload": {}},
           {"type": "event", "event": "chat.interrupt_result", "payload": {"message": "任务已恢复"}}]


async def test_a_connection_lost_mid_run_is_taken_up_again_with_chat_resume():
    server, requests = serve_connections(
        lambda request: [DELTA("a")],
        lambda request: [*RESUMED, DELTA("b"), DONE],
    )
    async with server as running_server:
        port = running_server.sockets[0].getsockname()[1]
        frames, run = await drain(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "m"})
    assert [r["method"] for r in requests] == ["chat.send", "chat.resume"]
    assert requests[1]["params"]["session_id"] == "s1"
    texts = [f["payload"]["content"] for f in frames if f.get("event") == "chat.delta"]
    assert texts == ["a", "b"]
    assert not any(f.get("event") == "chat.interrupt_result" for f in frames), "the gateway's own answer is not a cancellation"
    assert run.resumed == 1


async def test_a_run_that_ended_while_the_connection_was_down_is_an_error_not_a_silent_success():
    server, _ = serve_connections(
        lambda request: [DELTA("a")],
        lambda request: [{"type": "event", "event": "chat.interrupt_result", "payload": {"message": "任务已完成"}}],
    )
    async with server as running_server:
        port = running_server.sockets[0].getsockname()[1]
        with pytest.raises(GatewayError, match="ended while"):
            await drain(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1"})


async def test_a_gateway_that_never_comes_back_is_a_gateway_error_after_the_retries():
    server, requests = serve_connections(lambda request: [DELTA("a")])
    async with server as running_server:
        port = running_server.sockets[0].getsockname()[1]
        # Every later connection is accepted and then ignored: no answer to chat.resume, then the drop again.
        with pytest.raises(GatewayError, match="closed"):
            await drain(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1"}, reconnects=2)
    assert [r["method"] for r in requests] == ["chat.send", "chat.resume", "chat.resume"]


async def test_a_chat_final_alone_does_not_end_the_run():
    """A run paused for approval emits an empty chat.final, then carries on."""
    def script(request):
        yield {"type": "event", "event": "chat.final", "payload": {"content": ""}}
        yield {"type": "event", "event": "chat.delta", "payload": {"content": "later"}}
        yield DONE

    async with serve(script) as server:
        port = server.sockets[0].getsockname()[1]
        frames = await collect(f"ws://127.0.0.1:{port}/tui", {})
    assert [f["event"] for f in frames] == ["chat.final", "chat.delta", "chat.processing_status"]


async def test_answer_resumes_the_paused_run_on_the_same_connection():
    answers = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": "chat.ask_user_question",
                                          "payload": {"request_id": "call_1", "source": "permission_interrupt"}}))
        answers.append(json.loads(await connection.recv()))
        await connection.send(json.dumps({"type": "event", "event": "chat.final", "payload": {"content": "ok"}}))
        await connection.send(json.dumps(DONE))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        seen = []
        async with ChatRun(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "agent.work.normal"}) as run:
            async for frame in run:
                seen.append(frame["event"])
                if frame["event"] == "chat.ask_user_question":
                    await run.answer("call_1", "permission_interrupt", {"selected_options": ["once"], "custom_input": "once"})
    assert seen == ["chat.ask_user_question", "chat.final", "chat.processing_status"]
    assert answers[0]["method"] == "chat.send"
    assert answers[0]["params"] == {
        "session_id": "s1", "query": "", "request_id": "call_1", "source": "permission_interrupt",
        "answers": [{"selected_options": ["once"], "custom_input": "once"}],
        "mode": "agent.work.normal", "supports_user_interaction": True,
    }


async def test_an_is_complete_status_right_after_an_unanswered_question_does_not_end_the_run():
    """Measured live against JiuwenSwarm 0.2.6: unlike the well-behaved mock above, the real gateway sends
    `chat.processing_status` `is_complete` right after `chat.ask_user_question`, without waiting for the
    answer. Read literally that is "the run is over"; taking it at that word ended every approval-gated run
    with no text and no tool result (see gateway.py's `_ends_run` docstring and `_question_pending`)."""
    seen = []
    answered = False

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": "chat.ask_user_question",
                                          "payload": {"request_id": "call_1", "source": "permission_interrupt"}}))
        await connection.send(json.dumps(DONE))  # the real gateway's premature "is_complete"
        answer = json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": "tool.completed", "payload": {}}))
        await connection.send(json.dumps({"type": "event", "event": "chat.final", "payload": {"content": "ok"}}))
        await connection.send(json.dumps(DONE))
        return answer

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with ChatRun(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "m"}) as run:
            async for frame in run:
                seen.append(frame.get("event", frame.get("type")))
                if frame.get("event") == "chat.ask_user_question" and not answered:
                    answered = True
                    await run.answer("call_1", "permission_interrupt", {"selected_options": ["once"]})
    # The premature marker must not reach the mapper, where it would mark the
    # still-active logical run finished and disable disconnect cancellation.
    assert seen == ["chat.ask_user_question", "tool.completed", "chat.final",
                     "chat.processing_status"]


async def test_bookkeeping_frames_around_the_premature_status_do_not_confuse_it_for_the_real_one():
    """Also measured live: the premature `chat.processing_status` is not always the very next frame after
    the question — a variable number of accounting frames (`chat.usage_summary`, `context.usage`, ...) and
    the pause's own empty `chat.final` can sit in between. None of that is the model or a tool doing
    something, so it must not be mistaken for the run having resumed (see `_advances_run`)."""
    seen = []
    answered = False

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        json.loads(await connection.recv())
        # A synthetic "blocked" tool_result can precede the question too; it carries no real result.
        await connection.send(json.dumps({"type": "event", "event": "chat.tool_result",
                                          "payload": {"result": "success=False data=None error=''"}}))
        await connection.send(json.dumps({"type": "event", "event": "chat.ask_user_question",
                                          "payload": {"request_id": "call_1", "source": "permission_interrupt"}}))
        await connection.send(json.dumps({"type": "event", "event": "chat.final", "payload": {"content": ""}}))
        await connection.send(json.dumps({"type": "event", "event": "chat.usage_summary", "payload": {}}))
        await connection.send(json.dumps(DONE))  # premature, behind two bookkeeping frames, not one
        json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "event", "event": "chat.final", "payload": {"content": "ok"}}))
        await connection.send(json.dumps(DONE))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with ChatRun(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "m"}) as run:
            async for frame in run:
                seen.append(frame.get("event", frame.get("type")))
                if frame.get("event") == "chat.ask_user_question" and not answered:
                    answered = True
                    await run.answer("call_1", "permission_interrupt", {"selected_options": ["once"]})
    assert seen == ["chat.tool_result", "chat.ask_user_question", "chat.final", "chat.usage_summary",
                     "chat.final", "chat.processing_status"]


async def test_cancel_sends_chat_interrupt_with_the_cancel_intent():
    seen = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        json.loads(await connection.recv())
        seen.append(json.loads(await connection.recv()))
        await connection.send(json.dumps(DONE))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with ChatRun(f"ws://127.0.0.1:{port}/tui", {"session_id": "s1", "mode": "agent.work.normal"}) as run:
            await run.cancel()
            async for _ in run:
                pass
    assert seen[0]["method"] == "chat.interrupt" and seen[0]["is_stream"] is False
    assert seen[0]["params"] == {"session_id": "s1", "intent": "cancel", "mode": "agent.work.normal"}


async def test_rpc_returns_the_payload_of_the_matching_response():
    seen = []

    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        seen.append(request)
        await connection.send(json.dumps({"type": "event", "event": "noise", "payload": {}}))
        await connection.send(json.dumps({"type": "res", "id": request["id"], "ok": True, "payload": {"type": "connected"}}))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        payload = await rpc(f"ws://127.0.0.1:{port}/ws", "mcp.connect", {"name": "sci"})
    assert payload == {"type": "connected"}
    assert seen[0]["method"] == "mcp.connect" and seen[0]["is_stream"] is False and seen[0]["params"] == {"name": "sci"}


async def test_rpc_refusal_raises():
    async def handler(connection):
        await connection.send(json.dumps({"type": "event", "event": "connection.ack", "payload": {}}))
        request = json.loads(await connection.recv())
        await connection.send(json.dumps({"type": "res", "id": request["id"], "ok": False, "error": "unknown method: x"}))

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        with pytest.raises(GatewayError, match="unknown method"):
            await rpc(f"ws://127.0.0.1:{port}/ws", "x")
