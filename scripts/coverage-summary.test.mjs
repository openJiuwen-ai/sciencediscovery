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

import { isTestSource, markdownSummary, parseLcov, summarizeCoverage } from "./coverage-summary.mjs";

const lcov = `TN:
SF:packages/example/dist/index.js
FNF:2
FNH:1
BRF:4
BRH:3
LF:8
LH:6
end_of_record
TN:
SF:packages/example/dist/index.test.js
FNF:1
FNH:1
BRF:1
BRH:1
LF:2
LH:2
end_of_record
`;

test("identifies Node test sources on Windows and POSIX paths", () => {
  assert.equal(isTestSource("packages/example/dist/index.test.js"), true);
  assert.equal(isTestSource("packages\\example\\dist\\index.test.mjs"), true);
  assert.equal(isTestSource("test/fixtures/mcp-echo.mjs"), true);
  assert.equal(isTestSource("packages/example/tests/helper.js"), true);
  assert.equal(isTestSource("packages/example/__tests__/helper.js"), true);
  assert.equal(isTestSource("packages/example/dist/index.spec.js"), true);
  assert.equal(isTestSource(".tmp/mcp-test/server.mjs"), true);
  assert.equal(isTestSource("packages/example/dist/index.js"), false);
});

test("excludes test files and aggregates LCOV counters", () => {
  const summary = summarizeCoverage(parseLcov(lcov));
  assert.equal(summary.files, 1);
  assert.deepEqual(summary.totals.lines, { covered: 6, percentage: 75, total: 8 });
  assert.deepEqual(summary.totals.branches, { covered: 3, percentage: 75, total: 4 });
  assert.deepEqual(summary.totals.functions, { covered: 1, percentage: 50, total: 2 });
  assert.match(markdownSummary(summary), /Lines \| 6\/8 \| 75\.00%/);
});

test("accepts an LCOV file whose final record has no trailing newline", () => {
  const records = parseLcov(lcov.trimEnd());
  assert.equal(records.length, 2);
  assert.equal(records[1].file, "packages/example/dist/index.test.js");
});
