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

import { parseLcov } from "./coverage-summary.mjs";
import { attribute, buildCoverageReport, groupOf } from "./coverage-report.mjs";

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

const pythonReport = (file, covered, statements) => JSON.stringify({
  files: { [file]: { summary: { covered_lines: covered, num_statements: statements, covered_branches: 0, num_branches: 0 } } },
});

async function recorded(layout) {
  const input = await mkdtemp(join(tmpdir(), "science-coverage-report-"));
  for (const [path, text] of Object.entries(layout)) {
    await mkdir(join(input, path, ".."), { recursive: true });
    await writeFile(join(input, path), text);
  }
  return input;
}

const manifest = (overrides = {}) => JSON.stringify({
  schema_version: 1, profile: "pr", slice: "ut", plan_digest: "d".repeat(64), status: "PASS",
  planned: 3, executed: 3, passed: 3, failed: 0, skipped: 0,
  node: { lcov: 2, expected: 2 }, python: { projects: ["paper"], expected: ["paper"] },
  ...overrides,
});

test("a report is attributed to the directory it measures", () => {
  assert.equal(groupOf("packages/cas/src/store.test.ts"), "packages/cas");
  assert.equal(groupOf("apps/web/tests/Toasts.test.tsx"), "apps/web");
  assert.equal(groupOf(".ci/ci-contract.test.mjs"), ".ci");
  assert.equal(groupOf("scripts/binary-release/fetch-runtime.test.mjs"), "scripts");
  assert.equal(groupOf("config/test/external-urls.test.mjs"), "config");
  assert.equal(groupOf("test/api/agent_loop_smoke.ts"), undefined);
});

test("a package is credited only with what its own tests exercised", () => {
  const [own] = parseLcov(record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts"));
  const [dependency] = parseLcov(record("services/api/src/b.test.ts", "packages/cas/src/a.ts"));
  const [built] = parseLcov(record("packages/cas/src/a.test.ts", "packages/cas/dist/a.js"));
  const [installed] = parseLcov(record("packages/cas/src/a.test.ts", "packages/cas/node_modules/x/index.js"));
  const [outside] = parseLcov(record("packages/cas/src/a.test.ts", "/usr/lib/node/x.js"));
  const [anonymous] = parseLcov("SF:packages/cas/src/a.ts\nLF:1\nLH:1\nend_of_record\n");
  assert.equal(attribute(own), "packages/cas");
  for (const other of [dependency, built, installed, outside, anonymous]) assert.equal(attribute(other), undefined);
});

test("isolated runs of one directory merge into one count per source line", async () => {
  const input = await recorded({
    "manifest.json": manifest(),
    "node/a.lcov": record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts", { hit: [1, 2], miss: [3] }),
    "node/b.lcov": record("packages/cas/src/b.test.ts", "packages/cas/src/a.ts", { hit: [3], miss: [1, 2] })
      + record("packages/cas/src/b.test.ts", "services/api/src/c.ts", { hit: [1] }),
    "python/paper.json": pythonReport("services/paper/paper_worker.py", 8, 10),
  });
  const output = await mkdtemp(join(tmpdir(), "science-coverage-output-"));
  try {
    const report = await buildCoverageReport({ input, output });
    assert.equal(report.complete, true, report.problems.join("; "));
    assert.deepEqual(report.node.document.totals.lines, { covered: 3, percentage: 100, total: 3 });
    assert.equal(report.node.document.files, 1);
    const node = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
    assert.deepEqual(node.selected_groups, ["packages/cas"]);
    assert.equal(node.run.planned, 3);
    assert.equal(node.producer, "success");
    const python = JSON.parse(await readFile(join(output, "python", "summary.json"), "utf8"));
    assert.deepEqual(python.selected_groups, ["services/paper"]);
    assert.deepEqual(python.totals.lines, { covered: 8, percentage: 80, total: 10 });
  } finally {
    await rm(input, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("a passing run that left a file without coverage is incomplete", async () => {
  const input = await recorded({
    "manifest.json": manifest({ node: { lcov: 1, expected: 2 }, python: { projects: [], expected: ["paper"] } }),
    "node/a.lcov": record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts", { hit: [1] }),
  });
  const output = await mkdtemp(join(tmpdir(), "science-coverage-output-"));
  try {
    const report = await buildCoverageReport({ input, output, producer: "success" });
    assert.equal(report.complete, false);
    assert.ok(report.problems.some((problem) => /1 of 2 test files/.test(problem)));
    assert.ok(report.problems.some((problem) => /no report for paper/.test(problem)));
  } finally {
    await rm(input, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("a failed run's upload is summarised as far as it goes", async () => {
  const input = await recorded({
    "node/a.lcov": record("packages/cas/src/a.test.ts", "packages/cas/src/a.ts", { hit: [1], miss: [2] }),
  });
  const output = await mkdtemp(join(tmpdir(), "science-coverage-output-"));
  try {
    const report = await buildCoverageReport({ input, output, producer: "failure" });
    assert.equal(report.complete, false);
    assert.equal(report.node.document.files, 1);
    assert.equal(report.python.document, undefined);
    const node = JSON.parse(await readFile(join(output, "summary.json"), "utf8"));
    assert.equal(node.producer, "failure");
    assert.equal(node.run, null);
  } finally {
    await rm(input, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
});

test("nothing uploaded produces no summary rather than a zero", async () => {
  const input = await mkdtemp(join(tmpdir(), "science-coverage-report-"));
  const output = await mkdtemp(join(tmpdir(), "science-coverage-output-"));
  try {
    const report = await buildCoverageReport({ input, output, producer: "failure" });
    assert.equal(report.node.document, undefined);
    assert.equal(report.python.document, undefined);
    await assert.rejects(readFile(join(output, "summary.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(input, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
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
