// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import { test } from "node:test";

import { pythonCoverageGroups, selectPythonCoverageGroups } from "./select-python-coverage-groups.mjs";

test("selects a changed Python service", () => {
  const selected = selectPythonCoverageGroups({ paths: ["services/gateway/src/server.py"] });
  assert.deepEqual(selected.groups, ["services/gateway"]);
  assert.equal(selected.mode, "incremental");
  assert.equal(selected.skip, false);
});

test("selects multiple changed Python services", () => {
  const selected = selectPythonCoverageGroups({
    paths: ["services/paper/paper_worker.py", "services/evolve/tests/test_probe.py"],
  });
  assert.deepEqual(selected.groups, ["services/evolve", "services/paper"]);
});

test("uses a full run when shared Python coverage infrastructure changes", () => {
  const selected = selectPythonCoverageGroups({ paths: ["scripts/run-python-coverage.mjs"] });
  assert.equal(selected.mode, "full");
  assert.deepEqual(selected.groups, []);
  assert.equal(selected.skip, false);
});

test("skips Python coverage for unrelated changes", () => {
  const selected = selectPythonCoverageGroups({ paths: ["docs/guide.md", "services/api/src/server.ts"] });
  assert.deepEqual(selected.groups, []);
  assert.equal(selected.skip, true);
});

test("keeps the maintained Python coverage scope explicit", () => {
  assert.deepEqual(pythonCoverageGroups, [
    "services/evolve",
    "services/gateway",
    "services/memory-graph",
    "services/paper",
  ]);
});
