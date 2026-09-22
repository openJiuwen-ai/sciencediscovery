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

// Python coverage runs the shared plan's identities for a service, not the
// service's test directory. The difference is the point: `services/memory-graph`
// declares cases that need a live Neo4j as `status:external`, the merge-gate
// profile does not select them, and so coverage does not run them either. They
// keep failing when something does select them — the plan is what decides, not
// whether a database happens to be reachable from this machine.

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { aggregatePythonCoverage, writePythonCoverageSummary } from "./python-coverage-summary.mjs";
import { collect, execute } from "../test/support/tagged/coordinator.mjs";
import { entriesByGroup, planFor, pythonGroups } from "../test/support/tagged/coverage.mjs";
import { subplan } from "../test/support/tagged/plan.mjs";

const root = process.cwd();
const coverageDirectory = resolve(root, "coverage", "python");
const coverageRequirement = "coverage>=7.6,<8";
const groupsOptionIndex = process.argv.indexOf("--groups");
const requestedGroupNames = groupsOptionIndex === -1
  ? []
  : (process.argv[groupsOptionIndex + 1] || "").split(",").map((name) => name.trim()).filter(Boolean);
const profileOptionIndex = process.argv.indexOf("--profile");
// Coverage answers for the same policy the test jobs run, so it takes the
// profile the same way they do and defaults to the merge gate.
const profileName = profileOptionIndex === -1 ? "pr" : (process.argv[profileOptionIndex + 1] || "").trim();
const coverageMode = process.env.COVERAGE_MODE?.trim() || (requestedGroupNames.length > 0 ? "incremental" : "full");
const generatedAt = new Date().toISOString();
const sourceSha = process.env.GITHUB_SHA?.trim() || process.env.COVERAGE_SOURCE_SHA?.trim() || null;
const baseSha = process.env.COVERAGE_BASE_SHA?.trim() || null;

// Which dependency groups each project needs, and which directory its coverage
// is measured over. The extras are the ones the shared runner installs before
// it collects, so coverage reads the same environment CI collects from.
const serviceDefinitions = new Map([
  ["services/evolve", { extras: ["test", "candidates"], source: "services/evolve/src" }],
  ["services/gateway", { extras: [], source: "services/gateway/src" }],
  ["services/memory-graph", { extras: ["test"], source: "services/memory-graph/src" }],
  ["services/paper", { extras: [], source: "services/paper" }],
]);

function safeName(group) {
  return group.replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function uvPrefix(group, definition) {
  return [
    "uv",
    "run",
    "--project",
    group,
    "--locked",
    ...definition.extras.flatMap((extra) => ["--extra", extra]),
    "--with",
    coverageRequirement,
  ];
}

/** The same import paths the shared runner gives a project's own interpreter. */
function projectEnv(group, extra = {}) {
  return { ...process.env, ...extra, PYTHONPATH: [join(root, group, "tests"), join(root, group, "src")].join(":") };
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

async function runGroup(group, plan, entries) {
  const definition = serviceDefinitions.get(group);
  if (!definition) throw new Error(`No Python coverage definition for ${group}`);
  const directory = join(coverageDirectory, "groups", safeName(group));
  await mkdir(directory, { recursive: true });
  const coverageFile = join(directory, ".coverage");
  const environment = projectEnv(group, { COVERAGE_FILE: coverageFile });
  const uv = uvPrefix(group, definition);
  console.log(`[coverage:python] ${group}: ${entries.length} planned identit${entries.length === 1 ? "y" : "ies"}`);
  const summary = await execute({
    root,
    plan: subplan(plan, entries),
    outputDir: join(directory, "tagged"),
    // `coverage run … -m pytest` is the interpreter for this run. Everything
    // else about the invocation is the harness's, unchanged.
    pythonCommand: [...uv, "coverage", "run", "--branch", "--parallel-mode",
      `--source=${definition.source}`, "--omit=*/tests/*,*/test_*.py"],
    env: environment,
    timeoutMs: 1_800_000,
  });
  const testCode = summary.exitCode;
  if (testCode !== 0) console.error(`[coverage:python] ${group}: ${summary.problems.slice(0, 5).join("; ")}`);

  if (!await hasParallelData(directory)) {
    console.error(`[coverage:python] ${group} produced no coverage data`);
    return { code: testCode || 1, group };
  }

  const combineCode = await run(uv[0], [...uv.slice(1), "coverage", "combine", directory], { cwd: root, env: environment });
  const rawJson = join(directory, ".coverage.json");
  const jsonCode = combineCode === 0
    ? await run(uv[0], [...uv.slice(1), "coverage", "json", "-o", rawJson], { cwd: root, env: environment })
    : combineCode;
  if (jsonCode !== 0) return { code: testCode || jsonCode, group };

  const report = await writePythonCoverageSummary({
    input: rawJson,
    jsonOutput: join(directory, "summary.json"),
    metadata: {
      base_sha: baseSha,
      generated_at: generatedAt,
      group,
      mode: coverageMode,
      plan_digest: plan.digest,
      planned: entries.length,
      profile: profileName,
      source_sha: sourceSha,
    },
  });
  await rm(rawJson, { force: true });
  await rm(coverageFile, { force: true });
  return { code: testCode, group, summary: report };
}

const availableGroups = pythonGroups(root);
const availableNames = new Set(availableGroups.map((group) => group.name));
const unknownGroups = requestedGroupNames.filter((name) => !availableNames.has(name));
if (unknownGroups.length > 0) throw new Error(`Unknown Python coverage groups: ${unknownGroups.join(", ")}`);
const selected = new Set(requestedGroupNames);
const requested = requestedGroupNames.length > 0
  ? availableGroups.filter((group) => selected.has(group.name))
  : availableGroups;
if (requested.length === 0) throw new Error("No Python coverage groups were selected");

await rm(coverageDirectory, { recursive: true, force: true });
await mkdir(join(coverageDirectory, "groups"), { recursive: true });

// Each project is collected against its own environment, and the catalogs then
// make one plan: the selector and targets are the profile's, exactly as
// `pnpm test:shared` freezes them.
const catalog = [];
for (const group of requested) {
  const definition = serviceDefinitions.get(group.name);
  if (!definition) throw new Error(`No Python coverage definition for ${group.name}`);
  catalog.push(...collect({
    root,
    files: group.files,
    outputDir: join(coverageDirectory, "groups", safeName(group.name), "collect"),
    pythonCommand: [...uvPrefix(group.name, definition), "python"],
    env: projectEnv(group.name),
  }));
}
const plan = planFor(catalog, { root, profileName });
const planned = entriesByGroup(plan);
const groups = requested.filter((group) => planned.has(group.name)).map((group) => group.name);
const empty = requested.filter((group) => !planned.has(group.name)).map((group) => group.name);
if (empty.length > 0) console.log(`[coverage:python] no planned identity in: ${empty.join(", ")}`);
if (groups.length === 0) throw new Error("The shared plan selects no test in the requested Python groups");
console.log(`plan profile=${profileName}; selector=${plan.selector}; targets=${plan.targets.map((target) => `${target.os}/${target.arch}`).join(" ")}; digest=${plan.digest}`);

const results = [];
for (const group of groups) results.push(await runGroup(group, plan, planned.get(group)));
const failed = results.filter((result) => result.code !== 0 || !result.summary);
for (const result of failed) console.error(`[coverage:python] ${result.group} failed with exit code ${result.code}`);
const reports = results.filter((result) => result.summary).map((result) => result.summary);
if (reports.length === 0) throw new Error("Python tests did not produce any coverage summaries");

const aggregate = aggregatePythonCoverage(reports, {
  authoritative: coverageMode === "full" && failed.length === 0 && reports.length === groups.length,
  base_sha: baseSha,
  generated_at: generatedAt,
  mode: coverageMode,
  plan_digest: plan.digest,
  plan_selector: plan.selector,
  profile: profileName,
  selected_groups: groups,
  source_sha: sourceSha,
});
await writeFile(join(coverageDirectory, "summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`Python coverage summary written to ${coverageDirectory}`);
process.exitCode = failed.length === 0 ? 0 : 1;
