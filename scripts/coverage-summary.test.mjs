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
    // Per-file totals exclude test sources and add up to the summary.
    assert.deepEqual(doc.sources.map((source) => source.path), ["packages/example/dist/index.js"]);
    assert.deepEqual(doc.sources[0].totals.lines, doc.totals.lines);
    assert.deepEqual(doc.sources[0].totals.functions, doc.totals.functions);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Every test file is measured in a process of its own, the way the shared
// runner executes them, so one source file arrives as many partial records.
const partial = (covered) => `TN:
SF:packages/example/src/index.ts
FN:3,alpha
FN:9,beta
FNDA:${covered === "alpha" ? 1 : 0},alpha
FNDA:${covered === "beta" ? 2 : 0},beta
FNF:2
FNH:1
BRDA:4,0,0,${covered === "alpha" ? 1 : "-"}
BRDA:4,0,1,${covered === "beta" ? 3 : "-"}
BRF:2
BRH:1
DA:3,${covered === "alpha" ? 1 : 0}
DA:4,1
DA:9,${covered === "beta" ? 2 : 0}
LF:3
LH:${covered === "alpha" ? 2 : 2}
end_of_record
`;

test("one source measured by several isolated runs is merged, not counted twice", () => {
  const summary = summarizeCoverage(parseLcov(partial("alpha") + partial("beta")));
  assert.equal(summary.files, 1);
  // Three distinct lines, all of them reached once the runs are put together.
  assert.deepEqual(summary.totals.lines, { covered: 3, percentage: 100, total: 3 });
  assert.deepEqual(summary.totals.functions, { covered: 2, percentage: 100, total: 2 });
  assert.deepEqual(summary.totals.branches, { covered: 2, percentage: 100, total: 2 });
  // Hits add up: line 4 was executed by both runs.
  assert.match(summary.records[0].text, /^DA:4,2$/m);
});

test("a record carrying only totals is not merged into a zero", () => {
  const summary = summarizeCoverage(parseLcov(lcov + lcov));
  assert.equal(summary.files, 1);
  assert.deepEqual(summary.totals.lines, { covered: 6, percentage: 75, total: 8 });
});
