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

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const metricKeys = {
  branches: ["BRH", "BRF"],
  functions: ["FNH", "FNF"],
  lines: ["LH", "LF"],
};

function numericField(lines, key) {
  const field = lines.find((line) => line.startsWith(`${key}:`));
  return field ? Number(field.slice(key.length + 1)) : 0;
}

export function parseLcov(source) {
  return source.split(/end_of_record(?:\r?\n|$)/).map((record) => {
    const text = record.trim();
    if (!text) return undefined;
    const lines = text.split("\n");
    const file = lines.find((line) => line.startsWith("SF:"))?.slice(3);
    if (!file) throw new Error("LCOV record is missing an SF field");
    const metrics = Object.fromEntries(Object.entries(metricKeys).map(([name, [covered, total]]) => [name, {
      covered: numericField(lines, covered),
      total: numericField(lines, total),
    }]));
    return { file, metrics, text: `${text}\nend_of_record\n` };
  }).filter(Boolean);
}

export function isTestSource(file) {
  const normalized = file.replaceAll("\\", "/");
  return /(^|\/)(?:test|tests|__tests__|\.tmp)\//.test(normalized)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

function percentage(covered, total) {
  return total === 0 ? null : Number(((covered / total) * 100).toFixed(2));
}

export function summarizeCoverage(records) {
  const measured = records.filter((record) => !isTestSource(record.file));
  const totals = Object.fromEntries(Object.keys(metricKeys).map((name) => {
    const covered = measured.reduce((sum, record) => sum + record.metrics[name].covered, 0);
    const total = measured.reduce((sum, record) => sum + record.metrics[name].total, 0);
    return [name, { covered, percentage: percentage(covered, total), total }];
  }));
  return { files: measured.length, records: measured, totals };
}

export async function writeCoverageSummary({ input, lcovOutput, jsonOutput, metadata = {} }) {
  const records = parseLcov(await readFile(input, "utf8"));
  const summary = summarizeCoverage(records);
  await Promise.all([
    writeFile(lcovOutput, summary.records.map((record) => record.text).join("")),
    writeFile(jsonOutput, `${JSON.stringify({
      schema_version: 1,
      ...metadata,
      files: summary.files,
      scope: "Built Node.js workspace tests and repository CI-script tests; excludes browser/TSX, Python, and Playwright suites.",
      totals: summary.totals,
    }, null, 2)}\n`),
  ]);
  return summary;
}

async function main() {
  const [input = "coverage/.node.lcov", lcovOutput = "coverage/lcov.info", jsonOutput = "coverage/summary.json"] = process.argv.slice(2);
  const summary = await writeCoverageSummary({
    input: resolve(input),
    jsonOutput: resolve(jsonOutput),
    lcovOutput: resolve(lcovOutput),
  });
  for (const metric of ["lines", "branches", "functions"]) {
    const value = summary.totals[metric];
    const percentageText = value.percentage === null ? "n/a" : `${value.percentage.toFixed(2)}%`;
    console.log(`${metric}: ${value.covered}/${value.total} (${percentageText})`);
  }
  console.log(`Coverage summary: ${resolve(jsonOutput)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
