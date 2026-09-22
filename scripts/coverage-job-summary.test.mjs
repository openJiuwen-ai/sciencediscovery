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

const run = { profile: "pr", slice: "ut", plan_digest: "0123456789abcdef", planned: 10, executed: 10, passed: 10, failed: 0, skipped: 0 };
const nodeDocument = {
  files: 12,
  run,
  scope: "Node.js sources.",
  selected_groups: ["packages/agent-core", "scripts"],
  totals: { branches: metric(30, 40, 75), functions: metric(18, 20, 90), lines: metric(80, 100, 80) },
};
const pythonDocument = {
  files: 4,
  run,
  selected_groups: ["services/gateway"],
  totals: { branches: metric(6, 10, 60), lines: metric(45, 50, 90) },
};

test("reports the UT run's own coverage and says nothing was executed here", () => {
  const output = renderCoverageJobSummary({ node: { document: nodeDocument }, python: { document: pythonDocument }, producer: "success" });
  assert.match(output, /Coverage is informational\. \*\*No minimum percentage is enforced\.\*\*/);
  assert.match(output, /executes no tests/);
  assert.match(output, /UT run: profile `pr`, slice `ut` — planned 10, executed 10, passed 10, failed 0, skipped 0 \(plan `0123456789ab`\)\./);
  assert.match(output, /\| Node\.js \| UT run \| 12 \| 2 \| 80\.00% \(80\/100\) \| 75\.00% \(30\/40\) \|/);
  assert.match(output, /\| Python \| UT run \| 4 \| 1 \| 90\.00% \(45\/50\) \| 60\.00% \(6\/10\) \|/);
  assert.doesNotMatch(output, /Functions/);
  assert.doesNotMatch(output, /did not pass/);
  assert.match(output, /`packages\/agent-core`, `scripts`/);
  assert.match(output, /ST and the mocked browser E2E .* contribute no module coverage/);
});

test("a failed UT job's upload is labelled partial, not topped up", () => {
  const output = renderCoverageJobSummary({ node: { document: nodeDocument }, python: { document: undefined }, producer: "failure" });
  assert.match(output, /The UT job did not pass \(`failure`\)\.\*\* The figures below cover only what it uploaded; nothing was re-run/);
  assert.match(output, /\| Node\.js \| UT run \(partial\) \| 12 \|/);
  assert.match(output, /\| Python \| Unavailable \| — \| — \| n\/a \| n\/a \|/);
  assert.match(output, /Python:\*\* Unavailable — the UT job ended `failure` before it uploaded coverage/);
});

test("no upload at all invents no numbers", () => {
  const output = renderCoverageJobSummary({ node: { document: undefined }, python: { document: undefined }, producer: "cancelled" });
  assert.match(output, /\| Node\.js \| Unavailable \| — \| — \| n\/a \| n\/a \|/);
  assert.match(output, /\| Python \| Unavailable \| — \| — \| n\/a \| n\/a \|/);
  assert.doesNotMatch(output, /UT run: profile/);
  assert.doesNotMatch(output, /%/);
});

test("a passing UT job with nothing to show is named as the defect it is", () => {
  const output = renderCoverageJobSummary({ node: { document: undefined }, python: { document: pythonDocument }, producer: "success" });
  assert.match(output, /Node\.js:\*\* Unavailable — the UT job passed but no coverage for this runtime reached this job/);
});
