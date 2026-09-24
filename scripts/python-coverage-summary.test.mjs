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

import {
  aggregatePythonCoverage,
  isPythonTestSource,
  summarizePythonCoverage,
  writePythonCoverageSummary,
} from "./python-coverage-summary.mjs";

const rawCoverage = {
  files: {
    "services/example/src/example.py": {
      summary: { covered_branches: 3, covered_lines: 6, num_branches: 4, num_statements: 8 },
    },
    "services/example/tests/test_example.py": {
      summary: { covered_branches: 1, covered_lines: 2, num_branches: 1, num_statements: 2 },
    },
  },
};

test("identifies Python test sources on Windows and POSIX paths", () => {
  assert.equal(isPythonTestSource("services/example/tests/test_example.py"), true);
  assert.equal(isPythonTestSource("services\\example\\tests\\test_example.py"), true);
  assert.equal(isPythonTestSource("services/example/src/example_test.py"), true);
  assert.equal(isPythonTestSource("services/example/src/example.py"), false);
});

test("excludes test files and preserves Python line and branch counts", () => {
  const summary = summarizePythonCoverage(rawCoverage);
  assert.equal(summary.files, 1);
  assert.deepEqual(summary.totals.lines, { covered: 6, percentage: 75, total: 8 });
  assert.deepEqual(summary.totals.branches, { covered: 3, percentage: 75, total: 4 });
  assert.deepEqual(summary.sources, [{ path: "services/example/src/example.py", totals: summary.totals }]);
});

test("aggregates services by counts instead of averaging percentages", () => {
  const aggregate = aggregatePythonCoverage([
    {
      files: 1,
      group: "services/one",
      totals: {
        branches: { covered: 1, percentage: 50, total: 2 },
        lines: { covered: 1, percentage: 50, total: 2 },
      },
    },
    {
      files: 1,
      group: "services/two",
      totals: {
        branches: { covered: 8, percentage: 80, total: 10 },
        lines: { covered: 8, percentage: 80, total: 10 },
      },
    },
  ], { authoritative: true, mode: "full" });
  assert.deepEqual(aggregate.totals.lines, { covered: 9, percentage: 75, total: 12 });
  assert.equal(aggregate.authoritative, true);
  assert.equal(aggregate.groups.length, 2);
  assert.deepEqual(aggregate.sources, []);
  const withFiles = aggregatePythonCoverage([
    { files: 1, group: "services/two", sources: [{ path: "services/two/b.py", totals: {} }], totals: { branches: { covered: 0, total: 0 }, lines: { covered: 0, total: 0 } } },
    { files: 1, group: "services/one", sources: [{ path: "services/one/a.py", totals: {} }], totals: { branches: { covered: 0, total: 0 }, lines: { covered: 0, total: 0 } } },
  ]);
  assert.deepEqual(withFiles.sources.map((source) => source.path), ["services/one/a.py", "services/two/b.py"]);
});

test("writes a schema-versioned Python group summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "science-python-coverage-"));
  try {
    const input = join(directory, "coverage.json");
    const output = join(directory, "summary.json");
    await writeFile(input, JSON.stringify(rawCoverage));
    await writePythonCoverageSummary({
      input,
      jsonOutput: output,
      metadata: { group: "services/example", mode: "incremental" },
    });
    const document = JSON.parse(await readFile(output, "utf8"));
    assert.equal(document.schema_version, 1);
    assert.equal(document.language, "python");
    assert.equal(document.group, "services/example");
    assert.equal(document.totals.lines.percentage, 75);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
