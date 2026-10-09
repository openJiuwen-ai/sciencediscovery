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

/**
 * One file is measured by many runs — the tests that cover it are isolated from
 * each other, so each reports the part it exercised. Summing those records as
 * they stand would count the same lines once per run. Merge them the way
 * `lcov --add-tracefile` does instead: a line's hits add up, a line is covered
 * if any run covered it, and the denominators are the distinct lines,
 * functions and branches rather than their repetitions.
 */
function readRecord(text) {
  const record = { file: "", functionLines: new Map(), functionHits: new Map(), lines: new Map(), branches: new Map() };
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) record.file = line.slice(3);
    else if (line.startsWith("FN:")) {
      const [at, ...name] = line.slice(3).split(",");
      record.functionLines.set(name.join(","), at);
    } else if (line.startsWith("FNDA:")) {
      const [hits, ...name] = line.slice(5).split(",");
      const key = name.join(",");
      record.functionHits.set(key, (record.functionHits.get(key) ?? 0) + Number(hits));
    } else if (line.startsWith("DA:")) {
      const [at, hits] = line.slice(3).split(",");
      record.lines.set(at, (record.lines.get(at) ?? 0) + Number(hits));
    } else if (line.startsWith("BRDA:")) {
      const [at, block, branch, taken] = line.slice(5).split(",");
      const key = `${at},${block},${branch}`;
      const previous = record.branches.get(key);
      // `-` means the branch was never reached in that run, which is not the
      // same as reached zero times; a run that did reach it wins.
      record.branches.set(key, taken === "-" ? previous ?? "-" : String(Number(previous === "-" || previous === undefined ? 0 : previous) + Number(taken)));
    }
  }
  return record;
}

function combineRecords(left, right) {
  const merged = readRecord(`SF:${left.file}`);
  merged.functionLines = new Map([...left.functionLines, ...right.functionLines]);
  for (const source of [left, right]) {
    for (const [name, hits] of source.functionHits) merged.functionHits.set(name, (merged.functionHits.get(name) ?? 0) + hits);
    for (const [at, hits] of source.lines) merged.lines.set(at, (merged.lines.get(at) ?? 0) + hits);
    for (const [key, taken] of source.branches) {
      const previous = merged.branches.get(key);
      merged.branches.set(key, taken === "-" ? previous ?? "-"
        : String(Number(previous === "-" || previous === undefined ? 0 : previous) + Number(taken)));
    }
  }
  return merged;
}

function writeRecord(record) {
  const numeric = (value) => value !== "-" && Number(value) > 0;
  const body = [
    `SF:${record.file}`,
    ...[...record.functionLines].map(([name, at]) => `FN:${at},${name}`),
    ...[...record.functionHits].map(([name, hits]) => `FNDA:${hits},${name}`),
    `FNF:${record.functionLines.size}`,
    `FNH:${[...record.functionHits.values()].filter((hits) => hits > 0).length}`,
    ...[...record.branches].map(([key, taken]) => `BRDA:${key},${taken}`),
    `BRF:${record.branches.size}`,
    `BRH:${[...record.branches.values()].filter(numeric).length}`,
    ...[...record.lines].map(([at, hits]) => `DA:${at},${hits}`),
    `LF:${record.lines.size}`,
    `LH:${[...record.lines.values()].filter((hits) => hits > 0).length}`,
  ];
  const text = `${body.join("\n")}\nend_of_record\n`;
  return parseLcov(text)[0];
}

export function mergeLcovRecords(records) {
  const byFile = new Map();
  for (const record of records) byFile.set(record.file, [...(byFile.get(record.file) ?? []), record]);
  return [...byFile.values()].map((group) => {
    if (group.length === 1) return group[0];
    // Merging is arithmetic over per-line detail. A record that carries only
    // its totals cannot be added to another, so the most-covered one stands
    // rather than a rebuilt record that would read as zero.
    if (!group.every((record) => /^DA:/m.test(record.text))) {
      return group.reduce((best, record) => (record.metrics.lines.covered > best.metrics.lines.covered ? record : best));
    }
    return writeRecord(group.map((record) => readRecord(record.text)).reduce(combineRecords));
  });
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
  const measured = mergeLcovRecords(records).filter((record) => !isTestSource(record.file));
  const totals = Object.fromEntries(Object.keys(metricKeys).map((name) => {
    const covered = measured.reduce((sum, record) => sum + record.metrics[name].covered, 0);
    const total = measured.reduce((sum, record) => sum + record.metrics[name].total, 0);
    return [name, { covered, percentage: percentage(covered, total), total }];
  }));
  return { files: measured.length, records: measured, totals };
}

/** Each measured file's own totals, so a reader can go from a directory down to a file. */
export function sourceTotals(records) {
  return records.map((record) => ({
    path: record.file,
    totals: Object.fromEntries(Object.keys(metricKeys).map((name) => {
      const { covered, total } = record.metrics[name];
      return [name, { covered, percentage: percentage(covered, total), total }];
    })),
  })).sort((left, right) => left.path.localeCompare(right.path));
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
      sources: sourceTotals(summary.records),
      scope: "Node.js sources as written, each credited with what its own directory's tests exercised in the UT run; excludes test files, built output and Playwright journeys.",
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
