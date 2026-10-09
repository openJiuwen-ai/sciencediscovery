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

// Merge the coverage the gate's layers recorded into the summaries CI publishes.
//
// This reads files and writes files. It runs no test and starts no process:
// every number describes a run that gated the change, because that run
// recorded it — `pnpm ci:ut -- --coverage` and `pnpm ci:st -- --coverage` each
// leave one lcov per Node test file, one coverage.py report for every Python
// process they started, and a manifest saying which plan they measured.
//
// A source file is credited with everything any layer executed in it: a unit
// test of its own package, another package's test reaching it through a
// dependency, the system test driving it end to end. The merged figure is what
// the gate, taken whole, ran of the product.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isTestSource, parseLcov, summarizeCoverage, writeCoverageSummary } from "./coverage-summary.mjs";
import { aggregatePythonCoverage, isPythonTestSource, pythonSummaryDocument } from "./python-coverage-summary.mjs";

/** The directory a source is reported under: a workspace package, or a top-level tree. */
export function groupOf(source) {
  const parts = source.split("/");
  if ([".ci", "config", "scripts", "skills"].includes(parts[0])) return parts[0];
  if (["apps", "packages", "services"].includes(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return undefined;
}

export function safeName(group) {
  return group.replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "") || "group";
}

/**
 * Which group a measured file counts towards, if any. Built output and
 * installed dependencies are nobody's source — with source maps the run
 * already resolved built code to the TypeScript it came from — and the test
 * harness and the tests themselves are not the product.
 */
export function attribute(file) {
  if (!file || file.startsWith("/")) return undefined;
  if (file.split("/").some((part) => part === "dist" || part === "node_modules" || part === ".venv")) return undefined;
  if (isTestSource(file) || isPythonTestSource(file)) return undefined;
  return groupOf(file);
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

/**
 * coverage.py reports, merged line by line: a statement is covered if any
 * process executed it, and a branch if any process took it. The result has the
 * shape `summarizePythonCoverage` reads, so one summary serves one report or
 * several.
 */
export function mergePythonReports(reports) {
  const files = new Map();
  for (const report of reports) {
    for (const [file, data] of Object.entries(report?.files ?? {})) {
      if (!attribute(file)) continue;
      const merged = files.get(file) ?? { statements: new Set(), executed: new Set(), branches: new Set(), taken: new Set() };
      for (const line of [...(data.executed_lines ?? []), ...(data.missing_lines ?? [])]) merged.statements.add(line);
      for (const line of data.executed_lines ?? []) merged.executed.add(line);
      for (const arc of [...(data.executed_branches ?? []), ...(data.missing_branches ?? [])]) merged.branches.add(String(arc));
      for (const arc of data.executed_branches ?? []) merged.taken.add(String(arc));
      files.set(file, merged);
    }
  }
  return {
    files: Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)).map(([file, merged]) => [file, {
      summary: {
        covered_branches: merged.taken.size,
        covered_lines: merged.executed.size,
        num_branches: merged.branches.size,
        num_statements: merged.statements.size,
      },
    }])),
  };
}

/** One layer's upload: its manifest, its Node records by group, its Python report. */
async function readLayer({ layer, input, producer }) {
  const manifest = await readJson(join(input, "manifest.json"));
  const lcov = await listing(join(input, "node"), ".lcov");
  const node = [];
  for (const name of lcov) {
    for (const record of parseLcov(await readFile(join(input, "node", name), "utf8"))) {
      const group = attribute(record.file);
      if (group) node.push({ group, record });
    }
  }
  const python = await readJson(join(input, "python.json"));

  const problems = [];
  if (!manifest) problems.push("no manifest.json: the run did not finish writing its coverage");
  if (manifest && lcov.length < manifest.node.expected) problems.push(`Node: ${lcov.length} of ${manifest.node.expected} test files left coverage`);
  const processes = manifest?.python?.processes ?? null;
  if (processes?.measured > 0 && !python) problems.push(`Python: ${processes.measured} measured process(es) but no report`);
  if (manifest && manifest.status !== "PASS") problems.push(`the run ended ${manifest.status}`);
  const run = manifest
    ? Object.fromEntries(["profile", "slice", "revision", "plan_digest", "status", "planned", "executed", "passed", "failed", "skipped"]
      .map((key) => [key, manifest[key] ?? null]))
    : null;
  return {
    layer, producer, run, processes, problems,
    complete: producer === "success" && problems.length === 0,
    lcov: lcov.length, node, python,
  };
}

async function writeNode({ output, layers, metadata }) {
  const byGroup = new Map();
  for (const { group, record } of layers.flatMap((layer) => layer.node)) {
    byGroup.set(group, [...(byGroup.get(group) ?? []), record.text]);
  }
  if (byGroup.size === 0) return undefined;
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
  return writeCoverageSummary({
    input: join(output, ".node.lcov"),
    jsonOutput: join(output, "summary.json"),
    lcovOutput: join(output, "lcov.info"),
    metadata: { ...metadata, groups, selected_groups: groups.map((group) => group.name) },
  });
}

async function writePython({ output, layers, metadata }) {
  const merged = mergePythonReports(layers.map((layer) => layer.python).filter(Boolean));
  const byGroup = new Map();
  for (const [file, data] of Object.entries(merged.files)) {
    const group = attribute(file);
    byGroup.set(group, { files: { ...(byGroup.get(group)?.files ?? {}), [file]: data } });
  }
  if (byGroup.size === 0) return undefined;
  const groups = [];
  for (const [group, report] of [...byGroup].sort(([left], [right]) => left.localeCompare(right))) {
    const directory = join(output, "python", "groups", safeName(group));
    await mkdir(directory, { recursive: true });
    const document = pythonSummaryDocument(report, { ...metadata, group });
    await writeFile(join(directory, "summary.json"), `${JSON.stringify(document, null, 2)}\n`);
    groups.push(document);
  }
  const aggregate = aggregatePythonCoverage(groups, { ...metadata, selected_groups: groups.map((group) => group.group) });
  await writeFile(join(output, "python", "summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
  return aggregate;
}

/** What each layer contributed on its own, next to the merged figure. */
function layerTotals(layer) {
  const node = layer.node.length ? summarizeCoverage(layer.node.map(({ record }) => record)) : null;
  const python = layer.python ? pythonSummaryDocument(mergePythonReports([layer.python])) : null;
  return {
    complete: layer.complete,
    node: node && { files: node.files, totals: node.totals },
    problems: layer.problems,
    processes: layer.processes,
    producer: layer.producer,
    python: python && { files: python.files, totals: python.totals },
    run: layer.run,
  };
}

/**
 * Build every summary from the layers' uploads into `output`. A layer is whole
 * when its job passed and it left coverage for every Node test file it ran and
 * a report for the Python it measured. A layer whose job did not pass is
 * summarised as far as its upload goes — nothing is re-run to complete it.
 */
export async function buildCoverageReport({ layers: requested, output }) {
  await rm(join(output, "groups"), { recursive: true, force: true });
  await rm(join(output, "python"), { recursive: true, force: true });
  for (const name of ["summary.json", "lcov.info", ".node.lcov", "layers.json"]) await rm(join(output, name), { force: true });
  await mkdir(join(output, "python"), { recursive: true });

  const layers = [];
  for (const layer of requested) layers.push(await readLayer(layer));
  const byLayer = Object.fromEntries(layers.map((layer) => [layer.layer, layerTotals(layer)]));
  const metadata = { layers: byLayer };
  const node = await writeNode({ output, layers, metadata });
  const python = await writePython({ output, layers, metadata });
  // Written even when no layer uploaded anything, so the run page can say which
  // job it was waiting on and how that job ended.
  await writeFile(join(output, "layers.json"), `${JSON.stringify(byLayer, null, 2)}\n`);
  return { layers, byLayer, node, python };
}

function pairs(name) {
  const values = [];
  process.argv.forEach((argument, index) => { if (argument === name) values.push(process.argv[index + 1] ?? ""); });
  return Object.fromEntries(values.map((value) => {
    const at = value.indexOf("=");
    return at === -1 ? ["ut", value] : [value.slice(0, at), value.slice(at + 1)];
  }));
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const output = resolve(outputIndex === -1 ? "coverage" : process.argv[outputIndex + 1]);
  // `--layer ut=<dir>` for each uploaded layer, and how the job that recorded it
  // ended as the workflow saw it: a failed layer is reported on, not repaired.
  const inputs = pairs("--layer");
  const producers = pairs("--producer");
  const layers = Object.keys(inputs).length > 0
    ? Object.entries(inputs).map(([layer, input]) => ({ layer, input: resolve(input), producer: producers[layer] ?? "success" }))
    : ["ut", "st"].map((layer) => ({ layer, input: resolve(".test-runs", layer, "coverage"), producer: producers[layer] ?? "success" }));
  const report = await buildCoverageReport({ layers, output });
  for (const layer of report.layers) {
    const totals = report.byLayer[layer.layer];
    console.log(`${layer.layer}: ${layer.producer}; ${layer.lcov} Node test file(s) -> ${totals.node?.files ?? 0} source files; `
      + `Python ${totals.python?.files ?? 0} source files from ${layer.processes?.measured ?? 0} measured process(es)`);
    for (const problem of layer.problems) console.log(`  - ${problem}`);
  }
  console.log(`merged: Node ${report.node?.files ?? 0} source files, Python ${report.python?.files ?? 0} source files`);
  const broken = report.layers.filter((layer) => layer.producer === "success" && !layer.complete);
  if (broken.length > 0) {
    // The job passed, so every file it ran should have left coverage. Missing
    // data here is a defect in the pipeline, not a partial result to shrug at.
    console.error(`${broken.map((layer) => layer.layer).join(", ")}: the run passed but its coverage is incomplete.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
