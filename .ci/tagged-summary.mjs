#!/usr/bin/env node
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

/**
 * Report what a job's slices of the shared plan actually executed.
 *
 * A layer that stopped before its tests produces no summary at all, and a
 * Playwright run that skipped a journey still exits 0. Both used to reach the
 * run summary as a green check with a sentence about missing results, so this
 * reads the frozen plan's own accounting instead and fails on anything that is
 * not `planned == executed == passed` with nothing skipped.
 */

import { appendFile, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const configuredRoot = process.env.CI_RESULTS_DIR?.trim() || ".ci-results";
const resultsRoot = isAbsolute(configuredRoot) ? configuredRoot : resolve(process.cwd(), configuredRoot);

let layers;
try {
  layers = (await readdir(resultsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch {
  layers = [];
}

const rows = [];
const problems = [];
for (const layer of layers) {
  // Under a layer entry point the plan's evidence sits beside that layer's own
  // log, in `tagged/`; `pnpm test:shared --output` writes it directly. Read
  // either, so the same command reports a local run and a CI one.
  let summary;
  for (const candidate of [join(resultsRoot, layer, "tagged", "summary.json"), join(resultsRoot, layer, "summary.json")]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      if (typeof parsed.planned === "number") { summary = parsed; break; }
    } catch { /* the next candidate, or no plan for this layer at all */ }
  }
  if (!summary) continue;
  rows.push({ layer, ...summary });
  const { planned = 0, executed = 0, passed = 0, failed = 0, skipped = 0 } = summary;
  if (summary.status !== "PASS") problems.push(`${layer}: status ${summary.status}`);
  if (planned === 0) problems.push(`${layer}: selected no test`);
  if (executed !== planned) problems.push(`${layer}: executed ${executed} of ${planned} planned`);
  if (passed !== planned) problems.push(`${layer}: passed ${passed} of ${planned} planned`);
  if (failed > 0) problems.push(`${layer}: ${failed} failed`);
  if (skipped > 0) problems.push(`${layer}: ${skipped} skipped — a skip is not a pass`);
}

if (rows.length === 0) problems.push(`no frozen plan reported under ${resultsRoot}; the layer stopped before it collected its tests`);

const lines = ["### Shared plan", "", "| slice | plan digest | planned | executed | passed | failed | skipped |", "| --- | --- | --- | --- | --- | --- | --- |"];
for (const row of rows) {
  lines.push(`| ${row.layer} | \`${String(row.planDigest).slice(0, 12)}\` | ${row.planned} | ${row.executed} | ${row.passed} | ${row.failed} | ${row.skipped} |`);
}
if (problems.length > 0) lines.push("", "Problems:", "", ...problems.map((problem) => `- ${problem}`));
for (const row of rows) {
  for (const problem of (row.problems ?? []).slice(0, 50)) lines.push(`- ${row.layer}: ${problem}`);
}

const report = `${lines.join("\n")}\n`;
process.stdout.write(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
process.exitCode = problems.length > 0 ? 1 : 0;
