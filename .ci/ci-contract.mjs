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

/**
 * The guard behind `pnpm ci:catalog:check`. It fails closed on a missing or
 * unknown tag, and on any way the two UT tiers could stop covering every UT
 * case exactly once: an unclassified entry point, a workspace package claimed
 * by both tiers or by neither, an aggregate that no longer equals the sum of
 * the tiers, or a guest tier that has started installing or building again.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as defaultCatalog from "./test-catalog.mjs";

export const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const utEntryPoints = {
  "ci:ut": "ut",
  "ci:ut:guest": "ut-guest",
  "ci:ut:host": "ut-host",
};
const utTiers = ["host", "guest"];

export function knownTags(catalog = defaultCatalog) {
  return new Set(Object.entries(catalog.tagDimensions).flatMap(([dimension, definition]) =>
    Object.keys(definition.values).map((value) => `${dimension}:${value}`)));
}

function tagsOfDimension(tags, dimension) {
  return [...tags].filter((tag) => tag.startsWith(`${dimension}:`));
}

export function catalogProblems(catalog = defaultCatalog) {
  const { tagDimensions, testCases } = catalog;
  const problems = [];
  const ids = new Set();
  const resultPaths = new Set();
  const allowedTags = knownTags(catalog);
  for (const testCase of testCases) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(testCase.id)) problems.push(`${testCase.id}: invalid id`);
    if (ids.has(testCase.id)) problems.push(`${testCase.id}: duplicate id`);
    ids.add(testCase.id);
    if (!testCase.description?.trim()) problems.push(`${testCase.id}: missing description`);
    if (!testCase.resultPath?.trim()) problems.push(`${testCase.id}: missing resultPath`);
    if (resultPaths.has(testCase.resultPath)) problems.push(`${testCase.id}: duplicate resultPath ${testCase.resultPath}`);
    resultPaths.add(testCase.resultPath);
    if (testCase.runnable === false) {
      if (!testCase.unsupportedReason?.trim()) problems.push(`${testCase.id}: unsupported case needs a reason`);
    } else if (!Array.isArray(testCase.command) || testCase.command.length === 0 || testCase.command.some((part) => typeof part !== "string" || !part)) {
      problems.push(`${testCase.id}: runnable case needs a non-empty argv command`);
    }
    if (!Array.isArray(testCase.tags)) {
      problems.push(`${testCase.id}: tags must be an array`);
      continue;
    }
    const tags = new Set(testCase.tags);
    if (tags.size !== testCase.tags.length) problems.push(`${testCase.id}: duplicate tags`);
    for (const tag of tags) if (!allowedTags.has(tag)) problems.push(`${testCase.id}: unknown tag ${tag}`);
    for (const [dimension, definition] of Object.entries(tagDimensions)) {
      const count = tagsOfDimension(tags, dimension).length;
      // A scoped dimension applies to the cases carrying its scope tag and to
      // no others, so a case cannot dodge it or claim it from another layer.
      if (definition.scope && !tags.has(definition.scope)) {
        if (count !== 0) problems.push(`${testCase.id}: ${dimension}:* is only for ${definition.scope} cases, found ${count}`);
        continue;
      }
      const multiple = definition.multiple === true;
      if (count === 0 || (!multiple && count !== 1)) {
        problems.push(`${testCase.id}: expected ${multiple ? "at least one" : "exactly one"} ${dimension}:* tag, found ${count}`);
      }
    }
  }
  return problems;
}

/** The workspace projects pnpm would run `--recursive` over, with their test scripts. */
export async function workspaceProjects(repositoryRoot = defaultRepositoryRoot) {
  const manifest = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const patterns = [];
  let insidePackages = false;
  for (const line of manifest.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      insidePackages = true;
      continue;
    }
    if (!insidePackages) continue;
    const entry = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (entry) patterns.push(entry[1].replace(/^['"]|['"]$/g, ""));
    else if (line.trim() !== "") insidePackages = false;
  }
  const directories = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      directories.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const entries = await readdir(join(repositoryRoot, parent), { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
  }
  const projects = [];
  for (const directory of directories.sort()) {
    let manifestText;
    try {
      manifestText = await readFile(join(repositoryRoot, directory, "package.json"), "utf8");
    } catch {
      continue;
    }
    const parsed = JSON.parse(manifestText);
    projects.push({ directory, hasTestScript: Boolean(parsed.scripts?.test), name: parsed.name });
  }
  return projects;
}

async function repositoryScripts(repositoryRoot) {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  return manifest.scripts ?? {};
}

function stepsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Everything that keeps UT a two-tier partition. Kept separate from the tag
 * checks above because it reads the workspace and the repository scripts.
 */
export async function utContractProblems(catalog = defaultCatalog, repositoryRoot = defaultRepositoryRoot) {
  const { layers, testCases, utGuestPackages, utWorkloads } = catalog;
  const problems = [];

  const workloadIds = new Set();
  for (const workload of utWorkloads) {
    if (!utTiers.includes(workload.tier)) problems.push(`UT workload ${workload.id}: unknown tier ${workload.tier}`);
    if (workloadIds.has(workload.id)) problems.push(`UT workload ${workload.id}: duplicate id`);
    workloadIds.add(workload.id);
  }
  for (const tier of utTiers) {
    if (!utWorkloads.some((workload) => workload.tier === tier)) problems.push(`UT tier ${tier} has no workload`);
    const cases = testCases.filter((testCase) => testCase.tags?.includes(`ut:${tier}`));
    if (cases.length === 0) problems.push(`UT tier ${tier} has no catalog case`);
    for (const testCase of cases) {
      const requiredSandbox = tier === "guest" ? "sandbox:bubblewrap" : "sandbox:none";
      if (!testCase.tags.includes(requiredSandbox)) {
        problems.push(`${testCase.id}: ut:${tier} requires ${requiredSandbox}`);
      }
    }
  }

  // The aggregate is the sum of the tiers, in that order, and nothing else.
  if (!stepsEqual(layers.ut, [...layers["ut-host"], ...layers["ut-guest"]])) {
    problems.push("layer ut is not exactly ut-host followed by ut-guest");
  }
  for (const [command, args] of layers["ut-guest"]) {
    if (command === "pnpm" && (args[0] === "install" || args[0] === "build")) {
      problems.push(`layer ut-guest must not ${args[0]}: its host prepares the workspace`);
    }
  }

  const projects = await workspaceProjects(repositoryRoot);
  const testable = projects.filter((project) => project.hasTestScript);
  const guestNames = new Set();
  for (const guestPackage of utGuestPackages) {
    const project = projects.find((candidate) => candidate.name === guestPackage.name);
    if (!project) problems.push(`UT guest package ${guestPackage.name} is not a workspace project`);
    else if (!project.hasTestScript) problems.push(`UT guest package ${guestPackage.name} has no test script`);
    else if (project.directory !== guestPackage.directory) {
      problems.push(`UT guest package ${guestPackage.name} is at ${project.directory}, not ${guestPackage.directory}`);
    }
    if (guestNames.has(guestPackage.name)) problems.push(`UT guest package ${guestPackage.name}: duplicate entry`);
    guestNames.add(guestPackage.name);
  }
  // Read the tiers back out of the commands the layers actually run, so an
  // edited filter is measured against the workspace instead of against the
  // declaration it was supposed to follow.
  const filtersOf = (id) => {
    const command = utWorkloads.find((workload) => workload.id === id)?.command ?? [];
    return command.filter((part, index) => command[index - 1] === "--filter");
  };
  const guestSelected = new Set(filtersOf("sandbox-packages").filter((filter) => !filter.startsWith("!")));
  const hostExcluded = new Set(filtersOf("workspace-packages")
    .filter((filter) => filter.startsWith("!"))
    .map((filter) => filter.slice(1)));
  for (const project of testable) {
    const inHost = !hostExcluded.has(project.name);
    const inGuest = guestSelected.has(project.name);
    if (inHost && inGuest) problems.push(`${project.name} has tests and is claimed by both UT tiers`);
    if (!inHost && !inGuest) problems.push(`${project.name} has tests but belongs to neither UT tier`);
  }
  for (const name of guestSelected) {
    if (!testable.some((project) => project.name === name)) {
      problems.push(`the guest tier selects ${name}, which is not a workspace project with tests`);
    }
  }

  // The two package commands are generated from utGuestPackages; re-derive them
  // so a hand-edited filter cannot orphan a package.
  const expected = {
    "sandbox-packages": ["pnpm", ...[...guestNames].flatMap((name) => ["--filter", name]), "test"],
    "workspace-packages": ["pnpm", "--recursive", ...[...guestNames].flatMap((name) => ["--filter", `!${name}`]), "test"],
  };
  for (const [id, command] of Object.entries(expected)) {
    const workload = utWorkloads.find((candidate) => candidate.id === id);
    if (!workload) problems.push(`UT workload ${id} is missing`);
    else if (!stepsEqual(workload.command, command)) {
      problems.push(`UT workload ${id} runs ${workload.command.join(" ")}, expected ${command.join(" ")}`);
    }
  }

  // No UT entry point may exist outside the aggregate and the two tiers.
  const scripts = await repositoryScripts(repositoryRoot);
  const utScripts = Object.keys(scripts).filter((name) => name === "ci:ut" || name.startsWith("ci:ut:"));
  for (const name of utScripts) {
    const layer = utEntryPoints[name];
    if (!layer) {
      problems.push(`script ${name} is a UT entry point outside the two tiers; fold it into ci:ut:host or ci:ut:guest`);
      continue;
    }
    if (scripts[name] !== `node .ci/run-layer.mjs ${layer}`) {
      problems.push(`script ${name} must run node .ci/run-layer.mjs ${layer}`);
    }
  }
  for (const name of Object.keys(utEntryPoints)) {
    if (!utScripts.includes(name)) problems.push(`script ${name} is missing`);
  }
  for (const testCase of testCases.filter((candidate) => candidate.tags?.includes("layer:ut"))) {
    const [tier] = tagsOfDimension(testCase.tags, "ut").map((tag) => tag.split(":")[1]);
    const script = testCase.command?.[1];
    if (tier && utEntryPoints[script] !== `ut-${tier}`) {
      problems.push(`${testCase.id}: ut:${tier} case must run pnpm ci:ut:${tier}`);
    }
  }
  return problems;
}

export async function assertCiContract(catalog = defaultCatalog, repositoryRoot = defaultRepositoryRoot) {
  const problems = [...catalogProblems(catalog), ...(await utContractProblems(catalog, repositoryRoot))];
  if (problems.length > 0) throw new Error(`Invalid CI test catalog:\n- ${problems.join("\n- ")}`);
}
