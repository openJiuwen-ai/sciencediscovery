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

"""One real search, over HTTP, with only the model faked.

Everything else is the shipping path: the FastAPI route, the event stream, the
ERA tree, the mutation prompt, the AST gate, the real sandbox, the vendored
runner, pandas inside it, the metric computed outside it, the scorecard and
`DefaultAcceptance`. The model is a local HTTP server returning a canned
program, because a test that needed a provider key would not run.

This is the test that answers "does a search actually work", which no amount of
unit tests can: every one of them substitutes the two things most likely to be
wired up wrong.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

from sciencediscovery_evolve.measurement import GATE, ROLLOUT, TEST, missing_candidate_runtime
from sciencediscovery_evolve.server import app
from sciencediscovery_evolve.vendor.era.sandbox import detect_local_capability

# The baseline predicts the mean; the candidate learns the (exact) linear rule.
BASELINE = '''"""基线：一律预测训练集均值。"""
import pandas as pd


def train_and_predict(train_path, test_path):
    train = pd.read_csv(train_path)
    test = pd.read_csv(test_path)
    return [float(train["y"].mean())] * len(test)
'''

CANDIDATE_REPLY = '''我把常数预测换成了线性回归。

```python
"""改用线性回归拟合 x 与 y 的关系。"""
import pandas as pd
from sklearn.linear_model import LinearRegression


def train_and_predict(train_path, test_path):
    train = pd.read_csv(train_path)
    test = pd.read_csv(test_path)
    model = LinearRegression()
    model.fit(train[["x"]], train["y"])
    return list(model.predict(test[["x"]]))
```
'''


class _Model(BaseHTTPRequestHandler):
    """Returns the same improved program for every prompt."""

    prompts: List[str] = []

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's name
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        _Model.prompts.append(body["messages"][0]["content"])
        payload = json.dumps({
            "choices": [{"message": {"content": CANDIDATE_REPLY}}],
            "usage": {"completion_tokens": 300, "prompt_tokens": 900, "total_tokens": 1_200},
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
    _Model.prompts = []
    server = HTTPServer(("127.0.0.1", 0), _Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1/chat/completions"
    finally:
        server.shutdown()
        server.server_close()


def stage(root: Path) -> str:
    """The layout the control plane stages: one train file, a test file and a
    truth file per shard, and a manifest naming the roles."""
    rows = [(index, index * 3 + 1) for index in range(80)]
    train, rest = rows[:40], rows[40:]

    (root / "err").mkdir(parents=True)
    (root / "err" / "train.csv").write_text(
        "x,y\n" + "".join(f"{x},{y}\n" for x, y in train), encoding="utf-8",
    )
    shards = []
    # Four gate shards: fewer and the acceptance gate cannot tell an improvement
    # from noise — which is both this repo's pre-flight floor and the engine's
    # own warning threshold, arrived at independently.
    roles = [ROLLOUT, ROLLOUT, ROLLOUT, ROLLOUT, GATE, GATE, GATE, GATE, TEST]
    for index, role in enumerate(roles):
        chunk = rest[index * 4:(index + 1) * 4]
        folder = root / "err" / str(index)
        folder.mkdir()
        (folder / "test.csv").write_text("x\n" + "".join(f"{x}\n" for x, _ in chunk), encoding="utf-8")
        (folder / "truth.json").write_text(json.dumps([float(y) for _, y in chunk]), encoding="utf-8")
        shards.append({
            "index": index, "role": role,
            "train": "err/train.csv",
            "test": f"err/{index}/test.csv",
            "truth": f"err/{index}/truth.json",
        })
    (root / "manifest.json").write_text(
        json.dumps({"criteria": {"err": {"shards": shards}}, "schemaVersion": 1}), encoding="utf-8",
    )
    return str(root)


SCORECARD: Dict[str, Any] = {
    "aggregate": "weighted_sum",
    "constraints": [],
    "criteria": [{
        "direction": "minimize", "id": "err", "name": "平均绝对误差",
        "measure": {
            "datasetCas": ["sha256:d"], "kind": "dataset_metric",
            "metric": {"direction": "minimize", "name": "mae"},
            "split": {"gateShards": 4, "rolloutShards": 4, "seed": 0,
                      "shardRows": 4, "testShards": 1, "trainRows": 40},
        },
        # `reciprocal` is what turns a minimised quantity into higher-is-better:
        # 1/(1+MAE), so a perfect prediction scores 1 and a bad one approaches 0.
        "normalize": {"kind": "reciprocal"}, "weight": 1.0,
    }],
    "hash": "sha256:e2e", "schemaVersion": 1, "solvedThreshold": 0.999,
}


def test_a_real_search_improves_on_its_baseline(tmp_path: Path, model_server: str) -> None:
    capability = detect_local_capability()
    if not capability.available:
        pytest.skip("no sandbox backend on this host")
    if missing_candidate_runtime():
        pytest.skip("candidate runtime not installed (uv sync --extra candidates)")

    client = TestClient(app)
    response = client.post("/runs", json={
        "search_id": "run-e2e", "algorithm": "era", "engine": "era", "expansions": 2,
        "scorecard_hash": "sha256:e2e", "scorecard": SCORECARD,
        "statement": "把预测误差降下来",
        "dataset_dir": stage(tmp_path / "staged"),
        "baseline_code": BASELINE,
        "candidate_timeout_seconds": 120.0,
        "llm": {"url": model_server, "token": "run-scoped"},
        "sandbox": {
            "backend": capability.backend, "bwrap_path": capability.bwrap_path,
            "disable_userns": capability.disable_userns, "proc_mode": capability.proc_mode,
        },
    })
    assert response.status_code == 200, response.text

    records = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    events = [record["event"] for record in records]
    kinds = [event["type"] for event in events]

    def of(kind: str) -> List[Dict[str, Any]]:
        return [event for event in events if event["type"] == kind]

    # The stream the whole system downstream is built on.
    assert kinds[0] == "search_started"
    assert kinds[1] == "seeded"
    assert kinds[-1] == "search_finished"
    assert [record["sequence"] for record in records] == list(range(1, len(records) + 1))

    # At least one expansion, each preceded by a selection. Not exactly two: the
    # data here is exactly linear, so a linear model reaches the scorecard's
    # solved threshold and the engine rightly stops asking for proposals rather
    # than spending the rest of the budget on a solved problem.
    assert 1 <= len(of("expanded")) <= 2
    assert len(of("selected")) == len(of("expanded"))

    baseline = of("seeded")[0]["baselineScore"]
    candidate = of("expanded")[0]
    assert candidate["valid"] is True, candidate.get("error")
    # The whole point: a linear model beats predicting the mean on data that is
    # exactly linear, and the search can see that it does.
    assert candidate["score"] > baseline

    merged = of("merged")[0]
    # Under ERA "accepted" is "became the best node": there is no per-candidate
    # statistical gate, the tree's rank ordering is the selection pressure.
    assert merged["accepted"] is True, merged["reason"]

    finished = of("search_finished")[0]
    assert finished["status"] == "succeeded"
    # Reported on shards that took no part in the search — the only number here
    # that means anything outside this process.
    assert finished["bestTestScore"] > baseline

    # Real token counts, from the provider's own usage report.
    assert of("cost")[-1]["tokens"] == 1_200 * len(of("expanded"))

    # The prompt carried the objective and the parent program.
    assert "把预测误差降下来" in _Model.prompts[0]
    assert "train_and_predict" in _Model.prompts[0]
    assert "平均绝对误差" in _Model.prompts[0]
