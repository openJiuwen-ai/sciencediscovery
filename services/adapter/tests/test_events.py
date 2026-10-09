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

import pytest

from sciencediscovery_adapter.events import RunEventMapper, classify_failure, parse_tool_result

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize("tool_count", [1, 3])
def test_missing_initial_status_and_parallel_results_do_not_corrupt_display_turns(tool_count):
    mapper = RunEventMapper()
    events = mapper.feed({"type": "event", "event": "chat.delta", "payload": {"content": "first"}})
    for i in range(tool_count):
        events += mapper.feed({"type": "event", "event": "chat.tool_call", "payload": {
            "tool_call": {"name": "test", "tool_call_id": str(i), "arguments": "{}"}}})
    for i in range(tool_count):
        events += mapper.feed({"type": "event", "event": "chat.tool_result", "payload": {
            "tool_name": "test", "tool_call_id": str(i), "result": "ok"}})
    events += mapper.feed({"type": "event", "event": "chat.delta", "payload": {"content": "second"}})
    assert [e["turn"] for e in events if e["type"] == "assistant.response.started"] == [1, 2]


def frames(name: str) -> list[dict]:
    lines = [line.strip() for line in (FIXTURES / name).read_text().splitlines() if line.strip()]
    return [json.loads(line.removeprefix("ACK ")) for line in lines]


def run(name: str) -> tuple[RunEventMapper, list[dict]]:
    mapper = RunEventMapper()
    events: list[dict] = []
    for frame in frames(name):
        events.extend(mapper.feed(frame))
    return mapper, events


def test_plain_reply_maps_to_the_ui_event_sequence():
    mapper, events = run("jw_chat_plain.raw")
    assert [event["type"] for event in events] == [
        "agent.phase",
        "assistant.response.started",
        "assistant.delta", "assistant.delta", "assistant.delta",
        "assistant.response.settled",
    ]
    assert "".join(e["delta"] for e in events if e["type"] == "assistant.delta") == "hello from stub"
    assert mapper.final_text == "hello from stub"
    assert mapper.finished


def test_every_delta_of_one_reply_shares_one_response_id():
    _, events = run("jw_chat_plain.raw")
    started = next(e for e in events if e["type"] == "assistant.response.started")
    ids = {e["responseId"] for e in events if e["type"] in ("assistant.delta", "assistant.response.settled")}
    assert ids == {started["responseId"]}


def test_context_usage_and_ack_are_ignored_on_purpose():
    mapper, _ = run("jw_chat_plain.raw")
    assert mapper.unmapped == []


def test_unknown_events_are_reported_not_dropped_silently():
    mapper = RunEventMapper()
    assert mapper.feed({"type": "event", "event": "chat.brand_new", "payload": {}}) == []
    assert mapper.unmapped == ["chat.brand_new"]


def test_error_settles_the_open_response_then_fails_the_run():
    mapper = RunEventMapper()
    mapper.feed({"type": "event", "event": "chat.delta", "payload": {"content": "par"}})
    events = mapper.feed({"type": "event", "event": "chat.error", "payload": {
        "error": "[181001] model call failed, reason: openAI API async stream error: APIConnectionError: Connection error."}})
    assert [e["type"] for e in events] == ["assistant.response.settled", "run.failed"]
    assert events[1]["errorCode"] == "transport-error"
    assert "APIConnectionError" in events[1]["error"]
    assert mapper.finished


def test_refused_request_fails_the_run_with_the_gateway_message():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "res", "id": "x", "ok": False, "error": {"code": "bad", "message": "no such session"}})
    assert events == [{"type": "run.failed", "error": "no such session", "errorCode": "semantic-error"}]


def test_interrupt_maps_to_cancelled():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "event", "event": "chat.interrupt_result", "payload": {"message": "stopped"}})
    assert events == [{"type": "run.cancelled", "reason": "stopped"}]
    assert mapper.finished


def test_reasoning_streams_as_thinking_deltas():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "event", "event": "chat.reasoning", "payload": {"content": "hmm"}})
    assert [e["type"] for e in events] == ["assistant.response.started", "assistant.thinking.delta"]
    assert events[1]["delta"] == "hmm"


@pytest.mark.parametrize("text,code", [
    ("HTTP 401 Unauthorized", "unauthorized"),
    ("429 rate limit exceeded", "rate-limited"),
    ("request timed out", "timeout"),
    ("APIConnectionError: Connection error.", "transport-error"),
    ("upstream 503", "server-error"),
    ("bad tool arguments", "semantic-error"),
])
def test_failure_classification(text, code):
    assert classify_failure(text) == code


def test_tool_round_maps_to_started_output_completed_then_a_new_response():
    mapper, events = run("jw_chat_bash.raw")
    kinds = [e["type"] for e in events]
    # A model call that only produced a tool call still announces (and closes) a response,
    # as the native agent does.
    assert kinds[:6] == ["agent.phase", "assistant.response.started", "assistant.response.settled",
                         "tool.started", "tool.output", "tool.completed"]
    assert kinds[6] == "assistant.response.started" and kinds[-1] == "assistant.response.settled"
    started, completed = events[3]["trace"], events[5]["trace"]
    assert started["name"] == "bash" and started["status"] == "running"
    assert started["args"] == {"command": "echo J-MARK-1 && pwd"}
    assert started["summary"].startswith("执行 ")
    assert completed["id"] == started["id"] and completed["status"] == "completed"
    assert "J-MARK-1" in completed["output"] and "Exit Code: 0" in completed["output"]
    assert events[4] == {"type": "tool.output", "toolCallId": started["id"], "chunk": completed["output"]}
    assert mapper.final_text == "tool finished ok"
    assert mapper.unmapped == []


def test_the_reply_after_a_tool_is_a_new_response_in_a_later_turn():
    _, events = run("jw_chat_bash.raw")
    started = [e for e in events if e["type"] == "assistant.response.started"]
    assert [e["turn"] for e in started] == [1, 2]  # the tool-only call, then the answer after the tool


def test_tool_result_repr_is_parsed():
    ok, text = parse_tool_result("success=True data={'content': 'a\\nb'} error=None extracted_content=None x=1")
    assert (ok, text) == (True, "a\nb")


def test_failed_tool_result_carries_the_error_text():
    ok, text = parse_tool_result("success=False data=None error='boom: no such file' extracted_content=None x=1")
    assert (ok, text) == (False, "boom: no such file")


def test_unparseable_tool_result_is_passed_through_not_lost():
    assert parse_tool_result("something else") == (True, "something else")


def test_a_run_is_finished_by_the_completion_status_not_by_chat_final():
    mapper = RunEventMapper()
    mapper.feed({"type": "event", "event": "chat.final", "payload": {"content": "partial"}})
    assert not mapper.finished
    mapper.feed({"type": "event", "event": "chat.processing_status", "payload": {"is_processing": False, "is_complete": True}})
    assert mapper.finished


def test_an_empty_final_does_not_erase_the_reply():
    mapper = RunEventMapper()
    mapper.feed({"type": "event", "event": "chat.final", "payload": {"content": "answer"}})
    mapper.feed({"type": "event", "event": "chat.final", "payload": {"content": ""}})
    assert mapper.final_text == "answer"


def test_approval_pause_becomes_one_permission_request_and_no_failed_tool():
    mapper, events = run("jw_chat_approval.raw")
    kinds = [e["type"] for e in events]
    assert kinds.count("permission.required") == 1
    required = next(e for e in events if e["type"] == "permission.required")["request"]
    assert required["state"] == "pending" and required["action"] == "code"
    assert required["id"] == required["toolCallId"] and required["resource"] == "write /tmp/j-mark-2"
    # The gateway's empty-error tool_result that precedes the question is the
    # pause marker, not a failed tool call.
    assert not any(e["type"] == "tool.completed" and e["trace"]["status"] == "failed" for e in events)
    # After the (recorded) answer the call starts and completes exactly once.
    assert kinds.count("tool.started") == 1 and kinds.count("tool.completed") == 1
    assert mapper.final_text == "approved and done"
    assert mapper.finished and mapper.unmapped == []


def test_decide_picks_the_gateway_option_by_position():
    mapper = RunEventMapper(session_id="s1")
    mapper.feed({"type": "event", "event": "chat.ask_user_question", "payload": {
        "request_id": "call_1", "source": "permission_interrupt",
        "questions": [{"question": "write /x", "header": "权限审批: bash", "options": [
            {"label": "本次允许"}, {"label": "会话内记住"}, {"label": "永久记住"}, {"label": "拒绝"}]}]}})
    assert mapper.awaiting_permission
    answer, resolved = mapper.decide("call_1", "allow_once")
    assert answer == {"selected_options": ["本次允许"], "custom_input": "本次允许"}
    assert resolved["type"] == "permission.resolved"
    assert resolved["request"]["state"] == "allowed" and resolved["request"]["sessionId"] == "s1"
    assert not mapper.awaiting_permission


def test_decide_deny_and_allow_matching():
    def ask():
        mapper = RunEventMapper()
        mapper.feed({"type": "event", "event": "chat.ask_user_question", "payload": {
            "request_id": "c", "source": "permission_interrupt",
            "questions": [{"question": "q", "options": [{"label": "A"}, {"label": "B"}, {"label": "C"}, {"label": "D"}]}]}})
        return mapper

    answer, resolved = ask().decide("c", "deny")
    assert answer["selected_options"] == ["D"] and resolved["request"]["decision"] == "denied"
    answer, resolved = ask().decide("c", "allow_matching")
    assert answer["selected_options"] == ["B"] and resolved["request"]["decision"] == "allowed"


def test_other_question_sources_are_reported_as_unmapped():
    mapper = RunEventMapper()
    assert mapper.feed({"type": "event", "event": "chat.ask_user_question",
                        "payload": {"request_id": "r", "source": "ask_user_interrupt"}}) == []
    assert mapper.unmapped == ["chat.ask_user_question:ask_user_interrupt"]


def test_tool_result_without_the_trailing_fields_is_still_parsed():
    assert parse_tool_result("success=False data=None error=''") == (False, "")


def test_output_containing_error_equals_is_not_split():
    result = "success=True data={'content': 'log: retry error=5 done'} error=None extracted_content=None x=1"
    assert parse_tool_result(result) == (True, "log: retry error=5 done")


def decide_in_recording(name, decision):
    """Replay a recorded approval run, deciding when the question arrives."""
    mapper = RunEventMapper(session_id="s")
    events = []
    for frame in frames(name):
        new = mapper.feed(frame)
        events.extend(new)
        for event in new:
            if event["type"] == "permission.required":
                events.append(mapper.decide(event["request"]["id"], decision)[1])
    return mapper, events


def test_a_denied_call_is_a_failed_tool_not_a_successful_one():
    mapper, events = decide_in_recording("jw_chat_deny.raw", "deny")
    resolved = next(e for e in events if e["type"] == "permission.resolved")["request"]
    assert resolved["state"] == "denied"
    completed = next(e for e in events if e["type"] == "tool.completed")["trace"]
    assert completed["status"] == "failed" and completed["output"] == "Denied by the user."
    assert mapper.finished and mapper.unmapped == []


def test_cancel_ends_the_run_as_cancelled_without_an_interrupt_result_frame():
    mapper = RunEventMapper()
    events = []
    for index, frame in enumerate(frames("jw_chat_cancel.raw")):
        if index == 2:  # the user presses stop after the run has started
            mapper.request_cancel()
        events.extend(mapper.feed(frame))
    assert [e["type"] for e in events][-1] == "run.cancelled"
    assert mapper.finished and mapper.unmapped == []


def test_completion_without_a_cancel_request_is_not_cancelled():
    _, events = run("jw_chat_plain.raw")
    assert "run.cancelled" not in [e["type"] for e in events]


def test_mcp_tool_is_shown_once_by_its_own_name_not_as_a_tool_call_wrapper():
    mapper = RunEventMapper(mcp_prefixes=("mcp_sci_",))
    events = []
    for frame in frames("jw_chat_mcp.raw"):
        events.extend(mapper.feed(frame))
    started = [e["trace"] for e in events if e["type"] == "tool.started"]
    assert [t["name"] for t in started] == ["tool_search", "run_shell"]
    assert started[1]["args"] == {"command": "echo J-MCP-1"}
    assert not any(t["id"].endswith(":target") for t in started)
    completed = {e["trace"]["name"]: e["trace"] for e in events if e["type"] == "tool.completed"}
    assert completed["run_shell"]["output"] == "SPIKE-OUT: echo J-MCP-1"
    assert completed["run_shell"]["status"] == "completed"
    assert len([e for e in events if e["type"] == "tool.completed"]) == 2
    assert mapper.final_text == "mcp done"
    assert mapper.unmapped == []


def test_without_a_prefix_the_mcp_tool_keeps_the_gateway_name():
    mapper = RunEventMapper()
    events = []
    for frame in frames("jw_chat_mcp.raw"):
        events.extend(mapper.feed(frame))
    assert [e["trace"]["name"] for e in events if e["type"] == "tool.started"] == ["tool_search", "mcp_sci_run_shell"]


def test_a_directly_exposed_mcp_tool_maps_without_any_wrapper():
    mapper = RunEventMapper(mcp_prefixes=("mcp_sci_",))
    events = []
    for frame in frames("jw_chat_mcp_direct.raw"):
        events.extend(mapper.feed(frame))
    started = [e["trace"] for e in events if e["type"] == "tool.started"]
    assert [t["name"] for t in started] == ["run_shell"]
    completed = next(e for e in events if e["type"] == "tool.completed")["trace"]
    assert completed["output"] == "SPIKE-OUT: echo J-DIRECT" and completed["status"] == "completed"
    assert mapper.final_text == "direct done" and mapper.finished and mapper.unmapped == []


def test_per_call_usage_becomes_model_usage_and_the_summary_is_ignored_on_purpose():
    mapper, events = run("jw_usage.raw")
    assert events == [{
        "type": "model.usage", "reasoningTokens": 71,
        "usage": {"inputTokens": 731, "outputTokens": 87, "totalTokens": 818, "cacheReadTokens": 0, "cacheWriteTokens": None},
    }]
    assert mapper.unmapped == []


def test_usage_without_token_counts_emits_nothing():
    mapper = RunEventMapper()
    assert mapper.feed({"type": "event", "event": "chat.usage_metadata", "payload": {"metadata": {"usage_metadata": {}}}}) == []


def test_response_ids_are_uuids_like_the_native_agents():
    import re
    _, events = run("jw_chat_plain.raw")
    started = next(e for e in events if e["type"] == "assistant.response.started")
    assert re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", started["responseId"])


@pytest.mark.parametrize("text,code", [
    # Recorded from a real 0.2.6 gateway whose model answered with each of these (tools/probe_gateway.py).
    ("[181001] model call failed, reason: openAI API async stream error: AuthenticationError: Error code: 401 - {'error': {'message': 'scripted http401'}}", "unauthorized"),
    ("[181001] model call failed, reason: openAI API async stream error: RateLimitError: Error code: 429 - {'error': {'message': 'scripted http429'}}", "rate-limited"),
    ("[181001] model call failed, reason: openAI API async stream error: InternalServerError: Error code: 500 - {'error': {'message': 'scripted http500'}}", "server-error"),
    ("[181001] model call failed, reason: openAI API async stream error: JSONDecodeError: Expecting property name enclosed in double quotes", "semantic-error"),
])
def test_real_gateway_model_errors_are_classified(text, code):
    assert classify_failure(text) == code


def test_jiuwenswarms_todo_list_becomes_a_plan_update_with_its_whole_list():
    mapper = RunEventMapper()
    events = mapper.feed({"type": "event", "event": "todo.updated", "payload": {"todos": [
        {"id": "a", "content": "Step A", "activeForm": "Doing A", "status": "in_progress"},
        {"id": "b", "content": "Step B", "activeForm": "Doing B", "status": "pending"}]}})
    assert events == [{"type": "plan.updated", "items": [
        {"id": "a", "content": "Step A", "status": "in_progress"}, {"id": "b", "content": "Step B", "status": "pending"}]}]
    assert mapper.unmapped == []


def test_a_jiuwenswarm_tool_is_marked_native_and_one_of_ours_is_not():
    mapper = RunEventMapper(mcp_prefixes=("mcp_sci_",))
    own = mapper.feed({"type": "event", "event": "chat.tool_call", "payload": {"tool_call": {"name": "bash", "arguments": "{}", "tool_call_id": "a"}}})
    ours = mapper.feed({"type": "event", "event": "chat.tool_call", "payload": {"tool_call": {"name": "mcp_sci_run_shell", "arguments": "{}", "tool_call_id": "b"}}})
    started = [e for e in own + ours if e["type"] == "tool.started"]
    assert started[0]["trace"].get("native") is True and started[0]["trace"]["name"] == "bash"
    assert "native" not in started[1]["trace"] and started[1]["trace"]["name"] == "run_shell"


def test_the_run_tag_is_not_part_of_a_reported_call():
    from sciencediscovery_adapter.events import RunEventMapper

    mapper = RunEventMapper(session_id="s1", mcp_prefixes=("mcp_sci_",))
    events = mapper.feed({"type": "event", "event": "chat.tool_call", "payload": {"tool_call": {
        "tool_call_id": "c1", "name": "mcp_sci_run_shell", "arguments": '{"command": "ls", "_sd_run": "abc"}'}}})
    started = next(event for event in events if event["type"] == "tool.started")
    assert started["trace"]["args"] == {"command": "ls"} and "_sd_run" not in started["trace"]["input"]
