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

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const globalCoverageFiles = new Set([
  ".github/workflows/ci.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/coverage-summary.mjs",
  "scripts/coverage-summary.test.mjs",
  "scripts/coverage-job-summary.mjs",
  "scripts/coverage-job-summary.test.mjs",
  "scripts/run-node-coverage.mjs",
  "scripts/select-coverage-groups.mjs",
  "scripts/select-coverage-groups.test.mjs",
]);

function portable(path) {
  return path.replaceAll("\\", "/");
}

function workspaceRoot(path) {
  const parts = portable(path).split("/");
  if (parts[0] === "config") return "config";
  if (["apps", "packages", "services"].includes(parts[0]) && parts[1]) return `${parts[0]}/${parts[1]}`;
  return undefined;
}

export function selectCoverageGroups({ paths, allGroups, packageByRoot, reverseDependencies }) {
  const normalized = paths.map(portable).filter(Boolean);
  if (normalized.some((path) => globalCoverageFiles.has(path) || /^tsconfig(?:\.|$)/.test(path))) {
    return { groups: [], mode: "full", reason: "coverage infrastructure or shared build configuration changed", skip: false };
  }

  const selected = new Set();
  const changedPackages = [];
  for (const path of normalized) {
    if (path.startsWith(".ci/")) selected.add(".ci");
    else if (path.startsWith("scripts/")) selected.add("scripts");
    const workspace = workspaceRoot(path);
    if (!workspace) continue;
    if (allGroups.includes(workspace)) selected.add(workspace);
    const packageName = packageByRoot.get(workspace);
    if (packageName) changedPackages.push(packageName);
  }

  const queue = [...changedPackages];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const packageName = queue.shift();
    for (const dependent of reverseDependencies.get(packageName) || []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  for (const [workspace, packageName] of packageByRoot) {
    if (seen.has(packageName) && allGroups.includes(workspace)) selected.add(workspace);
  }

  const groups = [...selected].sort();
  return {
    groups,
    mode: "incremental",
    reason: groups.length > 0 ? "changed workspaces and their Node-test dependents" : "no covered Node group changed",
    skip: groups.length === 0,
  };
}

async function workspaceDirectories() {
  const directories = [resolve(root, "config")];
  for (const parent of ["apps", "packages", "services"]) {
    const parentPath = resolve(root, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(join(parentPath, entry.name));
    }
  }
  return directories;
}

async function workspaceGraph() {
  const allGroups = [".ci", "scripts"];
  const packageByRoot = new Map();
  const dependencies = new Map();
  for (const directory of await workspaceDirectories()) {
    let doc;
    try {
      doc = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const workspace = portable(relative(root, directory));
    if (doc.name) packageByRoot.set(workspace, doc.name);
    const test = doc.scripts?.test || "";
    if (/\bnode\s+--test\b/.test(test)) allGroups.push(workspace);
    dependencies.set(doc.name, new Set(Object.keys({
      ...doc.dependencies,
      ...doc.devDependencies,
      ...doc.optionalDependencies,
      ...doc.peerDependencies,
    })));
  }
  const reverseDependencies = new Map();
  for (const [dependent, names] of dependencies) {
    for (const name of names) {
      if (!dependencies.has(name)) continue;
      if (!reverseDependencies.has(name)) reverseDependencies.set(name, new Set());
      reverseDependencies.get(name).add(dependent);
    }
  }
  return { allGroups: allGroups.sort(), packageByRoot, reverseDependencies };
}

async function main() {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) throw new Error("usage: node scripts/select-coverage-groups.mjs <base-sha> [head-sha]");
  const paths = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/).filter(Boolean);
  const selection = selectCoverageGroups({ paths, ...await workspaceGraph() });
  console.log(`mode=${selection.mode}`);
  console.log(`groups=${selection.groups.join(",")}`);
  console.log(`skip=${selection.skip}`);
  console.log(`reason=${selection.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
