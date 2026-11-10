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

pytestmark = pytest.mark.science_tags(category='ut', os='linux', arch=('amd64', 'arm64'))

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
    values = {}
    exec(first, values)
    assert values["_EVOLVE_CANDIDATE"] == {"lr": 0.2, "model": "fixed"}
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
    values = {}
    exec(submitted[0]["code"], values)
    assert values["_EVOLVE_CANDIDATE"] == {"lr": 0.2, "model": "fixed"}
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
    assert len(tasks) == 4
    assert len({task.id for task in tasks}) == 4
    assert _group_held_out_frac(spec) == 0.25


def _program(code, iteration, metrics, valid=True, error=""):
    from sciencediscovery_evolve.vendor.puct.program import Program

    return Program("p", iteration, None, code, "", metrics, valid, error)


def test_a_seen_edit_is_asked_again_inside_the_same_call():
    from sciencediscovery_evolve.directed_memory import REDRAW_LIMIT, EditMemory, redraw_known

    memory = EditMemory()
    memory.note_seed('{"model":"fixed","pos_2":"T"}', 0.2)
    prompts = []
    logs = []

    def complete(prompt, iteration):
        del iteration
        prompts.append(prompt)
        if len(prompts) == 1:
            return '{"model":"fixed","pos_2":"T"}', "same", None
        return '{"model":"fixed","pos_2":"A"}', "new", None

    code, summary, promise = redraw_known(complete, memory, logs.append)("start", 1)
    assert code == '{"model":"fixed","pos_2":"A"}'
    assert summary == "new" and promise is None
    assert len(prompts) == 2
    assert "does not take another run" in prompts[1]
    assert logs == ["this edit was already measured, so it does not take a run; asking for a different one"]

    prompts.clear()

    def stuck(prompt, iteration):
        del prompt, iteration
        prompts.append(1)
        return '{"model":"fixed","pos_2":"T"}', "same", None

    redraw_known(stuck, memory, logs.append)("start", 1)
    assert len(prompts) == REDRAW_LIMIT + 1


def test_a_reply_that_is_not_json_is_asked_again_inside_the_same_call():
    from sciencediscovery_evolve.directed_memory import REDRAW_LIMIT, EditMemory, redraw_known

    memory = EditMemory()
    memory.note_seed('{"model":"fixed","pos_2":"T"}', 0.2)
    direction = {"editable": ["pos_2"]}
    prompts = []
    logs = []

    def complete(prompt, iteration):
        del iteration
        prompts.append(prompt)
        if len(prompts) == 1:
            return "def main():\n    return 1\n", "program", None
        return '{"model":"fixed","pos_2":"A"}', "json", None

    code, summary, promise = redraw_known(
        complete, memory, logs.append, direction=direction,
    )("start", 1)
    assert code == '{"model":"fixed","pos_2":"A"}'
    assert summary == "json" and promise is None
    assert len(prompts) == 2
    assert "not a JSON object" in prompts[1]
    assert logs == ["this reply is not a JSON object, so it does not take a run; asking again"]

    prompts.clear()
    logs.clear()

    def fixed_field(prompt, iteration):
        del iteration
        prompts.append(prompt)
        if len(prompts) == 1:
            return '{"model":"changed","pos_2":"A"}', "fixed", None
        return '{"model":"fixed","pos_2":"A"}', "ok", None

    code, _, _ = redraw_known(
        fixed_field, memory, logs.append, direction=direction,
    )("start", 1)
    assert code == '{"model":"fixed","pos_2":"A"}'
    assert "outside the declared fields" in logs[-1]

    prompts.clear()

    def stuck(prompt, iteration):
        del prompt, iteration
        prompts.append(1)
        return "still prose", "no", None

    redraw_known(stuck, memory, logs.append, direction=direction)("start", 1)
    assert len(prompts) == REDRAW_LIMIT + 1


def test_a_measured_edit_is_not_sent_to_the_runner_again():
    from sciencediscovery_evolve.directed_memory import EditMemory, guard_evaluate
    from sciencediscovery_evolve.vendor.puct.domain import Domain

    memory = EditMemory()
    memory.note_seed('{"model":"fixed","pos_2":"T"}', 0.2)
    calls = []

    def evaluate(text, shards):
        del shards
        calls.append(text)
        return True, {"job_status": "completed", "score": 0.2}, ""

    domain = guard_evaluate(Domain(
        name="probe", entrypoint="main", metric_key="score", metric_better="higher",
        initial_program="{}", initial_summary="", evaluate=evaluate,
        reward=lambda metrics: 0.0, prompt=lambda program: program.code,
        task_prompt=lambda shard: str(shard), test_shards=(),
    ), memory)
    valid, metrics, error = domain.evaluate('{"pos_2":"T","model":"fixed"}', ())
    assert valid is False and calls == []
    assert metrics["job_status"] == "rejected"
    assert metrics["score"] == float("-inf")
    assert "does not take another run" in error


def test_a_seen_edit_is_not_a_new_node_unless_the_score_improves():
    from sciencediscovery_evolve.directed_memory import guard_tree, EditMemory
    from sciencediscovery_evolve.vendor.puct.tree import PuctTree

    tree = PuctTree(candidate_limit=4)
    memory = EditMemory()
    guard_tree(tree, memory)
    seed = '{"model":"fixed","pos_2":"T"}'
    tree.seed(_program(seed, 0, {"score": 0.2}), 0.2)
    tree._next_iteration = 2
    same = tree.add_node(_program(seed, 1, {"job_status": "completed", "score": 0.2}), 0.2, 0)
    assert getattr(same, "skipped", False) is True
    assert len(tree.nodes) == 1
    assert tree._next_iteration == 1

    tree._next_iteration = 2
    better = tree.add_node(_program(seed, 1, {"job_status": "completed", "score": 0.8}), 0.8, 0)
    assert getattr(better, "skipped", False) is False
    assert better.index == 0
    assert len(tree.nodes) == 1
    assert tree.nodes[0].score == 0.8


def test_waiting_and_a_fault_retry_do_not_take_another_slot():
    from sciencediscovery_evolve.directed_memory import FAULT_LIMIT, guard_evaluate, guard_tree, EditMemory
    from sciencediscovery_evolve.vendor.puct.domain import Domain
    from sciencediscovery_evolve.vendor.puct.tree import PuctTree

    tree = PuctTree(candidate_limit=4)
    memory = EditMemory()
    guard_tree(tree, memory)
    tree.seed(_program('{"model":"fixed","pos_2":"T"}', 0, {"score": 0.2}), 0.2)
    tree.nodes[0].num_visits = 2
    tree._next_iteration = 2
    waiting = tree.add_node(
        _program('{"model":"fixed","pos_2":"A"}', 1, {"job_status": "waiting"}, valid=False, error="job not finished"),
        float("-inf"),
        0,
    )
    assert getattr(waiting, "skipped", False) is True
    assert len(tree.nodes) == 1
    assert tree._next_iteration == 1
    assert tree.nodes[0].num_visits == 1

    code = '{"model":"fixed","pos_2":"Q"}'
    tree._next_iteration = 2
    first = tree.add_node(_program(code, 1, {"job_status": "fault"}, valid=False, error="job failed"), float("-inf"), 0)
    assert getattr(first, "skipped", False) is True
    assert tree._next_iteration == 2
    tree._next_iteration = 3
    second = tree.add_node(_program(code, 2, {"job_status": "fault"}, valid=False, error="job failed"), float("-inf"), 0)
    assert getattr(second, "skipped", False) is True
    assert tree._next_iteration == 2

    calls = []

    def evaluate(text, shards):
        del shards
        calls.append(text)
        return False, {"job_status": "fault"}, "job failed"

    domain = guard_evaluate(Domain(
        name="probe", entrypoint="main", metric_key="score", metric_better="higher",
        initial_program="{}", initial_summary="", evaluate=evaluate,
        reward=lambda metrics: 0.0, prompt=lambda program: program.code,
        task_prompt=lambda shard: str(shard), test_shards=(),
    ), memory)
    assert memory.faults[json.dumps(json.loads(code), sort_keys=True, separators=(",", ":"))] == FAULT_LIMIT
    valid, _metrics, error = domain.evaluate(code, ())
    assert valid is False and calls == [] and "already failed" in error


def test_a_completed_score_of_zero_stays_a_score():
    from sciencediscovery_evolve.directed_memory import EditMemory, guard_archive

    class Archive:
        def __init__(self):
            self.stored = []

        def add_program(self, program, baseline=False):
            del baseline
            self.stored.append(program)
            return True

    class Program:
        def __init__(self, code, metrics, iteration):
            self.code = code
            self.metrics = metrics
            self.valid = True
            self.iteration = iteration
            self.error = ""
            self.change_summary = ""

    archive = Archive()
    guard_archive(archive, EditMemory())
    assert archive.add_program(Program('{"model":"fixed","pos_2":"T"}', {"score": 0.0}, 0), baseline=True)
    assert archive.add_program(Program('{"model":"fixed","pos_2":"A"}', {"job_status": "completed", "score": 0.0}, 1))
    assert len(archive.stored) == 2


def test_json_values_remain_data_when_the_fixed_program_executes():
    candidate = {
        "enabled": True, "disabled": False, "optional": None,
        "nested": [None, {"active": False}],
        "text": "'); raise RuntimeError('candidate executed') #\n中文",
    }
    values = {}
    exec(program_with_candidate("result = _EVOLVE_CANDIDATE", json.dumps(candidate)), values)
    assert values["result"] == candidate


def test_failed_measurement_is_shared_by_shards_but_retried_next_attempt():
    from sciencediscovery_evolve.directed_memory import EditMemory

    class Client:
        calls = 0

        def run(self, code, stop):
            del code, stop
            self.calls += 1
            if self.calls == 1:
                return {"state": "failed"}, None
            return {"state": "completed"}, {"device": "npu", "score": 0.5}

    memory = EditMemory()
    client = Client()
    domain = npu_domain(
        scorecard=SCORECARD, baseline_code=BASELINE, client=client,
        statement="", attempt=memory.fault_count,
    )
    code = '{"lr": 0.2, "model": "fixed"}'
    for shard in range(4):
        valid, metrics, error = domain.evaluate(code, (shard,))
        assert not valid and metrics["job_status"] == "fault"
    assert client.calls == 1
    memory.classify(_program(code, 1, metrics, valid=False, error=error), float("-inf"))
    for shard in range(4):
        valid, metrics, error = domain.evaluate(code, (shard,))
        assert valid and metrics["score"] == 0.5
    assert client.calls == 2


def test_repeated_proposal_reaches_puct_refund_without_a_score_key_error():
    from types import SimpleNamespace
    from sciencediscovery_evolve.directed_memory import EditMemory, guard_evaluate, guard_tree
    from sciencediscovery_evolve.vendor.puct.search import PuctTreeAggregator
    from sciencediscovery_evolve.vendor.puct.tree import PuctTree

    memory = EditMemory()
    tree = PuctTree(candidate_limit=4)
    guard_tree(tree, memory)
    domain = guard_evaluate(Domain(
        name="probe", entrypoint="main", metric_key="score", metric_better="higher",
        initial_program=BASELINE, initial_summary="", evaluate=lambda *_: (True, {"score": 0.2}, ""),
        reward=lambda metrics: metrics["score"], prompt=lambda program: program.code,
        task_prompt=lambda shard: str(shard), test_shards=(),
    ), memory)
    snapshot = SimpleNamespace(
        version={"candidate": 0}, get=lambda _: SimpleNamespace(state={"code": BASELINE}),
    )
    aggregator = PuctTreeAggregator(
        SimpleNamespace(snapshot=lambda _: snapshot),
        SimpleNamespace(held_out=[SimpleNamespace(meta={"shard": 0})]),
        tree, None, None, domain=domain, artifact_id="candidate",
    )
    aggregator.seed()
    tree._next_iteration = 2
    aggregator._staleness_filter = lambda _version, cards: (cards, [])
    aggregator.ingest(SimpleNamespace(diff=SimpleNamespace(ops={
        "code": BASELINE, "iteration": "1", "parent_index": "0",
    })))
    reports = aggregator.step()
    assert len(reports) == 1 and len(tree.nodes) == 1
    assert tree._next_iteration == 1


def test_repeat_prompt_bounds_history_and_large_values_without_forgetting_edits():
    from sciencediscovery_evolve.directed_memory import EditMemory, RECENT_EDIT_LIMIT

    memory = EditMemory()
    memory.baseline = '{"field":"seed"}'
    for number in range(100):
        memory.note_seed(json.dumps({"field": f"{number}-" + "x" * 10_000}), number / 100)
    oldest = json.dumps({"field": "0-" + "x" * 10_000})
    reason = memory.repeat_reason(oldest)
    assert len(reason) < 3000
    assert f"{RECENT_EDIT_LIMIT} of 100" in reason
    assert "omitted from this preview" in reason
    assert memory.skip_reason(oldest) == "repeat"
    assert memory.skip_reason(json.dumps({"field": "unmeasured"})) == ""


def test_missing_score_is_null_on_the_event_wire_and_raw_infinity_is_rejected():
    from sciencediscovery_evolve import events

    records = [events.seeded(0, float("-inf")), events.expanded(1, 0, 1, float("-inf"), False)]
    wire = b"".join(events.encode_ndjson(iter(records))).decode()
    assert "Infinity" not in wire
    first, second = [json.loads(line) for line in wire.splitlines()]
    assert first["baselineScore"] is None
    assert second["score"] is None
    with pytest.raises(ValueError):
        list(events.encode_ndjson(iter([{"score": float("-inf")}])))
