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

from sciencediscovery_evolve.direction import baseline_rows, bound_domain, field_changes, outside_direction
from sciencediscovery_evolve.engine import RunSpec
from sciencediscovery_evolve.npu_job import (
    RunnerNpuClient,
    execution_signature,
    interpret_npu_job,
    npu_domain,
    program_with_candidate,
    score_for_search,
)
from sciencediscovery_evolve.vendor.puct.domain import Domain
from sciencediscovery_evolve.puct_engine import _Refusal, _refuse_unrunnable

BASELINE = '{"lr": 0.1, "model": "fixed"}'
FIXED = "print('from-the-fixed-program')\n"
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
            "execution": {"agentId": "agent", "code": FIXED},
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


def test_a_missing_score_is_not_ranked_as_zero():
    assert score_for_search({}) == float("-inf")
    assert score_for_search({"job_status": "waiting"}) == float("-inf")
    assert score_for_search({"job_status": "fault"}) == float("-inf")
    assert score_for_search({"score": 0, "job_status": "completed", "device": "npu"}) == 0.0
    client = RunnerNpuClient(
        url="http://127.0.0.1:9",
        token="token",
        execution={"code": FIXED},
        session_id="session",
        agent_id="agent",
        timeout=1,
    )
    domain = npu_domain(scorecard=SCORECARD, baseline_code=BASELINE, client=client, statement="")
    assert domain.reward({}) == float("-inf")
    assert domain.reward({"job_status": "waiting"}) == float("-inf")


def test_a_fixed_field_is_rejected_before_scoring_and_not_as_zero():
    calls = []

    def evaluate(code, shards):
        del shards
        calls.append(code)
        return True, {"score": 3.0}, ""

    domain = bound_domain(
        Domain(
            name="probe",
            entrypoint="main",
            metric_key="score",
            metric_better="higher",
            initial_program=BASELINE,
            initial_summary="",
            evaluate=evaluate,
            reward=lambda metrics: float(metrics["score"]),
            prompt=lambda program: program.code,
            task_prompt=lambda shard: str(shard),
            test_shards=(),
        ),
        BASELINE,
        {"editable": ["lr"]},
    )
    valid, metrics, error = domain.evaluate('{"lr": 0.2, "model": "other"}', ())
    assert valid is False
    assert error == "fixed field changed: model"
    assert metrics["job_status"] == "rejected"
    assert metrics["score"] == float("-inf")
    assert calls == []


def test_the_preview_run_keeps_a_missing_result_empty():
    from sciencediscovery_evolve.field_table import scripted_rounds

    rows = scripted_rounds({"pos_2": "T", "pos_4": "K", "model": "fixed"}, ["pos_2", "pos_4"])
    by_title = {row["title"]: row for row in rows}
    assert by_title["作业未结束，先等待"]["score"] == "—"
    assert by_title["固定程序在 NPU 上返回分数"]["score"] == "0.42"
    assert by_title["固定程序在 NPU 上返回分数"]["field"] == "pos_2"
    assert "fixed field" in by_title["改了没有勾选的字段"]["note"]
    assert by_title["改了没有勾选的字段"]["score"] == "—"
    assert "不收成新节点" in by_title["同一处修改没有更好，不收成新节点"]["note"]
    assert by_title["设备不是 NPU，不记 0"]["score"] == "—"
    assert "0" not in by_title["设备不是 NPU，不记 0"]["score"]


def test_the_confirmation_table_names_fields_and_the_run_names_what_changed():
    rows = baseline_rows('{"pos_2": "T", "pos_4": "K", "model": "fixed"}')
    assert [row["field"] for row in rows] == ["pos_2", "pos_4", "model"]
    assert rows[0]["value"] == "T"
    changes = field_changes(
        '{"pos_2": "T", "pos_4": "K", "model": "fixed"}',
        '{"pos_2": "A", "pos_4": "K", "model": "fixed"}',
    )
    assert changes == [{"field": "pos_2", "old": "T", "new": "A"}]


def test_a_missing_or_non_npu_result_is_not_stored_as_zero():
    waiting, metrics, error = interpret_npu_job({"state": "queued"}, None, metric_key="score")
    assert waiting is False and error == "job not finished" and "score" not in metrics
    cpu, metrics, error = interpret_npu_job(
        {"state": "completed"}, {"device": "cpu", "score": 0}, metric_key="score",
    )
    assert cpu is False and error == "device is not npu" and "score" not in metrics
    assert 0 not in metrics.values()


def test_the_candidate_is_data_for_the_fixed_program_and_each_job_is_new():
    first = program_with_candidate(FIXED, '{"lr": 0.2, "model": "fixed"}')
    assert first.startswith('_EVOLVE_CANDIDATE = {"lr":0.2,"model":"fixed"}\n')
    assert first.endswith(FIXED)
    assert "print('rewrite')" not in first
    with pytest.raises(Exception, match="not JSON"):
        program_with_candidate(FIXED, "print('rewrite')")


def test_the_client_submits_a_signed_shell_and_waits_for_npu(tmp_path):
    del tmp_path
    scripted = [
        {"state": "running"},
        {"state": "completed", "result": {"stdout": '{"device": "npu", "score": 1.5}\n'}},
        {"state": "running"},
        {"state": "completed", "result": {"stdout": '{"device": "npu", "score": 1.5}\n'}},
    ]
    seen = {"bodies": []}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode("utf-8")
            timestamp = self.headers.get("x-science-execution-timestamp")
            signature = self.headers.get("x-science-execution-signature")
            assert signature == execution_signature("token", timestamp, body)
            seen["bodies"].append(json.loads(body))
            self._json(202, {"id": json.loads(body)["executionId"], "state": "queued"})

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
            execution={"agentId": "agent", "code": FIXED},
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
        domain.evaluate('{"lr": 0.3, "model": "fixed"}', ())
    finally:
        server.shutdown()
        thread.join(timeout=2)

    submitted = seen["bodies"]
    assert len(submitted) == 2
    assert submitted[0]["code"].startswith('_EVOLVE_CANDIDATE = {"lr":0.2,"model":"fixed"}\n')
    assert submitted[0]["code"].endswith(FIXED)
    assert submitted[0]["code"] != '{"lr": 0.2, "model": "fixed"}'
    assert submitted[0]["executionId"].startswith("evolve-")
    assert submitted[1]["executionId"].startswith("evolve-")
    assert submitted[0]["executionId"] != submitted[1]["executionId"]
    assert valid is True and error == ""
    assert metrics["score"] == 1.5
    assert metrics["device"] == "npu"


def test_the_probe_damages_only_the_first_editable_field():
    from sciencediscovery_evolve.probe import _damage_json

    damaged, label = _damage_json(
        '{"model": "fixed", "pos_2": "T", "pos_4": "K"}',
        {"editable": ["pos_2", "pos_4"]},
    )
    assert label == "changed pos_2"
    assert json.loads(damaged) == {"model": "fixed", "pos_2": "T-damaged", "pos_4": "K"}


def test_an_npu_search_is_one_measurement():
    from sciencediscovery_evolve.puct_engine import _group_held_out_frac, _group_tasks

    spec = type("Spec", (), {
        "scorecard": {"criteria": [{"measure": {"kind": "npu_job"}}]},
        "search_id": "search",
    })()
    tasks = _group_tasks(spec)
    assert len(tasks) == 1
    assert tasks[0].meta["shard"] == 0
    assert _group_held_out_frac(spec) == 1.0
