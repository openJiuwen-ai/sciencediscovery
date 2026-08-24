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

"""Route-level tests: auth, validation, the NDJSON stream and stop."""

from __future__ import annotations

import importlib
import json
import time
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN", raising=False)
    module = importlib.import_module("sciencediscovery_evolve.server")
    importlib.reload(module)
    return TestClient(module.app)


def read_records(response) -> list[dict]:
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def test_health_needs_no_auth(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_a_run_streams_ndjson_records(client: TestClient) -> None:
    response = client.post("/runs", json={
        "search_id": "run-1", "scorecard_hash": "sha256:card", "expansions": 4,
    })
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")

    records = read_records(response)
    assert [record["sequence"] for record in records] == list(range(1, len(records) + 1))
    assert records[0]["event"]["type"] == "search_started"
    assert records[-1]["event"]["type"] == "search_finished"
    assert all(record["createdAt"].endswith("Z") for record in records)


def test_sequence_numbers_can_resume(client: TestClient) -> None:
    response = client.post("/runs", json={
        "search_id": "run-resume", "scorecard_hash": "sha256:card",
        "expansions": 2, "resume_from_sequence": 40,
    })
    records = read_records(response)
    assert records[0]["sequence"] == 41


def test_an_unknown_algorithm_is_refused(client: TestClient) -> None:
    response = client.post("/runs", json={
        "search_id": "run-bad", "scorecard_hash": "sha256:card", "algorithm": "gepa",
    })
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unknown_algorithm"


def test_an_unknown_engine_is_refused(client: TestClient) -> None:
    response = client.post("/runs", json={
        # `era` used to stand in for "an engine that does not exist yet"; it
        # exists now, so this needs a name that still does not.
        "search_id": "run-bad", "scorecard_hash": "sha256:card", "engine": "openevolve",
    })
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unknown_engine"


def test_stopping_an_unknown_search_is_not_an_error(client: TestClient) -> None:
    """The API races the stream's own completion, so this must be idempotent."""
    response = client.post("/runs/never-started/stop")
    assert response.status_code == 200
    assert response.json() == {"stopped": False}


def test_a_finished_run_leaves_no_in_flight_entry(client: TestClient) -> None:
    client.post("/runs", json={
        "search_id": "run-done", "scorecard_hash": "sha256:card", "expansions": 2,
    })
    assert client.get("/health").json()["running"] == "0"


def test_the_token_is_enforced_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN", "secret-token")
    module = importlib.import_module("sciencediscovery_evolve.server")
    importlib.reload(module)
    guarded = TestClient(module.app)

    assert guarded.post("/runs", json={
        "search_id": "run-auth", "scorecard_hash": "sha256:card", "expansions": 1,
    }).status_code == 401
    assert guarded.get("/health").status_code == 200, "the readiness probe stays open"
    assert guarded.post(
        "/runs",
        json={"search_id": "run-auth", "scorecard_hash": "sha256:card", "expansions": 1},
        headers={"Authorization": "Bearer secret-token"},
    ).status_code == 200


# --- model access -----------------------------------------------------------


def test_a_run_carries_a_proxy_token_and_never_a_provider_key(client: TestClient) -> None:
    """The sidecar executes model-written code, so what it is handed matters
    more than what it does with it: a run-scoped token for the control plane's
    proxy, never a key."""
    import importlib

    module = importlib.import_module("sciencediscovery_evolve.server")
    captured = {}

    class _Recording:
        name = "recording"
        requires_sandbox = False

        def run(self, spec, emit, should_stop) -> None:
            captured["llm_url"] = spec.llm_url
            captured["llm_token"] = spec.llm_token
            captured["spec"] = spec
            emit({"bestNodeIndex": None, "candidates": 0, "status": "succeeded",
                  "type": "search_finished"})

    module.ENGINES["recording"] = _Recording()
    try:
        response = client.post("/runs", json={
            "search_id": "run-llm", "scorecard_hash": "sha256:card", "engine": "recording",
            "expansions": 1,
            "llm": {"url": "/internal/evolve-llm/run-llm/v1/chat/completions", "token": "run-scoped"},
        })
        assert response.status_code == 200
        response.text  # drain the stream so the engine has run
    finally:
        module.ENGINES.pop("recording", None)

    assert captured["llm_token"] == "run-scoped"
    assert captured["llm_url"].endswith("/v1/chat/completions")


def test_what_an_engine_grades_with_reaches_it(client: TestClient) -> None:
    """The scorecard body, the goal and the staged dataset are the engine's
    inputs; the hash alone is an identity, not something to grade with."""
    import importlib

    module = importlib.import_module("sciencediscovery_evolve.server")
    captured = {}

    class _Recording:
        name = "recording"
        requires_sandbox = False

        def run(self, spec, emit, should_stop) -> None:
            captured["spec"] = spec
            emit({"bestNodeIndex": None, "candidates": 0, "status": "succeeded",
                  "type": "search_finished"})

    module.ENGINES["recording"] = _Recording()
    try:
        response = client.post("/runs", json={
            "search_id": "run-card", "scorecard_hash": "sha256:card", "engine": "recording",
            "expansions": 1, "statement": "把准确率做上去",
            "scorecard": {"criteria": [{"id": "acc"}], "hash": "sha256:card"},
            "dataset_dir": "/staged/run-card", "baseline_code": "def train_and_predict(a, b): ...",
            "candidate_timeout_seconds": 45.0, "max_tokens_per_call": 32_000,
        })
        assert response.status_code == 200
        response.text
    finally:
        module.ENGINES.pop("recording", None)

    spec = captured["spec"]
    assert spec.scorecard["criteria"] == [{"id": "acc"}]
    assert spec.statement == "把准确率做上去"
    assert spec.dataset_dir == "/staged/run-card"
    assert spec.baseline_code.startswith("def train_and_predict")
    assert spec.candidate_timeout_seconds == 45.0
    assert spec.max_tokens_per_call == 32_000


def test_a_failed_completion_is_an_empty_reply_not_an_exception() -> None:
    """An empty reply becomes a failed node; raising would lose the whole run
    because one model call failed."""
    from sciencediscovery_evolve.completion import CompletionUnavailable, completion_for

    # The endpoint is absolute and comes from the control plane: a sidecar that
    # had to guess the API's origin would turn every expansion into a failed
    # candidate for a reason that has nothing to do with candidates.
    complete = completion_for("http://127.0.0.1:1/internal/evolve-llm/x/v1/chat/completions", "t")
    assert complete("改进这个程序") == ""

    with pytest.raises(CompletionUnavailable):
        completion_for("", "")


def test_a_stop_takes_effect_during_a_model_call_not_after_it() -> None:
    """The user presses stop while a call is in flight and expects it to stop.

    A reasoning model rewriting a program takes minutes, and the request cannot
    be cancelled — so it is left to finish on a daemon thread and its answer is
    dropped. The call is already paid for either way; the difference is whether
    the user is made to wait for it. Observed on a real deployment: stop sat at
    "正在停止…" for four minutes.
    """
    import threading

    from sciencediscovery_evolve.completion import completion_for

    started = threading.Event()
    release = threading.Event()

    def slow_urlopen(*_args, **_kwargs):
        started.set()
        release.wait(10)
        raise AssertionError("the call should have been abandoned before this returned")

    import urllib.request

    original = urllib.request.urlopen
    urllib.request.urlopen = slow_urlopen  # type: ignore[assignment]
    stopping = threading.Event()
    try:
        complete = completion_for(
            "http://127.0.0.1:1/chat/completions", "t", should_stop=stopping.is_set,
        )
        result: list[str] = []
        caller = threading.Thread(target=lambda: result.append(complete("改进这个程序")))
        caller.start()
        assert started.wait(5), "the request never started"
        stopping.set()
        caller.join(5)
        assert not caller.is_alive(), "stop did not take effect while the call was in flight"
        assert result == [""]
    finally:
        release.set()
        urllib.request.urlopen = original  # type: ignore[assignment]


def test_a_quiet_stream_is_kept_alive_rather_than_left_to_time_out() -> None:
    """One expansion is minutes of silence, and the client's HTTP stack cannot
    tell that apart from a dead sidecar.

    undici's body timeout is 300 seconds, so on a real deployment the API
    aborted the response mid-run, the search died reporting `terminated`, and
    the sidecar's remaining calls 401'd against a token revoked with the run.
    The keep-alive is a bare newline: the NDJSON reader already skips empty
    lines, so it takes no sequence number and writes nothing to the log.
    """
    import importlib

    from sciencediscovery_evolve.events import HEARTBEAT, encode_ndjson

    module = importlib.import_module("sciencediscovery_evolve.server")
    monkey = module._HEARTBEAT_SECONDS
    module._HEARTBEAT_SECONDS = 0.05
    try:
        class _Slow:
            name = "slow"
            requires_sandbox = False

            def run(self, spec, emit, should_stop) -> None:
                time.sleep(0.4)  # quiet for several heartbeat intervals
                emit({"bestNodeIndex": None, "candidates": 0, "status": "succeeded",
                      "type": "search_finished"})

        module.ENGINES["slow"] = _Slow()
        try:
            client = TestClient(module.app)
            response = client.post("/runs", json={
                "search_id": "run-quiet", "scorecard_hash": "sha256:card",
                "engine": "slow", "expansions": 1,
            })
            assert response.status_code == 200
            body = response.text
        finally:
            module.ENGINES.pop("slow", None)
    finally:
        module._HEARTBEAT_SECONDS = monkey

    # Blank lines went down the wire...
    assert "\n\n" in body
    # ...and none of them is a record: the reader skips them, so the log holds
    # exactly what the engine produced.
    records = [json.loads(line) for line in body.splitlines() if line.strip()]
    assert len(records) == 1
    assert records[0]["sequence"] == 1
    assert records[0]["event"]["type"] == "search_finished"

    # The encoder is what lets raw bytes through untouched.
    assert list(encode_ndjson(iter([HEARTBEAT]))) == [b"\n"]
