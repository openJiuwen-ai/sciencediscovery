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
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { renderCoverageJobSummary } from "./coverage-job-summary.mjs";


function metric(covered, total, percentage) {
  return { covered, percentage, total };
}

const run = (planned) => ({ profile: "pr", slice: "ut", planned, executed: planned, passed: planned, failed: 0, skipped: 0 });
const node = { files: 12, selected_groups: ["packages/cas", "services/api"], totals: { branches: metric(30, 40, 75), lines: metric(80, 100, 80) } };
const python = { files: 4, selected_groups: ["services/paper"], totals: { branches: metric(6, 10, 60), lines: metric(45, 50, 90) } };
const layers = {
  ut: { producer: "success", run: run(10), node: { files: 11, totals: { lines: metric(70, 100, 70) } }, python: { files: 4, totals: { lines: metric(45, 50, 90) } },
    processes: { started: 3, measured: 2, unmeasured: [{ status: "no-coverage-module", executable: "/usr/bin/python3", count: 1, example: ["python3", "-c", "import sys"] }] }, problems: [] },
  st: { producer: "success", run: { ...run(1), slice: "st" }, node: { files: 5, totals: { lines: metric(30, 60, 50) } }, python: null,
    processes: { started: 0, measured: 0, unmeasured: [] }, problems: [] },
};

test("shows the merged figure first, then what each layer contributed", () => {
  const output = renderCoverageJobSummary({ node, python, layers });
  assert.match(output, /Coverage is informational\. \*\*No minimum percentage is enforced\.\*\*/);
  assert.match(output, /executes no tests/);
  assert.match(output, /### Merged \(UT \+ ST\)/);
  assert.match(output, /\| Node\.js \| 12 \| 2 \| 80\.00% \(80\/100\) \| 75\.00% \(30\/40\) \|/);
  assert.match(output, /\| Python \| 4 \| 1 \| 90\.00% \(45\/50\) \| 60\.00% \(6\/10\) \|/);
  assert.match(output, /\| UT \| success — 10 planned, 10 executed, 10 passed, 0 failed, 0 skipped \| 70\.00% \(70\/100\) \| 90\.00% \(45\/50\) \| 3 started, 2 measured \|/);
  assert.match(output, /\| ST \| success — 1 planned, 1 executed, 1 passed, 0 failed, 0 skipped \| 50\.00% \(30\/60\) \| n\/a \| none started \|/);
  assert.match(output, /`packages\/cas`, `services\/api`/);
  assert.match(output, /UT: 1 × `\/usr\/bin\/python3` — no-coverage-module, e\.g\. `python3 -c import sys`/);
  assert.doesNotMatch(output, /did not pass/);
});

test("a failed layer's upload is labelled partial, not topped up", () => {
  const output = renderCoverageJobSummary({ node, python, layers: { ...layers, st: { ...layers.st, producer: "failure" } } });
  assert.match(output, /\| ST \| failure; partial upload — 1 planned/);
  assert.match(output, /ST \(`failure`\) did not pass\.\*\* Their rows cover only what they uploaded; nothing was re-run/);
});

test("nothing uploaded invents no numbers", () => {
  const output = renderCoverageJobSummary({ node: undefined, python: undefined, layers: {}, producers: { ut: "failure", st: "cancelled" } });
  assert.match(output, /\| Node\.js \| — \| — \| n\/a \| n\/a \|/);
  assert.match(output, /\| UT \| failure; uploaded no coverage \| n\/a \| n\/a \| — \|/);
  assert.match(output, /\| ST \| cancelled; uploaded no coverage \|/);
  assert.doesNotMatch(output, /%/);
});

test("a layer's problems are listed where the reader will see them", () => {
  const output = renderCoverageJobSummary({ node, python, layers: { ...layers, ut: { ...layers.ut, problems: ["Node: 1 of 2 test files left coverage"] } } });
  assert.match(output, /### Problems\n\n- UT: Node: 1 of 2 test files left coverage/);
});
