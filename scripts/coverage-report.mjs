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

// Merge the coverage a gate run recorded into the summaries CI publishes.
//
// This reads files and writes files. It runs no test and starts no process:
// the numbers describe the run that gated the change, because they were
// recorded by it — `pnpm ci:ut -- --coverage` writes one lcov per Node test
// file and one coverage.py report per Python project, plus a manifest saying
// which plan they measured. Nothing here can re-select or re-run a case, so
// there is no second execution to disagree with the first.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLcov, writeCoverageSummary } from "./coverage-summary.mjs";
import { aggregatePythonCoverage, writePythonCoverageSummary } from "./python-coverage-summary.mjs";

/** The directory a report is attributed to: a workspace package, or a top-level tree of scripts. */
export function groupOf(source) {
  const parts = source.split("/");
  if ([".ci", "config", "scripts"].includes(parts[0])) return parts[0];
  if (["apps", "packages", "services"].includes(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return undefined;
}

export function safeName(group) {
  return group.replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "") || "group";
}

/**
 * Which group a Node record counts towards, if any. A package is credited with
 * what its own tests exercise: a record measuring `packages/cas` from a test
 * under `services/api` is that test's dependency, not cas's coverage. Built
 * output and installed dependencies are nobody's source, and a record without
 * a test name did not come from a gate run.
 */
export function attribute(record) {
  const test = record.text.match(/^TN:(.+)$/m)?.[1];
  const group = test && groupOf(test);
  if (!group || record.file.startsWith("/")) return undefined;
  if (record.file !== group && !record.file.startsWith(`${group}/`)) return undefined;
  if (record.file.split("/").some((part) => part === "dist" || part === "node_modules")) return undefined;
  return group;
}

async function listing(directory, suffix) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(suffix)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** What the producing run said about itself, carried into every summary. */
function runMetadata(manifest, producer) {
  const run = manifest
    ? Object.fromEntries(["profile", "slice", "revision", "plan_digest", "status", "planned", "executed", "passed", "failed", "skipped"]
      .map((key) => [key, manifest[key] ?? null]))
    : null;
  return { producer, run };
}

async function reportNode({ input, output, metadata }) {
  const files = await listing(join(input, "node"), ".lcov");
  const byGroup = new Map();
  for (const name of files) {
    for (const record of parseLcov(await readFile(join(input, "node", name), "utf8"))) {
      const group = attribute(record);
      if (group) byGroup.set(group, [...(byGroup.get(group) ?? []), record.text]);
    }
  }
  if (byGroup.size === 0) return { lcov: files.length, document: undefined };
  const groups = [];
  for (const [group, records] of [...byGroup].sort(([left], [right]) => left.localeCompare(right))) {
    const directory = join(output, "groups", safeName(group));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".node.lcov"), records.join(""));
    const summary = await writeCoverageSummary({
      input: join(directory, ".node.lcov"),
      jsonOutput: join(directory, "summary.json"),
      lcovOutput: join(directory, "lcov.info"),
      metadata: { ...metadata, group },
    });
    groups.push({ files: summary.files, name: group, totals: summary.totals });
  }
  await writeFile(join(output, ".node.lcov"), [...byGroup.values()].flat().join(""));
  const summary = await writeCoverageSummary({
    input: join(output, ".node.lcov"),
    jsonOutput: join(output, "summary.json"),
    lcovOutput: join(output, "lcov.info"),
    metadata: { ...metadata, groups, selected_groups: groups.map((group) => group.name) },
  });
  return { lcov: files.length, document: summary };
}

async function reportPython({ input, output, metadata }) {
  const reports = await listing(join(input, "python"), ".json");
  if (reports.length === 0) return { reports: 0, document: undefined };
  const groups = [];
  for (const name of reports) {
    const group = `services/${name.slice(0, -".json".length)}`;
    const directory = join(output, "python", "groups", safeName(group));
    await mkdir(directory, { recursive: true });
    groups.push(await writePythonCoverageSummary({
      input: join(input, "python", name),
      jsonOutput: join(directory, "summary.json"),
      metadata: { ...metadata, group },
    }));
  }
  const aggregate = aggregatePythonCoverage(groups, { ...metadata, selected_groups: groups.map((group) => group.group) });
  await writeFile(join(output, "python", "summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  return { reports: reports.length, document: aggregate };
}

/**
 * Build every summary from `input` into `output` and say whether the data is
 * whole. It is whole when the run that recorded it passed and left one lcov
 * for each Node test file it executed and one report for each Python project.
 * Data from a run that did not pass is summarised as far as it goes and marked
 * partial — nothing is re-run to complete it.
 */
export async function buildCoverageReport({ input, output, producer = "success" }) {
  await rm(join(output, "groups"), { recursive: true, force: true });
  await rm(join(output, "python"), { recursive: true, force: true });
  for (const name of ["summary.json", "lcov.info", ".node.lcov"]) await rm(join(output, name), { force: true });
  await mkdir(join(output, "python"), { recursive: true });

  const manifest = await readJson(join(input, "manifest.json"));
  const metadata = runMetadata(manifest, producer);
  const node = await reportNode({ input, output, metadata });
  const python = await reportPython({ input, output, metadata });

  const problems = [];
  if (!manifest) problems.push("no manifest.json: the producing run did not finish writing its coverage");
  if (manifest && node.lcov < manifest.node.expected) problems.push(`Node: ${node.lcov} of ${manifest.node.expected} test files left coverage`);
  const missing = (manifest?.python.expected ?? []).filter((project) => !(manifest.python.projects ?? []).includes(project));
  if (missing.length > 0) problems.push(`Python: no report for ${missing.join(", ")}`);
  if (manifest && manifest.status !== "PASS") problems.push(`the producing run ended ${manifest.status}`);
  return { manifest, node, python, problems, complete: producer === "success" && problems.length === 0 };
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const input = resolve(option("--input", ".test-runs/ut/coverage"));
  const output = resolve(option("--output", "coverage"));
  // How the job that recorded the data ended, as the workflow saw it. A failed
  // gate is reported on, not repaired: its partial data is summarised and the
  // gate's own failure stays the signal.
  const producer = option("--producer", "success");
  const report = await buildCoverageReport({ input, output, producer });
  console.log(`Node: ${report.node.lcov} test file(s) of coverage -> ${report.node.document ? `${report.node.document.files} source files` : "nothing attributable"}`);
  console.log(`Python: ${report.python.reports} project report(s) -> ${report.python.document ? `${report.python.document.files} source files` : "nothing"}`);
  for (const problem of report.problems) console.log(`- ${problem}`);
  if (producer === "success" && !report.complete) {
    // The gate passed, so every file it ran should have left coverage. Missing
    // data here is a defect in the pipeline, not a partial result to shrug at.
    console.error("The producing run passed but its coverage is incomplete.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
