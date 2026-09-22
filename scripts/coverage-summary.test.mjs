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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { isTestSource, parseLcov, summarizeCoverage, writeCoverageSummary } from "./coverage-summary.mjs";

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
});

test("accepts an LCOV file whose final record has no trailing newline", () => {
  const records = parseLcov(lcov.trimEnd());
  assert.equal(records.length, 2);
  assert.equal(records[1].file, "packages/example/dist/index.test.js");
});

test("writes schema-versioned group metadata beside totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "science-coverage-summary-"));
  try {
    const input = join(directory, "input.lcov");
    const jsonOutput = join(directory, "summary.json");
    await writeFile(input, lcov);
    await writeCoverageSummary({
      input,
      jsonOutput,
      lcovOutput: join(directory, "lcov.info"),
      metadata: { group: "packages/example", mode: "incremental" },
    });
    const doc = JSON.parse(await readFile(jsonOutput, "utf8"));
    assert.equal(doc.schema_version, 1);
    assert.equal(doc.group, "packages/example");
    assert.equal(doc.mode, "incremental");
    assert.equal(doc.totals.lines.percentage, 75);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
