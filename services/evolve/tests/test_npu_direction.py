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

"""Directed edits and an NPU job, on the Evolve engines' own scorecard."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from sciencediscovery_evolve.direction import outside_direction
from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.npu_job import (
    RunnerNpuClient,
    execution_signature,
    interpret_npu_job,
    npu_domain,
)
from sciencediscovery_evolve.puct_engine import _Refusal, _refuse_unrunnable

BASELINE = '{"lr": 0.1, "model": "fixed"}'
SCORECARD = {
    "criteria": [{
        "id": "score",
        "normalize": {"kind": "identity"},
        "measure": {"kind": "npu_job"},
    }],
    "direction": {"editable": ["lr"]},
}


def _spec(**overrides) -> RunSpec:
    options = {
        "npu": {
            "url": "http://127.0.0.1:9",
            "token": "token",
            "execution": {"executionId": "evolve-npu-1", "agentId": "agent"},
            "sessionId": "session",
            "agentId": "agent",
        },
    }
    options.update(overrides.pop("options", {}))
    return RunSpec(
        search_id="search",
        algorithm="puct",
        expansions=1,
        scorecard_hash="card",
        scorecard=SCORECARD,
        baseline_code=BASELINE,
        options=options,
        **overrides,
    )


def test_a_directed_search_rejects_a_free_edit_and_a_fixed_field():
    assert outside_direction(BASELINE, '{"lr": 0.2, "model": "fixed"}', {"editable": ["lr"]}) == ""
    assert "free program" in outside_direction(BASELINE, "print('rewrite')", {"editable": ["lr"]})
    assert outside_direction(
        BASELINE, '{"lr": 0.2, "model": "other"}', {"editable": ["lr"]},
    ) == "fixed field changed: model"
    assert outside_direction(
        BASELINE, '{"lr": 0.2, "model": "fixed", "extra": 1}', {"editable": ["lr"]},
    ) == "unknown field: extra"


def test_an_npu_search_refuses_to_start_without_a_direction_or_a_runner():
    free = _spec()
    free = RunSpec(
        search_id="search", algorithm="puct", expansions=1, scorecard_hash="card",
        scorecard={"criteria": SCORECARD["criteria"]},
        baseline_code=BASELINE,
        options=_spec().options,
    )
    with pytest.raises(_Refusal, match="editable fields"):
        _refuse_unrunnable(free)
    with pytest.raises(_Refusal, match="no runner"):
        _refuse_unrunnable(_spec(options={"npu": {}}))
    _refuse_unrunnable(_spec())


def test_a_missing_or_non_npu_result_is_not_stored_as_zero():
    waiting, metrics, error = interpret_npu_job({"state": "queued"}, None, metric_key="score")
    assert waiting is False and error == "job not finished" and "score" not in metrics
    cpu, metrics, error = interpret_npu_job(
        {"state": "completed"}, {"device": "cpu", "score": 0}, metric_key="score",
    )
    assert cpu is False and error == "device is not npu" and "score" not in metrics
    assert 0 not in metrics.values()


def test_the_client_submits_a_signed_shell_and_waits_for_npu(tmp_path):
    del tmp_path
    scripted = [
        {"id": "evolve-npu-1", "state": "running"},
        {"id": "evolve-npu-1", "state": "completed", "result": {"stdout": '{"device": "npu", "score": 1.5}\n'}},
    ]
    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            timestamp = self.headers.get("x-science-execution-timestamp")
            signature = self.headers.get("x-science-execution-signature")
            assert signature == execution_signature("token", timestamp, body)
            seen["body"] = json.loads(body)
            self._json(202, {"id": "evolve-npu-1", "state": "queued"})

        def do_GET(self):
            self._json(200, scripted.pop(0))

        def _json(self, status, payload):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt, *args):
            del fmt, args

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        client = RunnerNpuClient(
            url=f"http://127.0.0.1:{port}",
            token="token",
            execution={"executionId": "evolve-npu-1", "agentId": "agent"},
            session_id="session",
            agent_id="agent",
            timeout=5,
            poll_seconds=0.01,
        )
        domain = npu_domain(
            scorecard=SCORECARD,
            baseline_code=BASELINE,
            client=client,
            statement="raise the score",
        )
        valid, metrics, error = domain.evaluate('{"lr": 0.2, "model": "fixed"}', ())
    finally:
        server.shutdown()
        thread.join(timeout=2)

    assert seen["body"]["code"] == '{"lr": 0.2, "model": "fixed"}'
    assert seen["body"]["executionId"] == "evolve-npu-1"
    assert valid is True and error == ""
    assert metrics["score"] == 1.5
    assert metrics["device"] == "npu"
