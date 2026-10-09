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
