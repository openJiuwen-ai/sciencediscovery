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

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { aggregatePythonCoverage, writePythonCoverageSummary } from "./python-coverage-summary.mjs";
import { pythonCoverageGroups } from "./select-python-coverage-groups.mjs";

const root = process.cwd();
const coverageDirectory = resolve(root, "coverage", "python");
const coverageRequirement = "coverage>=7.6,<8";
const groupsOptionIndex = process.argv.indexOf("--groups");
const requestedGroupNames = groupsOptionIndex === -1
  ? []
  : (process.argv[groupsOptionIndex + 1] || "").split(",").map((name) => name.trim()).filter(Boolean);
const coverageMode = process.env.COVERAGE_MODE?.trim() || (requestedGroupNames.length > 0 ? "incremental" : "full");
const generatedAt = new Date().toISOString();
const sourceSha = process.env.GITHUB_SHA?.trim() || process.env.COVERAGE_SOURCE_SHA?.trim() || null;
const baseSha = process.env.COVERAGE_BASE_SHA?.trim() || null;

const serviceDefinitions = new Map([
  ["services/evolve", {
    extras: ["test", "candidates"],
    runner: ["-m", "pytest", "services/evolve/tests"],
    source: "services/evolve/src",
  }],
  ["services/gateway", {
    extras: [],
    runner: ["-m", "unittest", "discover", "-s", "services/gateway/tests", "-p", "test_*.py"],
    source: "services/gateway/src",
  }],
  ["services/memory-graph", {
    extras: ["test"],
    runner: ["-m", "pytest", "services/memory-graph/tests"],
    source: "services/memory-graph/src",
  }],
  ["services/paper", {
    extras: [],
    runner: ["-m", "unittest", "discover", "-s", "services/paper/tests"],
    source: "services/paper",
  }],
]);

function safeName(group) {
  return group.replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function uvPrefix(group, definition) {
  return [
    "run",
    "--project",
    group,
    "--locked",
    ...definition.extras.flatMap((extra) => ["--extra", extra]),
    "--with",
    coverageRequirement,
  ];
}

function run(command, args, options = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit(code ?? (signal ? 128 : 1)));
  });
}

async function hasParallelData(directory) {
  return (await readdir(directory)).some((name) => name.startsWith(".coverage."));
}

async function runGroup(group) {
  const definition = serviceDefinitions.get(group);
  if (!definition) throw new Error(`No Python coverage definition for ${group}`);
  const directory = join(coverageDirectory, "groups", safeName(group));
  await mkdir(directory, { recursive: true });
  const coverageFile = join(directory, ".coverage");
  const environment = { ...process.env, COVERAGE_FILE: coverageFile };
  const uv = uvPrefix(group, definition);
  console.log(`[coverage:python] ${group}`);
  const testCode = await run("uv", [
    ...uv,
    "coverage",
    "run",
    "--branch",
    "--parallel-mode",
    `--source=${definition.source}`,
    "--omit=*/tests/*,*/test_*.py",
    ...definition.runner,
  ], { env: environment });

  if (!await hasParallelData(directory)) {
    console.error(`[coverage:python] ${group} produced no coverage data`);
    return { code: testCode || 1, group };
  }

  const combineCode = await run("uv", [...uv, "coverage", "combine", directory], { env: environment });
  const rawJson = join(directory, ".coverage.json");
  const jsonCode = combineCode === 0
    ? await run("uv", [...uv, "coverage", "json", "-o", rawJson], { env: environment })
    : combineCode;
  if (jsonCode !== 0) return { code: testCode || jsonCode, group };

  const summary = await writePythonCoverageSummary({
    input: rawJson,
    jsonOutput: join(directory, "summary.json"),
    metadata: {
      base_sha: baseSha,
      generated_at: generatedAt,
      group,
      mode: coverageMode,
      source_sha: sourceSha,
    },
  });
  await rm(rawJson, { force: true });
  await rm(coverageFile, { force: true });
  return { code: testCode, group, summary };
}

const unknownGroups = requestedGroupNames.filter((name) => !serviceDefinitions.has(name));
if (unknownGroups.length > 0) throw new Error(`Unknown Python coverage groups: ${unknownGroups.join(", ")}`);
const selected = new Set(requestedGroupNames);
const groups = requestedGroupNames.length > 0
  ? pythonCoverageGroups.filter((group) => selected.has(group))
  : pythonCoverageGroups;
if (groups.length === 0) throw new Error("No Python coverage groups were selected");

await rm(coverageDirectory, { recursive: true, force: true });
await mkdir(join(coverageDirectory, "groups"), { recursive: true });

const results = [];
for (const group of groups) results.push(await runGroup(group));
const failed = results.filter((result) => result.code !== 0 || !result.summary);
for (const result of failed) console.error(`[coverage:python] ${result.group} failed with exit code ${result.code}`);
const reports = results.filter((result) => result.summary).map((result) => result.summary);
if (reports.length === 0) throw new Error("Python tests did not produce any coverage summaries");

const aggregate = aggregatePythonCoverage(reports, {
  authoritative: coverageMode === "full" && failed.length === 0 && reports.length === groups.length,
  base_sha: baseSha,
  generated_at: generatedAt,
  mode: coverageMode,
  selected_groups: groups,
  source_sha: sourceSha,
});
await writeFile(join(coverageDirectory, "summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`Python coverage summary written to ${coverageDirectory}`);
process.exitCode = failed.length === 0 ? 0 : 1;
