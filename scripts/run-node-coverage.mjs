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

// Node coverage runs the shared plan's identities, grouped by the directory
// they cover. `--groups` still chooses directories; inside one, the cases are
// whatever `pnpm test:shared` selects there and nothing else. The tests are
// executed by the same worker the shared runner uses, so a case that would
// skip, drift or run on the wrong target fails here exactly as it does in CI.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLcov, writeCoverageSummary } from "./coverage-summary.mjs";
import { collect, nodeResults } from "../test/support/tagged/coordinator.mjs";
import { entriesByGroup, groupCwd, nodeGroups, planFor } from "../test/support/tagged/coverage.mjs";
import { subplan, verifyResults } from "../test/support/tagged/plan.mjs";

const harness = fileURLToPath(new URL("../test/support/tagged/", import.meta.url));
const root = process.cwd();
const coverageDirectory = resolve(root, "coverage");
const partsDirectory = join(coverageDirectory, ".parts");
const rawLcov = join(coverageDirectory, ".node.lcov");
const groupConcurrency = Number(process.env.COVERAGE_TEST_CONCURRENCY?.trim() || "4");
const repositoryRoots = [".ci", "apps", "config", "packages", "scripts", "services"];
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
const caseTimeoutMs = 600_000;

if (!Number.isInteger(groupConcurrency) || groupConcurrency < 1) {
  throw new Error("COVERAGE_TEST_CONCURRENCY must be a positive integer");
}

function portable(path) {
  return path.replaceAll("\\", "/");
}

function safeName(path) {
  const name = portable(path).replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  return name.replace(/^\.+/, "") || "group";
}

/**
 * One worker per source file, which is how the shared runner executes the same
 * entries: a file gets a process of its own, so nothing another file installed
 * on a global is still there when this one runs. Sharing one process across a
 * group would be faster and would measure a different thing.
 */
async function runUnit(unit) {
  const lcov = join(partsDirectory, safeName(unit.group.name), `${unit.index}.lcov`);
  const request = join(partsDirectory, safeName(unit.group.name), `${unit.index}.json`);
  const events = join(partsDirectory, safeName(unit.group.name), `${unit.index}.jsonl`);
  const part = subplan(unit.group.plan, unit.entries);
  await mkdir(join(partsDirectory, safeName(unit.group.name)), { recursive: true });
  await writeFile(request, `${JSON.stringify({ root, files: [unit.file], plan: part, timeoutMs: caseTimeoutMs }, null, 2)}\n`);
  const environment = { ...process.env, SCIENCE_TAG_RUN_REQUEST: request };
  delete environment.NODE_TEST_CONTEXT;
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-test-coverage",
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcov}`,
      `--test-reporter=${join(harness, "node-reporter.mjs")}`,
      `--test-reporter-destination=${events}`,
      join(harness, "node-worker.mjs"),
    ], { cwd: groupCwd(root, unit.group.name), env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status, signal) => resolveExit(status ?? (signal ? 128 : 1)));
  });
  const reported = nodeResults({ reportPath: events, entries: unit.entries, label: unit.file });
  return {
    unit,
    lcov,
    results: reported.results,
    errors: [...reported.errors, ...(code === 0 ? [] : [`NODE_WORKER_FAILED: ${unit.file} exited ${code}`])],
  };
}

async function runBounded(units) {
  const outcomes = [];
  let next = 0;
  async function worker() {
    while (next < units.length) {
      const index = next;
      next += 1;
      outcomes[index] = await runUnit(units[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(groupConcurrency, units.length) }, worker));
  return outcomes;
}

/** Fold a group's per-file runs back into one accounting against its plan. */
async function collectGroup(group, outcomes) {
  const mine = outcomes.filter((outcome) => outcome.unit.group.name === group.name);
  const summary = verifyResults(subplan(group.plan, group.entries),
    mine.flatMap((outcome) => outcome.results), mine.flatMap((outcome) => outcome.errors));
  // Beside the report rather than in `.parts`, which this script deletes: the
  // accounting of what the plan asked for is evidence, not a scratch file.
  const reportDirectory = join(coverageDirectory, "groups", safeName(group.name));
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, "tagged-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return { code: summary.exitCode, group, lcovFiles: mine.map((outcome) => outcome.lcov), summary };
}

function canonicalSource(file, group) {
  const normalized = portable(file);
  const isRepositoryRelative = repositoryRoots.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  const absolute = isAbsolute(file)
    ? resolve(file)
    : resolve(isRepositoryRelative ? root : groupCwd(root, group.name), file);
  const repositoryRelative = portable(relative(root, absolute));
  if (repositoryRelative === ".." || repositoryRelative.startsWith("../")) return undefined;
  if (repositoryRelative !== group.name && !repositoryRelative.startsWith(`${group.name}/`)) return undefined;
  // Coverage is attributed to sources. A test that loads a module out of
  // `dist/` — a few spawn a child against the built tree on purpose — would
  // otherwise report the same code twice, once compiled and once as written.
  if (repositoryRelative.split("/").some((part) => part === "dist" || part === "node_modules")) return undefined;
  return repositoryRelative;
}

async function normalizedRecords(result) {
  const records = [];
  for (const path of result.lcovFiles) {
    let source;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const record of parseLcov(source)) {
      const file = canonicalSource(record.file, result.group);
      if (file) records.push(record.text.replace(/^SF:.*$/m, `SF:${file}`));
    }
  }
  return records;
}

async function writeGroupReport(result) {
  const records = await normalizedRecords(result);
  if (records.length === 0) return undefined;
  const directory = join(coverageDirectory, "groups", safeName(result.group.name));
  const input = join(directory, ".node.lcov");
  await mkdir(directory, { recursive: true });
  await writeFile(input, records.join(""));
  const summary = await writeCoverageSummary({
    input,
    jsonOutput: join(directory, "summary.json"),
    lcovOutput: join(directory, "lcov.info"),
    metadata: {
      base_sha: baseSha,
      generated_at: generatedAt,
      group: result.group.name,
      mode: coverageMode,
      plan_digest: result.group.plan.digest,
      planned: result.group.entries.length,
      profile: profileName,
      source_sha: sourceSha,
    },
  });
  return { files: summary.files, name: result.group.name, totals: summary.totals };
}

await mkdir(coverageDirectory, { recursive: true });
await rm(join(coverageDirectory, "groups"), { recursive: true, force: true });
await rm(partsDirectory, { recursive: true, force: true });
await mkdir(partsDirectory, { recursive: true });

const availableGroups = nodeGroups(root);
const availableNames = new Set(availableGroups.map((group) => group.name));
const unknownGroups = requestedGroupNames.filter((name) => !availableNames.has(name));
if (unknownGroups.length > 0) throw new Error(`Unknown coverage groups: ${unknownGroups.join(", ")}`);
const selectedNames = new Set(requestedGroupNames);
const requested = requestedGroupNames.length > 0
  ? availableGroups.filter((group) => selectedNames.has(group.name))
  : availableGroups;
if (requested.length === 0) throw new Error("No coverage group matched the request");

// One collection, one plan: the groups below are that plan cut by directory,
// not several plans that happen to share a selector.
const plan = planFor(collect({
  root,
  files: requested.flatMap((group) => group.files).sort(),
  outputDir: join(partsDirectory, "collect"),
  nodeImports: ["tsx"],
}), { root, profileName });
const planned = entriesByGroup(plan);
const groups = requested
  .filter((group) => planned.has(group.name))
  .map((group) => ({ ...group, entries: planned.get(group.name), plan }));
const empty = requested.filter((group) => !planned.has(group.name)).map((group) => group.name);
if (empty.length > 0) console.log(`[coverage] no planned identity in: ${empty.join(", ")}`);
if (groups.length === 0) throw new Error("The shared plan selects no test in the requested groups");

const units = groups.flatMap((group) => {
  const byFile = new Map();
  for (const entry of group.entries) byFile.set(entry.source, [...(byFile.get(entry.source) ?? []), entry]);
  console.log(`[coverage] ${group.name}: ${group.entries.length} planned identit${group.entries.length === 1 ? "y" : "ies"} in ${byFile.size} file(s)`);
  return [...byFile].map(([file, entries], index) => ({ group, file, entries, index }));
});

const identityCount = groups.reduce((total, group) => total + group.entries.length, 0);
console.log(`Collecting Node coverage from ${identityCount} planned identities in ${units.length} isolated runs across ${groups.length} groups (maximum ${groupConcurrency} at once).`);
console.log(`plan profile=${profileName}; selector=${plan.selector}; targets=${plan.targets.map((target) => `${target.os}/${target.arch}`).join(" ")}; digest=${plan.digest}`);
const outcomes = await runBounded(units);
const results = await Promise.all(groups.map((group) => collectGroup(group, outcomes)));
const failed = results.filter((result) => result.code !== 0);
for (const result of failed) {
  console.error(`[coverage] ${result.group.name} failed: ${result.summary.problems.slice(0, 5).join("; ")}`);
}

const groupReports = (await Promise.all(results.map(writeGroupReport))).filter(Boolean);
const records = (await Promise.all(results.map(normalizedRecords))).flat();
if (records.length === 0 || groupReports.length === 0) throw new Error("Node did not produce any in-scope LCOV records");
await writeFile(rawLcov, records.join(""));

try {
  await writeCoverageSummary({
    input: rawLcov,
    jsonOutput: join(coverageDirectory, "summary.json"),
    lcovOutput: join(coverageDirectory, "lcov.info"),
    metadata: {
      authoritative: coverageMode === "full",
      base_sha: baseSha,
      generated_at: generatedAt,
      groups: groupReports,
      mode: coverageMode,
      plan_digest: plan.digest,
      plan_selector: plan.selector,
      planned: identityCount,
      profile: profileName,
      selected_groups: groups.map((group) => group.name),
      source_sha: sourceSha,
    },
  });
  console.log(`Coverage reports written to ${coverageDirectory}`);
} catch (error) {
  console.error(`Coverage report could not be finalized: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  throw error;
}

await rm(partsDirectory, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
