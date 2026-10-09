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
 * unknown tag in the scheduler's own catalog, and on the two ways coverage
 * could leave CI without anyone noticing: a layer running something that is
 * not a slice of the shared plan — the hand-maintained list of cases that tags
 * replaced — and a package's test file sitting outside the collection patterns
 * that plan is built from, which would simply never be collected.
 */

import { globSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeSources } from "../test/support/tagged/profiles.mjs";
import * as defaultCatalog from "./test-catalog.mjs";

export const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const layerEntryPoints = {
  "ci:e2e": "node test/support/tagged/shared.mjs run --slice e2e",
  "ci:st": "node .ci/run-layer.mjs st",
  "ci:ut": "node .ci/run-layer.mjs ut",
};

/**
 * The one runner every hermetic layer calls. `st-real` and `st-npu` are the
 * explicitly opt-in live layers and drive their own scripts; everything the
 * merge gate runs is a slice of the shared plan and nothing else, which is
 * what stops a second, hand-written list of cases from coming back.
 */
const sharedRunner = "test/support/tagged/shared.mjs";
const optInLayers = new Set(["st-npu", "st-real"]);
const testSourcePattern = /\.test\.(?:mjs|cjs|js|jsx|ts|tsx)$/;
const skippedDirectories = new Set(["node_modules", "dist", "build", ".venv", "__pycache__"]);

/** Every test source a package actually holds, found the way `pnpm test` would reach it. */
async function testSources(directory) {
  const found = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skippedDirectories.has(entry.name)) continue;
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else if (testSourcePattern.test(entry.name)) found.push(join(path, entry.name));
    }
  }
  await walk(directory);
  return found.sort();
}

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

/**
 * Everything that keeps the layers honest once the cases themselves are tagged.
 * Kept separate from the tag checks above because it reads the workspace and
 * the repository scripts.
 */
export async function utContractProblems(catalog = defaultCatalog, repositoryRoot = defaultRepositoryRoot) {
  const { layers, testCases } = catalog;
  const problems = [];

  // A package can carry correct tags and still contribute nothing, if its tests
  // sit somewhere the shared runner's collection patterns never look. That is
  // coverage silently leaving CI, so it fails here.
  const collected = new Set(globSync([...nodeSources], { cwd: repositoryRoot })
    .map((file) => file.replaceAll("\\", "/")));
  const projects = await workspaceProjects(repositoryRoot);
  for (const project of projects.filter((candidate) => candidate.hasTestScript)) {
    const files = await testSources(join(repositoryRoot, project.directory));
    if (files.length === 0) problems.push(`${project.name} has a test script but no test file the runner could collect`);
    for (const file of files) {
      const path = relative(repositoryRoot, file).replaceAll("\\", "/");
      if (!collected.has(path)) problems.push(`${path} is outside the shared runner's collection scope, so no layer would run it`);
    }
  }

  // Every layer runs a slice of the one shared plan. Anything else here is the
  // second, hand-maintained list of cases the tags replaced. The one prefix
  // allowed in front of it is the JiuwenSwarm wrapper, which starts the agent
  // backend for the whole run and selects nothing.
  const wrapper = catalog.jiuwenSwarmWrapper ?? [];
  for (const [name, steps] of Object.entries(layers)) {
    if (optInLayers.has(name)) continue;
    for (const [command, args] of steps) {
      const full = [command, ...args];
      const wrapped = wrapper.length > 0 && wrapper.every((part, index) => full[index] === part);
      const [runner, script] = wrapped ? full.slice(wrapper.length) : full;
      if (runner !== "node" || script !== sharedRunner) {
        problems.push(`layer ${name} runs ${full.join(" ")}, which is not a slice of the shared plan`);
      }
    }
  }

  // The entry points every pipeline calls run that same selector, so a local
  // run and CI cannot end up on different sets. E2E skips the layer wrapper:
  // run-e2e.sh already owns that layer's run.log.
  const scripts = await repositoryScripts(repositoryRoot);
  for (const [name, command] of Object.entries(layerEntryPoints)) {
    if (!(name in scripts)) problems.push(`script ${name} is missing`);
    else if (scripts[name] !== command) problems.push(`script ${name} must run ${command}`);
  }
  for (const name of Object.keys(scripts)) {
    if (name.startsWith("ci:ut:")) {
      problems.push(`script ${name} is a second UT entry point; UT is one slice of the shared plan, so fold it into ci:ut`);
    }
  }
  for (const testCase of testCases.filter((candidate) => candidate.tags?.includes("layer:ut"))) {
    if (testCase.command?.[1] !== "ci:ut") problems.push(`${testCase.id}: a layer:ut case must run pnpm ci:ut`);
  }
  return problems;
}

export async function assertCiContract(catalog = defaultCatalog, repositoryRoot = defaultRepositoryRoot) {
  const problems = [...catalogProblems(catalog), ...(await utContractProblems(catalog, repositoryRoot))];
  if (problems.length > 0) throw new Error(`Invalid CI test catalog:\n- ${problems.join("\n- ")}`);
}
