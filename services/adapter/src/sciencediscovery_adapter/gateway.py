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

"""WebSocket client for the JiuwenSwarm gateway."""

from __future__ import annotations

import asyncio
from copy import deepcopy
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import websockets

class GatewayError(RuntimeError):
    """The gateway could not be reached or broke the protocol."""


_FAILURE_EVENTS = frozenset({"chat.error", "execution.error", "runtime.error", "error"})
_RETIRED_EVENTS = frozenset({
    "chat.processing_status", "chat.final",
}) | _FAILURE_EVENTS


def _ends_run(frame: dict[str, Any]) -> bool:
    """True for the last frame the gateway sends for a run.

    `chat.final` is not it: a run that pauses for approval emits an empty
    `chat.final`, then carries on after the answer. The gateway closes every run
    with `chat.processing_status` `is_complete`, and a refused request or a
    `chat.error` (which is followed by that status too) needs no answer. But a
    run paused on `chat.ask_user_question` (a permission question included)
    also gets an `is_complete` `chat.processing_status`, on JiuwenSwarm 0.2.6 —
    measured live, not documented — without waiting for the answer first, mixed
    in with a handful of bookkeeping frames of its own (an empty `chat.final`,
    usage/context accounting) whose count varies by call. That one does not end
    the run either: see `ChatRun._question_pending`, which this function alone
    cannot tell apart from a genuine end since it sees one frame at a time.
    """
    if frame.get("type") == "res":
        return frame.get("ok") is False
    payload = frame.get("payload") or {}
    event = frame.get("event")
    if event == "chat.processing_status":
        return bool(payload.get("is_complete")) and not payload.get("is_processing")
    return event == "chat.interrupt_result" or event in _FAILURE_EVENTS


def _asked_question_id(frame: dict[str, Any]) -> str | None:
    """The `request_id` of a `chat.ask_user_question` frame (`None` for any other frame)."""
    if frame.get("event") != "chat.ask_user_question":
        return None
    request_id = (frame.get("payload") or {}).get("request_id")
    return str(request_id) if request_id else None


# Bookkeeping the gateway interleaves with a paused run's own frames (measured live): none of it is the
# model or a tool actually doing something, so none of it means the run has resumed.
_BOOKKEEPING_EVENTS = frozenset({"context.usage", "chat.usage_metadata", "chat.usage_summary"})


def _advances_run(frame: dict[str, Any]) -> bool:
    """True for a frame that is the model or a tool actually doing something, once a question is pending
    (see `ChatRun._question_pending`) — the run has genuinely resumed, so the next `_ends_run` frame is real.

    False for bookkeeping (`_BOOKKEEPING_EVENTS`), an empty `chat.final` (the pause's own marker, same as
    `_ends_run`'s docstring), a bare `res` acknowledgement, `chat.processing_status` itself (a status, not
    work — and the frame `_ends_run` is about to read `_question_pending` for; this function must not have
    already cleared it), and `chat.ask_user_question` (handled by its caller, which sets `_question_pending`
    rather than asking this function).
    """
    event = frame.get("event")
    if event is None or event in _BOOKKEEPING_EVENTS or event in ("chat.ask_user_question", "chat.processing_status"):
        return False
    if event == "chat.final":
        return bool((frame.get("payload") or {}).get("content"))
    return True


class ChatRun:
    """One chat run on one gateway connection.

    Iterate to receive frames. While the run waits for an approval the iterator
    simply blocks; `answer()` (from another task) resumes it on the same
    connection, as the JiuwenSwarm CLI does.
    """

    def __init__(self, url: str, params: dict[str, Any], *, idle_timeout: float | None = None,
                 reconnects: int = 3, reconnect_delay: float = 0.5) -> None:
        self._url = url
        self._params = deepcopy(params)
        self._idle_timeout = idle_timeout
        self._connection: Any = None
        self._reconnects = reconnects
        self._reconnect_delay = reconnect_delay
        #: How many times the connection was lost mid-run and taken up again (frames in between are gone).
        self.resumed = 0
        # Reconnects in a row that brought no frame; a frame from the run starts the count again.
        self._misses = 0
        # True from a `chat.ask_user_question` frame until a frame that is the model or a tool actually
        # doing something (`_advances_run`) — never on `answer()` being called, which races the gateway's
        # own premature completion already in flight over the same connection (see `_ends_run`). While
        # true, an `is_complete` `chat.processing_status` is that premature one, not the run ending.
        self._question_pending = False
        # Approval answers start a new transport request for the same logical
        # run. Old terminal frames can arrive AFTER new model/tool progress.
        # Correlate them before yielding to the mapper or releasing resources.
        self._active_request_id: str | None = None
        self._retired_request_ids: set[str] = set()
        self._persistent_output = bool(params.get("sci_persistent_output"))
        self._output_owner: str | None = None
        self._pending_questions: set[str] = set()

    async def _connect(self) -> None:
        try:
            self._connection = await websockets.connect(self._url, max_size=None)
        except OSError as error:
            raise GatewayError(f"gateway unreachable at {self._url}: {error}") from error
        ack = json.loads(await self._connection.recv())
        if ack.get("event") != "connection.ack":
            await self._connection.close()
            raise GatewayError(f"expected connection.ack, got {ack.get('type')}/{ack.get('event')}")

    async def __aenter__(self) -> "ChatRun":
        await self._connect()
        await self._send("chat", "chat.send", self._params)
        return self

    async def _reattach(self) -> bool:
        """Take the run up again on a new connection with `chat.resume`.

        Measured on JiuwenSwarm 0.2.6: a run keeps going when its client's connection drops; `chat.resume`
        from a new connection answers `chat.interrupt_result` "task resumed" and the run's frames flow to
        it again, but nothing sent in the gap is replayed. It answers "task completed" when there is no
        run to take up. Returns whether a live run was found.
        """
        while self._misses < self._reconnects:
            self._misses += 1
            await asyncio.sleep(self._reconnect_delay * self._misses)
            try:
                await self._connect()
            except (GatewayError, websockets.WebSocketException, OSError):
                continue
            await self._send("resume", "chat.resume", {
                "session_id": self._params["session_id"], "query": "", "mode": self._params.get("mode"),
                "supports_user_interaction": True,
            })
            self.resumed += 1
            return True
        return False

    async def __aexit__(self, *exc_info: object) -> None:
        if self._connection is not None:
            await self._connection.close()

    async def _send(self, prefix: str, method: str, params: dict[str, Any]) -> None:
        request_id = f"{prefix}-{uuid.uuid4().hex[:12]}"
        if method == "chat.send" and (not self._persistent_output or self._active_request_id is None):
            if self._active_request_id:
                self._retired_request_ids.add(self._active_request_id)
            self._active_request_id = request_id
        await self._connection.send(json.dumps({
            "type": "req", "id": request_id, "method": method,
            "is_stream": True, "params": params,
        }, ensure_ascii=False))

    async def answer(self, request_id: str, source: str, answer: dict[str, Any]) -> None:
        """Resume a run paused on `chat.ask_user_question`."""
        # Approval continues this run; it must not replace its tools, workspace
        # or private model route with session/global defaults. Do not replay the
        # original query, attachments or other one-shot input fields.
        context = {key: deepcopy(self._params[key]) for key in (
            "mode", "agent_ref", "model_name", "run_model", "cwd", "project_dir",
            "trusted_dirs", "mcp", "agent_template_name", "plugin_names",
        ) if key in self._params}
        await self._send("answer", "chat.send", {
            **context,
            "session_id": self._params["session_id"], "query": "", "request_id": request_id,
            "answers": [answer], "source": source, "mode": self._params.get("mode"),
            "supports_user_interaction": True,
            **({"sci_persistent_output": True} if self._persistent_output else {}),
        })
        self._pending_questions.discard(request_id)

    async def cancel(self) -> None:
        """Ask the gateway to stop the run. It answers with a `res` and then ends
        the run with the usual completion status."""
        await self._connection.send(json.dumps({
            "type": "req", "id": f"interrupt-{uuid.uuid4().hex[:12]}", "method": "chat.interrupt",
            "is_stream": False,
            "params": {"session_id": self._params["session_id"], "intent": "cancel", "mode": self._params.get("mode")},
        }))

    def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        return self._frames()

    async def _frames(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            try:
                raw = await asyncio.wait_for(self._connection.recv(), self._idle_timeout)
            except websockets.ConnectionClosed as error:
                if not await self._reattach():
                    raise GatewayError("gateway closed the connection mid-run") from error
                continue
            frame = json.loads(raw)
            # Older Swarm converters mislabeled unary startup failures as chat.final.
            # Normalize before output-owner filtering; no lease exists at startup.
            owner = frame.get("stream_request_id")
            if (frame.get("event") == "chat.final"
                    and (frame.get("payload") or {}).get("error")
                    and owner in {self._active_request_id, self._output_owner}
                    and owner is not None):
                frame["event"] = "chat.error"
            if (frame.get("event") in _FAILURE_EVENTS
                    and owner in self._retired_request_ids
                    and owner != self._output_owner):
                continue
            if self.resumed:
                if _no_run_to_resume(frame):
                    # The run ended while we were away: what it said in the gap is gone.
                    raise GatewayError("the run ended while the connection to the gateway was down")
                if _resume_answer(frame):
                    continue
            self._misses = 0
            if self._persistent_output:
                event = frame.get("event")
                owner = frame.get("stream_request_id")
                if event == "runtime.output_owner":
                    self._output_owner = owner or (frame.get("payload") or {}).get("request_id")
                    continue
                question = _asked_question_id(frame)
                if question:
                    if question in self._pending_questions:
                        continue
                    self._pending_questions.add(question)
                # Control requests may finish while the execution continues.
                # Only the stream that actually owns the SDK output lease can
                # close this logical run. An acknowledgement is not progress.
                if event == "runtime.accepted":
                    continue
                if event in {"chat.processing_status", "chat.final"}:
                    if not self._output_owner or owner != self._output_owner:
                        continue
                yield frame
                if _ends_run(frame):
                    return
                continue
            if (frame.get("stream_request_id") in self._retired_request_ids
                    and frame.get("event") in _RETIRED_EVENTS):
                continue
            if _asked_question_id(frame):
                self._question_pending = True
            elif _advances_run(frame):
                self._question_pending = False
            if (frame.get("event") == "chat.processing_status" and _ends_run(frame)
                    and self._question_pending):
                # Even for older gateways without correlation metadata, do not
                # leak a pause's terminal marker to RunEventMapper.finished.
                continue
            yield frame
            if _ends_run(frame):
                return


def _notice(frame: dict[str, Any]) -> str:
    """The text of a `chat.interrupt_result` frame ("" for any other frame)."""
    if frame.get("event") != "chat.interrupt_result":
        return ""
    payload = frame.get("payload") or {}
    return str(payload.get("message") or payload.get("content") or "")


def _no_run_to_resume(frame: dict[str, Any]) -> bool:
    """`chat.resume` found nothing running: JiuwenSwarm answers with a completed-task notice."""
    return "已完成" in _notice(frame)


def _resume_answer(frame: dict[str, Any]) -> bool:
    """The gateway's own answer to a `chat.resume` (`res`, then "task resumed"); not part of the run."""
    return (frame.get("type") == "res" and str(frame.get("id", "")).startswith("resume-")) or "已恢复" in _notice(frame)


async def chat(url: str, params: dict[str, Any], *, idle_timeout: float | None = None) -> AsyncIterator[dict[str, Any]]:
    """Run a chat that needs no approval and yield its frames."""
    async with ChatRun(url, params, idle_timeout=idle_timeout) as run:
        async for frame in run:
            yield frame


async def rpc(url: str, method: str, params: dict[str, Any] | None = None, *, timeout: float = 30) -> dict[str, Any]:
    """One non-streaming management call (`mcp.*`, `permissions.*`, ...).

    Returns the response payload; a refusal raises GatewayError. Management
    methods are served on the web channel (`ws://<host>:<web port>/ws`), not on
    the `/tui` route chats use.
    """
    try:
        connection = await websockets.connect(url, max_size=None)
    except OSError as error:
        raise GatewayError(f"gateway unreachable at {url}: {error}") from error
    async with connection:
        await asyncio.wait_for(connection.recv(), timeout)  # connection.ack
        request_id = f"rpc-{uuid.uuid4().hex[:12]}"
        await connection.send(json.dumps({
            "type": "req", "id": request_id, "method": method, "is_stream": False, "params": params or {},
        }, ensure_ascii=False))
        while True:
            frame = json.loads(await asyncio.wait_for(connection.recv(), timeout))
            if frame.get("type") == "res" and frame.get("id") == request_id:
                break
    if not frame.get("ok"):
        raise GatewayError(f"{method} refused: {frame.get('error') or frame.get('payload')}")
    return frame.get("payload") or {}
