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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const pythonCoverageGroups = [
  "services/evolve",
  "services/gateway",
  "services/memory-graph",
  "services/paper",
];

const globalCoverageFiles = new Set([
  ".github/workflows/ci.yml",
  "package.json",
  "scripts/coverage-job-summary.mjs",
  "scripts/coverage-job-summary.test.mjs",
  "scripts/python-coverage-summary.mjs",
  "scripts/python-coverage-summary.test.mjs",
  "scripts/run-python-coverage.mjs",
  "scripts/select-python-coverage-groups.mjs",
  "scripts/select-python-coverage-groups.test.mjs",
]);

function portable(path) {
  return path.replaceAll("\\", "/");
}

export function selectPythonCoverageGroups({ paths, allGroups = pythonCoverageGroups }) {
  const normalized = paths.map(portable).filter(Boolean);
  if (normalized.some((path) => globalCoverageFiles.has(path))) {
    return {
      groups: [],
      mode: "full",
      reason: "Python coverage infrastructure changed",
      skip: false,
    };
  }

  const groups = allGroups.filter((group) => normalized.some(
    (path) => path === group || path.startsWith(`${group}/`),
  ));
  return {
    groups,
    mode: "incremental",
    reason: groups.length > 0 ? "changed Python services" : "no covered Python service changed",
    skip: groups.length === 0,
  };
}

async function main() {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base) throw new Error("usage: node scripts/select-python-coverage-groups.mjs <base-sha> [head-sha]");
  const paths = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).split(/\r?\n/).filter(Boolean);
  const selection = selectPythonCoverageGroups({ paths });
  console.log(`mode=${selection.mode}`);
  console.log(`groups=${selection.groups.join(",")}`);
  console.log(`skip=${selection.skip}`);
  console.log(`reason=${selection.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
