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

"""`completion_for`'s wire format: what actually lands in the request body.

A gateway seen in production rejects every ``temperature`` value except the
one it is configured with (``HTTP 400 invalid temperature: only 0.6 is
allowed for this model``), and both engines used to send one unconditionally
— PUCT through `completion_for`'s own default of 0.7, OpenEvolve through its
own `spec.options.get("temperature", 0.7)`. Every mutation call failed as a
result. These tests pin the fix at the one place both engines share: no
caller-supplied value means the field is left out of the request entirely,
the same treatment `thinking` already gets.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, Iterator, List

import pytest

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

from sciencediscovery_evolve.completion import completion_for


class _RecordingModel(BaseHTTPRequestHandler):
    bodies: List[Dict[str, Any]] = []

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's name
        length = int(self.headers.get("content-length", "0"))
        _RecordingModel.bodies.append(json.loads(self.rfile.read(length) or b"{}"))
        payload = json.dumps({
            "choices": [{"message": {"content": "ok"}}],
            "usage": {"completion_tokens": 1, "prompt_tokens": 1, "total_tokens": 2},
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_: Any) -> None:
        return


@pytest.fixture
def model_server() -> Iterator[str]:
    _RecordingModel.bodies = []
    server = HTTPServer(("127.0.0.1", 0), _RecordingModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
    finally:
        server.shutdown()
        server.server_close()


def test_omits_temperature_by_default(model_server: str):
    complete = completion_for(model_server, "token")
    complete("hello")
    assert "temperature" not in _RecordingModel.bodies[0]


def test_sends_temperature_when_given(model_server: str):
    complete = completion_for(model_server, "token", temperature=0.6)
    complete("hello")
    assert _RecordingModel.bodies[0]["temperature"] == 0.6


@pytest.mark.parametrize("usage", [None, [], ["malformed"], "malformed", {},
                                  "nan-count",
                                  {"total_tokens": -1, "completion_tokens": 1},
                                  {"total_tokens": True, "completion_tokens": 0},
                                  {"total_tokens": 2}, {"total_tokens": 1, "completion_tokens": 2}, {"total_tokens": 2.5, "completion_tokens": 1}, {"total_tokens": 2, "completion_tokens": 0.5}])
def test_malformed_usage_does_not_discard_valid_text(usage, monkeypatch):
    import io
    if usage == "nan-count":
        usage = {"total_tokens": float("nan"), "completion_tokens": 1}
    recorded = []
    payload = dict(choices=[dict(message=dict(content="valid result"))], usage=usage)
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(payload).encode()))
    assert completion_for("http://synthetic.test", "synthetic", on_usage=recorded.append)("synthetic") == "valid result"
    assert recorded == []


def test_accounting_failure_does_not_discard_valid_text(model_server):
    def fail(_usage):
        raise RuntimeError("accounting unavailable")
    assert completion_for(model_server, "synthetic", on_usage=fail)("synthetic") == "ok"


def test_forwards_frozen_low_effort(model_server):
    completion_for(model_server, "token", thinking="enabled", thinking_effort="low")("hello")
    assert _RecordingModel.bodies[0]["thinking"] == {"type": "enabled"}
    assert _RecordingModel.bodies[0]["reasoning_effort"] == "low"


def test_auto_omits_thinking_wire_controls_even_with_snapshot_effort(model_server):
    completion_for(model_server, "token", thinking="auto", thinking_effort="high")("hello")
    assert "thinking" not in _RecordingModel.bodies[0]
    assert "reasoning_effort" not in _RecordingModel.bodies[0]


@pytest.mark.parametrize("status", [502, 503, 504, 524])
def test_transient_http_failure_retries_then_succeeds(status, monkeypatch):
    import io
    import urllib.error
    calls = []

    def respond(*args, **kwargs):
        calls.append(kwargs["timeout"])
        if len(calls) == 1:
            raise urllib.error.HTTPError("http://synthetic.test", status, "transient", {}, io.BytesIO(b"retry"))
        return io.BytesIO(b'{"choices":[{"message":{"content":"recovered"}}]}')

    monkeypatch.setattr("urllib.request.urlopen", respond)
    assert completion_for("http://synthetic.test", "token", retry_backoff=0)("hello") == "recovered"
    assert len(calls) == 2
    assert 0 < calls[1] < calls[0], "retries share the original deadline"


@pytest.mark.parametrize("status,expected", [(524, 3), (400, 1), (401, 1), (422, 1), (429, 1)])
def test_http_retry_limit_and_nonretryable_errors(status, expected, monkeypatch):
    import io
    import urllib.error
    calls, failures = [], []

    def respond(*args, **kwargs):
        calls.append(1)
        raise urllib.error.HTTPError("http://synthetic.test", status, "failure", {}, io.BytesIO(b"failed"))

    monkeypatch.setattr("urllib.request.urlopen", respond)
    assert completion_for("http://synthetic.test", "token", max_retries=99, retry_backoff=0)("hello", on_failure=failures.append) == ""
    assert len(calls) == expected
    assert len(failures) == 1 and f"HTTP {status}" in failures[0]


def test_capped_empty_completion_is_charged_once_without_retry(monkeypatch):
    import io
    calls, usage = [], []

    def respond(*args, **kwargs):
        calls.append(1)
        return io.BytesIO(b'{"choices":[{"message":{"content":null},"finish_reason":"length"}],"usage":{"completion_tokens":16000,"total_tokens":16010}}')

    monkeypatch.setattr("urllib.request.urlopen", respond)
    assert completion_for("http://synthetic.test", "token", on_usage=usage.append)("hello") == ""
    assert len(calls) == 1
    assert len(usage) == 1 and usage[0].capped and usage[0].total == 16010


def test_stop_after_failure_prevents_retry(monkeypatch):
    import io
    import urllib.error
    stopped = threading.Event()
    calls = []

    def respond(*args, **kwargs):
        calls.append(1)
        stopped.set()
        raise urllib.error.HTTPError("http://synthetic.test", 524, "timeout", {}, io.BytesIO())

    monkeypatch.setattr("urllib.request.urlopen", respond)
    assert completion_for("http://synthetic.test", "token", should_stop=stopped.is_set)("hello") == ""
    assert calls == [1]


def test_deadline_expires_during_retry_backoff(monkeypatch):
    import io
    import time
    import urllib.error
    calls, failures = [], []

    def respond(*args, **kwargs):
        calls.append(1)
        raise urllib.error.HTTPError("http://synthetic.test", 524, "timeout", {}, io.BytesIO())

    monkeypatch.setattr("urllib.request.urlopen", respond)
    began = time.monotonic()
    assert completion_for("http://synthetic.test", "token", timeout=0.1, retry_backoff=10)("hello", on_failure=failures.append) == ""
    assert time.monotonic() - began < 1
    assert calls == [1] and len(failures) == 1
    assert "deadline" in failures[0]


def test_socket_that_keeps_reading_cannot_extend_wall_deadline(monkeypatch):
    import io
    import time
    finished = threading.Event()

    def respond(*args, **kwargs):
        finished.wait(2)
        return io.BytesIO(b'{"choices":[{"message":{"content":"too late"}}]}')

    monkeypatch.setattr("urllib.request.urlopen", respond)
    failures = []
    try:
        began = time.monotonic()
        assert completion_for("http://synthetic.test", "token", timeout=0.1)("hello", on_failure=failures.append) == ""
        assert time.monotonic() - began < 1
        assert failures == ["completion call deadline exceeded"]
    finally:
        finished.set()
