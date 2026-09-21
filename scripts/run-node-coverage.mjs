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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parseLcov, writeCoverageSummary } from "./coverage-summary.mjs";

const root = process.cwd();
const coverageDirectory = resolve(root, "coverage");
const partsDirectory = join(coverageDirectory, ".parts");
const rawLcov = join(coverageDirectory, ".node.lcov");
const groupConcurrency = Number(process.env.COVERAGE_TEST_CONCURRENCY?.trim() || "4");
const repositoryRoots = [".ci", "apps", "config", "packages", "scripts", "services"];

if (!Number.isInteger(groupConcurrency) || groupConcurrency < 1) {
  throw new Error("COVERAGE_TEST_CONCURRENCY must be a positive integer");
}

async function collectFiles(directory, predicate) {
  const found = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(path)) found.push(path);
    }
  }
  try {
    await stat(directory);
    await visit(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return found;
    throw error;
  }
  return found;
}

async function directDirectories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function portable(path) {
  return path.replaceAll("\\", "/");
}

function safeName(path) {
  return portable(path).replaceAll("/", "-").replace(/[^a-zA-Z0-9._-]/g, "-");
}

async function testGroups() {
  const groups = [];
  for (const path of [".ci", "scripts"]) {
    const sourceDirectory = resolve(root, path);
    const files = await collectFiles(sourceDirectory, (file) => file.endsWith(".test.mjs"));
    if (files.length > 0) groups.push({ name: path, directory: root, root: path, files });
  }

  const workspaceDirectories = [
    resolve(root, "config"),
    ...await directDirectories(resolve(root, "apps")),
    ...await directDirectories(resolve(root, "packages")),
    ...await directDirectories(resolve(root, "services")),
  ];
  for (const directory of workspaceDirectories) {
    try {
      await stat(join(directory, "package.json"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const files = await collectFiles(directory, (file) => {
      const path = portable(relative(directory, file));
      return path.endsWith(".test.mjs") || path.startsWith("dist/") && path.endsWith(".test.js");
    });
    if (files.length === 0) continue;
    const groupRoot = portable(relative(root, directory));
    groups.push({ name: groupRoot, directory, root: groupRoot, files });
  }
  return groups.sort((left, right) => left.name.localeCompare(right.name));
}

function runGroup(group) {
  const lcov = join(partsDirectory, `${safeName(group.name)}.lcov`);
  const files = group.files.map((file) => relative(group.directory, file));
  console.log(`[coverage] ${group.name}: ${files.length} test file(s)`);
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-test-coverage",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      "--test-reporter=lcov",
      "--test-reporter-destination=stdout",
      `--test-reporter-destination=${lcov}`,
      ...files,
    ], { cwd: group.directory, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({
      code: code ?? (signal ? 128 : 1),
      group,
      lcov,
    }));
  });
}

async function runBounded(groups) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < groups.length) {
      const index = next;
      next += 1;
      results[index] = await runGroup(groups[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(groupConcurrency, groups.length) }, worker));
  return results;
}

function canonicalSource(file, group) {
  const normalized = portable(file);
  const isRepositoryRelative = repositoryRoots.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  const absolute = isAbsolute(file)
    ? resolve(file)
    : resolve(isRepositoryRelative ? root : group.directory, file);
  const repositoryRelative = portable(relative(root, absolute));
  if (repositoryRelative === ".." || repositoryRelative.startsWith("../")) return undefined;
  if (repositoryRelative !== group.root && !repositoryRelative.startsWith(`${group.root}/`)) return undefined;
  return repositoryRelative;
}

async function normalizedRecords(result) {
  let source;
  try {
    source = await readFile(result.lcov, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return parseLcov(source).flatMap((record) => {
    const file = canonicalSource(record.file, result.group);
    if (!file) return [];
    return record.text.replace(/^SF:.*$/m, `SF:${file}`);
  });
}

await mkdir(coverageDirectory, { recursive: true });
await rm(partsDirectory, { recursive: true, force: true });
await mkdir(partsDirectory, { recursive: true });

const groups = await testGroups();
if (groups.length === 0) throw new Error("No built Node test files were found; run pnpm build before collecting coverage");

const testFileCount = groups.reduce((total, group) => total + group.files.length, 0);
console.log(`Collecting Node coverage from ${testFileCount} test files in ${groups.length} isolated groups (maximum ${groupConcurrency} at once).`);
const results = await runBounded(groups);
const failed = results.filter((result) => result.code !== 0);
for (const result of failed) console.error(`[coverage] ${result.group.name} failed with exit code ${result.code}`);

const records = (await Promise.all(results.map(normalizedRecords))).flat();
if (records.length === 0) throw new Error("Node did not produce any in-scope LCOV records");
await writeFile(rawLcov, records.join(""));

try {
  await writeCoverageSummary({
    input: rawLcov,
    jsonOutput: join(coverageDirectory, "summary.json"),
    lcovOutput: join(coverageDirectory, "lcov.info"),
    markdownOutput: join(coverageDirectory, "summary.md"),
  });
  console.log(`Coverage reports written to ${coverageDirectory}`);
} catch (error) {
  console.error(`Coverage report could not be finalized: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  throw error;
}

process.exitCode = failed.length === 0 ? 0 : 1;
