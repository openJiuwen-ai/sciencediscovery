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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attribute, buildCoverageReport, groupOf, mergePythonReports } from "./coverage-report.mjs";

// What one Node worker leaves behind after `relocateLcov`: every record names
// the test file that produced it and a repository-relative source.
const record = (test, file, { hit = [], miss = [] } = {}) => [
  `TN:${test}`,
  `SF:${file}`,
  ...hit.map((line) => `DA:${line},1`),
  ...miss.map((line) => `DA:${line},0`),
  `LF:${hit.length + miss.length}`,
  `LH:${hit.length}`,
  "end_of_record",
  "",
].join("\n");

// A coverage.py JSON report, as the run's combine step writes it.
const pythonReport = (files) => JSON.stringify({
  files: Object.fromEntries(Object.entries(files).map(([file, { executed = [], missing = [], taken = [], untaken = [] }]) => [file, {
    executed_lines: executed, missing_lines: missing, executed_branches: taken, missing_branches: untaken,
    summary: { covered_lines: executed.length, num_statements: executed.length + missing.length, covered_branches: taken.length, num_branches: taken.length + untaken.length },
  }])),
});

const manifest = (overrides = {}) => JSON.stringify({
  schema_version: 2, profile: "pr", slice: "ut", plan_digest: "d".repeat(64), status: "PASS",
  planned: 3, executed: 3, passed: 3, failed: 0, skipped: 0,
  node: { lcov: 1, expected: 1 }, python: { report: true, processes: { started: 1, measured: 1, unmeasured: [] } },
  ...overrides,
});

async function uploaded(layout) {
  const input = await mkdtemp(join(tmpdir(), "science-coverage-layer-"));
  for (const [path, text] of Object.entries(layout)) {
    await mkdir(join(input, path, ".."), { recursive: true });
    await writeFile(join(input, path), text);
  }
  return input;
}

async function withOutput(body) {
  const output = await mkdtemp(join(tmpdir(), "science-coverage-output-"));
  try {
    return await body(output);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

test("a report is attributed to the directory it measures", () => {
  assert.equal(groupOf("packages/cas/src/store.ts"), "packages/cas");
  assert.equal(groupOf("apps/web/src/App.tsx"), "apps/web");
  assert.equal(groupOf("services/paper/paper_worker.py"), "services/paper");
  assert.equal(groupOf("skills/literature-searcher/scripts/search.py"), "skills");
  assert.equal(groupOf("test/api/agent_loop_smoke.ts"), undefined);
});

test("only product source counts, whichever test reached it", () => {
  assert.equal(attribute("packages/cas/src/a.ts"), "packages/cas");
  assert.equal(attribute("services/memory-graph/src/sciencediscovery_memory_graph/server.py"), "services/memory-graph");
  for (const other of [
    "packages/cas/dist/a.js", "packages/cas/node_modules/x/index.js", "services/paper/.venv/lib/site.py",
    "/usr/lib/node/x.js", "packages/cas/src/a.test.ts", "services/paper/tests/test_worker.py",
    "test/support/tagged/node-worker.mjs",
  ]) assert.equal(attribute(other), undefined, other);
});

test("coverage.py reports merge per statement and per branch", () => {
  const merged = mergePythonReports([
    JSON.parse(pythonReport({ "services/paper/paper_worker.py": { executed: [1, 2], missing: [3], taken: [[2, 3]], untaken: [[2, 4]] } })),
    JSON.parse(pythonReport({ "services/paper/paper_worker.py": { executed: [3], missing: [1, 2], taken: [[2, 4]], untaken: [[2, 3]] } })),
  ]);
  assert.deepEqual(merged.files["services/paper/paper_worker.py"].summary,
    { covered_branches: 2, covered_lines: 3, num_branches: 2, num_statements: 3 });
});

test("UT and ST merge into one count per source line, and each keeps its own", async () => {
  const ut = await uploaded({
    "manifest.json": manifest(),
    "node/a.lcov": record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts", { hit: [1, 2], miss: [3] }),
    "python.json": pythonReport({ "services/paper/paper_worker.py": { executed: [1], missing: [2] } }),
  });
  const st = await uploaded({
    "manifest.json": manifest({ slice: "st", planned: 1, executed: 1, passed: 1, python: { report: false, processes: { started: 0, measured: 0, unmeasured: [] } } }),
    // A system test reaches the package through its public entry, from outside it.
    "node/b.lcov": record("test/api/agent_loop_smoke.ts", "packages/cas/src/a.ts", { hit: [3], miss: [1, 2] })
      + record("test/api/agent_loop_smoke.ts", "services/api/src/agent.ts", { hit: [1] }),
  });
  try {
    await withOutput(async (output) => {
      const report = await buildCoverageReport({ layers: [
        { layer: "ut", input: ut, producer: "success" },
        { layer: "st", input: st, producer: "success" },
      ], output });
      assert.deepEqual(report.layers.map((layer) => layer.complete), [true, true], JSON.stringify(report.layers.map((layer) => layer.problems)));
      assert.deepEqual(report.node.totals.lines, { covered: 4, percentage: 100, total: 4 });
      assert.deepEqual(report.byLayer.ut.node.totals.lines, { covered: 2, percentage: 66.67, total: 3 });
      assert.deepEqual(report.byLayer.st.node.totals.lines, { covered: 2, percentage: 50, total: 4 });
      assert.equal(report.byLayer.st.python, null);
      const node = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
      assert.deepEqual(node.selected_groups, ["packages/cas", "services/api"]);
      assert.equal(node.layers.ut.run.planned, 3);
      const python = JSON.parse(await readFile(join(output, "python", "summary.json"), "utf8"));
      assert.deepEqual(python.selected_groups, ["services/paper"]);
      assert.deepEqual(python.totals.lines, { covered: 1, percentage: 50, total: 2 });
    });
  } finally {
    await rm(ut, { recursive: true, force: true });
    await rm(st, { recursive: true, force: true });
  }
});

test("a passing run that left coverage unwritten is incomplete", async () => {
  const input = await uploaded({
    "manifest.json": manifest({ node: { lcov: 1, expected: 2 } }),
    "node/a.lcov": record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts", { hit: [1] }),
  });
  try {
    await withOutput(async (output) => {
      const [layer] = (await buildCoverageReport({ layers: [{ layer: "ut", input, producer: "success" }], output })).layers;
      assert.equal(layer.complete, false);
      assert.ok(layer.problems.some((problem) => /1 of 2 test files/.test(problem)));
      assert.ok(layer.problems.some((problem) => /measured process\(es\) but no report/.test(problem)));
    });
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("a failed layer's upload is summarised as far as it goes", async () => {
  const input = await uploaded({
    "node/a.lcov": record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts", { hit: [1], miss: [2] }),
  });
  try {
    await withOutput(async (output) => {
      const report = await buildCoverageReport({ layers: [{ layer: "ut", input, producer: "failure" }], output });
      assert.equal(report.layers[0].complete, false);
      assert.equal(report.node.files, 1);
      assert.equal(report.python, undefined);
      const layers = JSON.parse(await readFile(join(output, "layers.json"), "utf8"));
      assert.equal(layers.ut.producer, "failure");
      assert.equal(layers.ut.run, null);
    });
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("nothing uploaded produces no summary rather than a zero, and still names the layer", async () => {
  const input = await mkdtemp(join(tmpdir(), "science-coverage-layer-"));
  try {
    await withOutput(async (output) => {
      const report = await buildCoverageReport({ layers: [{ layer: "st", input, producer: "cancelled" }], output });
      assert.equal(report.node, undefined);
      assert.equal(report.python, undefined);
      await assert.rejects(readFile(join(output, "summary.json"), "utf8"), { code: "ENOENT" });
      assert.equal(JSON.parse(await readFile(join(output, "layers.json"), "utf8")).st.producer, "cancelled");
    });
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("the report reads and writes files and has no way to start a test", async () => {
  // Coverage is merged from what the gate recorded. A process launcher in this
  // import graph would be the first step back to a second execution.
  for (const module of ["coverage-report.mjs", "coverage-summary.mjs", "python-coverage-summary.mjs", "coverage-job-summary.mjs"]) {
    const text = await readFile(new URL(module, import.meta.url), "utf8");
    assert.doesNotMatch(text, /child_process|execa|\bspawn\b|\bexecFile/, module);
  }
});
