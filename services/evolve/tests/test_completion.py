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


@pytest.mark.parametrize("status", [429, 502, 524])
def test_transient_http_failure_retries_same_mutation_and_reports_usage_once(status, monkeypatch):
    import io
    import urllib.error
    calls, usage, failures = [], [], []
    def request(req, **kwargs):
        calls.append(req.data)
        if len(calls) < 3:
            raise urllib.error.HTTPError(req.full_url, status, "temporary", {}, io.BytesIO(b"temporary"))
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": "candidate"}}],
                                     "usage": {"completion_tokens": 3, "total_tokens": 5}}).encode())
    monkeypatch.setattr("urllib.request.urlopen", request)
    result = completion_for("http://synthetic.test", "synthetic", thinking="enabled", max_tokens=96_000)(
        "same mutation", usage.append, failures.append)
    assert result == "candidate"
    assert len(calls) == 3 and len(set(calls)) == 1
    assert len(usage) == 1 and usage[0].total == 5
    assert failures == []


@pytest.mark.parametrize("status, expected", [(400, 1), (401, 1), (524, 3)])
def test_permanent_or_exhausted_http_failure_stays_failed(status, expected, monkeypatch):
    import io
    import urllib.error
    calls, failures = [], []
    def request(req, **kwargs):
        calls.append(req)
        raise urllib.error.HTTPError(req.full_url, status, "failed", {}, io.BytesIO(b"upstream unavailable"))
    monkeypatch.setattr("urllib.request.urlopen", request)
    assert completion_for("http://synthetic.test", "synthetic")("mutate", on_failure=failures.append) == ""
    assert len(calls) == expected
    assert len(failures) == 1 and f"HTTP {status}" in failures[0]


def test_stop_during_backoff_prevents_next_paid_call(monkeypatch):
    import io
    import urllib.error
    stopped, calls = [], []
    def request(req, **kwargs):
        calls.append(req)
        stopped.append(True)
        raise urllib.error.HTTPError(req.full_url, 524, "timeout", {}, io.BytesIO(b"timeout"))
    monkeypatch.setattr("urllib.request.urlopen", request)
    assert completion_for("http://synthetic.test", "synthetic", should_stop=lambda: bool(stopped))("mutate") == ""
    assert len(calls) == 1


def test_malformed_json_and_empty_model_answer_are_not_transport_retried(monkeypatch):
    import io
    calls = []
    def request(*args, **kwargs):
        calls.append(1)
        return io.BytesIO(b"not json")
    monkeypatch.setattr("urllib.request.urlopen", request)
    assert completion_for("http://synthetic.test", "synthetic")("mutate") == ""
    assert len(calls) == 1
    calls.clear()
    def empty(*args, **kwargs):
        calls.append(1)
        return io.BytesIO(b'{"choices":[{"message":{"content":null},"finish_reason":"length"}]}')
    monkeypatch.setattr("urllib.request.urlopen", empty)
    assert completion_for("http://synthetic.test", "synthetic")("mutate") == ""
    assert len(calls) == 1


@pytest.mark.parametrize("first_attempt_seconds", [1, 10])
def test_connection_retries_share_original_deadline(first_attempt_seconds, monkeypatch):
    import io
    import urllib.error
    elapsed, timeouts, failures = [0.0], [], []
    monkeypatch.setattr("sciencediscovery_evolve.completion.time.monotonic", lambda: elapsed[0])
    monkeypatch.setattr("sciencediscovery_evolve.completion.time.sleep", lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
    def request(req, *, timeout):
        timeouts.append(timeout)
        if len(timeouts) == 1:
            elapsed[0] += first_attempt_seconds
            raise urllib.error.URLError("connection reset")
        return io.BytesIO(b'{"choices":[{"message":{"content":"candidate"}}]}')
    monkeypatch.setattr("urllib.request.urlopen", request)
    result = completion_for("http://synthetic.test", "synthetic", timeout=10)("mutate", on_failure=failures.append)
    if first_attempt_seconds == 1:
        assert result == "candidate"
        assert timeouts == pytest.approx([10, 8.5])
        assert failures == []
    else:
        assert result == "" and timeouts == [10]
        assert failures == ["completion transport retry deadline exceeded"]
