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

const scope = "Product Python — the service sources, the paper worker, Runner workloads and bundled skills — as executed by every Python process the run started; excludes test sources.";

function percentage(covered, total) {
  return total === 0 ? null : Number(((covered / total) * 100).toFixed(2));
}

export function isPythonTestSource(file) {
  const normalized = file.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1) || "";
  return /(^|\/)(?:test|tests|__tests__|\.venv)\//.test(normalized)
    || /^test_.*\.py$/i.test(basename)
    || /_test\.py$/i.test(basename);
}

function metric(covered, total) {
  return { covered, percentage: percentage(covered, total), total };
}

export function summarizePythonCoverage(document) {
  const measured = Object.entries(document.files || {}).filter(([file]) => !isPythonTestSource(file));
  const lineCovered = measured.reduce((sum, [, value]) => sum + (value.summary?.covered_lines || 0), 0);
  const lineTotal = measured.reduce((sum, [, value]) => sum + (value.summary?.num_statements || 0), 0);
  const branchCovered = measured.reduce((sum, [, value]) => sum + (value.summary?.covered_branches || 0), 0);
  const branchTotal = measured.reduce((sum, [, value]) => sum + (value.summary?.num_branches || 0), 0);
  return {
    files: measured.length,
    // Each measured file's own totals, so a reader can go from a directory down to a file.
    sources: measured.map(([file, value]) => ({
      path: file,
      totals: {
        branches: metric(value.summary?.covered_branches || 0, value.summary?.num_branches || 0),
        lines: metric(value.summary?.covered_lines || 0, value.summary?.num_statements || 0),
      },
    })).sort((left, right) => left.path.localeCompare(right.path)),
    totals: {
      branches: metric(branchCovered, branchTotal),
      lines: metric(lineCovered, lineTotal),
    },
  };
}

/** The summary document for a coverage.py report, without touching the disk. */
export function pythonSummaryDocument(report, metadata = {}) {
  const summary = summarizePythonCoverage(report);
  return {
    schema_version: 1,
    language: "python",
    ...metadata,
    files: summary.files,
    sources: summary.sources,
    scope,
    totals: summary.totals,
  };
}

export async function writePythonCoverageSummary({ input, jsonOutput, metadata = {} }) {
  const document = pythonSummaryDocument(JSON.parse(await readFile(input, "utf8")), metadata);
  await writeFile(jsonOutput, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

export function aggregatePythonCoverage(groups, metadata = {}) {
  const totals = {};
  for (const metricName of ["branches", "lines"]) {
    const covered = groups.reduce((sum, group) => sum + group.totals[metricName].covered, 0);
    const total = groups.reduce((sum, group) => sum + group.totals[metricName].total, 0);
    totals[metricName] = metric(covered, total);
  }
  return {
    schema_version: 1,
    language: "python",
    ...metadata,
    files: groups.reduce((sum, group) => sum + group.files, 0),
    groups: groups.map(({ files, group, totals: groupTotals }) => ({
      files,
      name: group,
      totals: groupTotals,
    })),
    sources: groups.flatMap((group) => group.sources ?? []).sort((left, right) => left.path.localeCompare(right.path)),
    scope,
    totals,
  };
}

async function main() {
  const [input, jsonOutput] = process.argv.slice(2);
  if (!input || !jsonOutput) {
    throw new Error("usage: node scripts/python-coverage-summary.mjs <coverage-json> <summary-json>");
  }
  const summary = await writePythonCoverageSummary({ input: resolve(input), jsonOutput: resolve(jsonOutput) });
  for (const metricName of ["lines", "branches"]) {
    const value = summary.totals[metricName];
    const text = value.percentage === null ? "n/a" : `${value.percentage.toFixed(2)}%`;
    console.log(`${metricName}: ${value.covered}/${value.total} (${text})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
