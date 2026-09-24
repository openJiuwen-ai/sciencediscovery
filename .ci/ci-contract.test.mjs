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

import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


import {
  assertCiContract,
  catalogProblems,
  defaultRepositoryRoot,
  utContractProblems,
  workspaceProjects,
} from "./ci-contract.mjs";
import * as catalog from "./test-catalog.mjs";
import { resultsLabel } from "../test/support/tagged/shared.mjs";

// Repository-local, like the other script tests, so a fixture never lands
// outside the checkout CI cleans up.
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "ci-script-tests");

/** A structured clone of the real catalog that a test can then break. */
function mutableCatalog() {
  return {
    layers: structuredClone(catalog.layers),
    tagDimensions: structuredClone(catalog.tagDimensions),
    testCases: structuredClone(catalog.testCases),
    jiuwenSwarmWrapper: [...catalog.jiuwenSwarmWrapper],
  };
}

function utCase(copy, id) {
  const found = copy.testCases.find((testCase) => testCase.id === id);
  assert.ok(found, `${id} is missing from the catalog`);
  return found;
}

/** A workspace whose one package's tests sit where the caller puts them. */
async function workspaceFixture(t, testFiles) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "ci-contract-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - services/*\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: {
      "ci:e2e": "node test/support/tagged/shared.mjs run --slice e2e",
      "ci:st": "node .ci/run-layer.mjs st",
      "ci:ut": "node .ci/run-layer.mjs ut",
    },
  }));
  await mkdir(join(root, "services", "runner"), { recursive: true });
  await writeFile(join(root, "services", "runner", "package.json"),
    JSON.stringify({ name: "@sciencediscovery/runner", scripts: { test: "node --test" } }));
  for (const name of testFiles) await writeFile(join(root, "services", "runner", name), "// a test\n");
  return root;
}


test("the checked-in catalog satisfies the whole CI contract", async () => {
  await assertCiContract();
});

test("UT is one layer case and it runs the UT slice", () => {
  const utCases = catalog.testCases.filter((testCase) => testCase.tags.includes("layer:ut"));
  assert.deepEqual(utCases.map((testCase) => testCase.id), ["ut.all"]);
  assert.deepEqual(utCases[0].command, ["pnpm", "ci:ut"]);
  // Agent turns in the UT slice run on JiuwenSwarm; the wrapper starts it and selects nothing.
  assert.deepEqual(catalog.layers.ut,
    [["bash", ["scripts/with-jiuwenswarm.sh", "node", "test/support/tagged/shared.mjs", "run", "--slice", "ut"]]]);
});

test("a layer:ut case that runs something other than ci:ut is rejected", async () => {
  const copy = mutableCatalog();
  utCase(copy, "ut.all").command = ["pnpm", "ci:ut:host"];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /ut\.all: a layer:ut case must run pnpm ci:ut/);
});

test("an unknown tag value in the scheduler catalog is rejected", () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.all");
  target.tags = target.tags.map((tag) => (tag === "layer:ut" ? "layer:unclassified" : tag));
  assert.match(catalogProblems(copy).join("\n"), /ut\.all: unknown tag layer:unclassified/);
});

test("a case missing a required dimension is rejected", () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.all");
  target.tags = target.tags.filter((tag) => !tag.startsWith("sandbox:"));
  assert.match(catalogProblems(copy).join("\n"), /ut\.all: expected exactly one sandbox:\* tag, found 0/);
});

test("a layer that runs something other than a slice of the shared plan is rejected", async () => {
  const copy = mutableCatalog();
  copy.layers.ut = [["pnpm", ["--recursive", "test"]]];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /layer ut runs pnpm --recursive test, which is not a slice of the shared plan/);
});

test("the JiuwenSwarm wrapper may start the backend but may not replace the shared runner", async () => {
  const copy = mutableCatalog();
  copy.layers.ut = [["bash", ["scripts/with-jiuwenswarm.sh", "pnpm", "--recursive", "test"]]];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /layer ut runs bash scripts\/with-jiuwenswarm\.sh pnpm --recursive test, which is not a slice of the shared plan/);
  copy.layers.ut = [["bash", ["scripts/some-other-wrapper.sh", "node", "test/support/tagged/shared.mjs", "run", "--slice", "ut"]]];
  assert.match((await utContractProblems(copy)).join("\n"), /some-other-wrapper\.sh .* is not a slice of the shared plan/);
});

test("a package test file outside the collection scope is rejected", async (t) => {
  // `services/runner/src/**/*.test.ts` is collected; a sibling directory is not.
  const root = await workspaceFixture(t, ["stray.test.mjs"]);
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /services\/runner\/stray\.test\.mjs is outside the shared runner's collection scope/);
});

test("a package with a test script and no test file is rejected", async (t) => {
  const root = await workspaceFixture(t, []);
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /@sciencediscovery\/runner has a test script but no test file/);
});

test("a second UT entry point is rejected", async (t) => {
  const root = await workspaceFixture(t, []);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.scripts["ci:ut:macos"] = "pnpm build && node --test services/runner/dist/macos-seatbelt.test.js";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /script ci:ut:macos is a second UT entry point/);
});

test("an entry point that drifts off the shared runner is rejected", async (t) => {
  const root = await workspaceFixture(t, []);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.scripts["ci:e2e"] = "bash .ci/run-e2e.sh";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /script ci:e2e must run node test\/support\/tagged\/shared\.mjs run --slice e2e/);
});

test("an entry point's arguments reach the shared runner, also behind the JiuwenSwarm wrapper", () => {
  const forwarded = ["--", "--profile", "daily", "--coverage"];
  const [ut] = catalog.layers.ut;
  // The wrapper starts the backend; the planner's flags still have to arrive,
  // or a nightly would quietly run the merge-gate profile without coverage.
  assert.deepEqual(catalog.stepArguments(ut, forwarded).slice(-4), forwarded);
  assert.deepEqual(catalog.stepArguments(["node", ["test/support/tagged/shared.mjs", "run", "--slice", "st"]], forwarded).slice(-4), forwarded);
  // A step that is not the planner gets none of them.
  assert.deepEqual(catalog.stepArguments(["pnpm", ["install", "--frozen-lockfile"]], forwarded), ["install", "--frozen-lockfile"]);
});

/**
 * The actions/upload-artifact steps of a workflow: each step's name, the paths
 * it uploads and excludes, and whether it asks for hidden files. Read as text,
 * since the steps are regular and nothing here parses YAML.
 */
function artifactUploads(workflow) {
  return workflow.split(/\n(?= *- )/).filter((step) => /uses: actions\/upload-artifact@/.test(step)).map((step) => {
    const lines = step.split("\n");
    const at = lines.findIndex((line) => /^\s*path:/.test(line));
    const inline = lines[at].replace(/^\s*path:\s*/, "").trim();
    const block = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.trim() || line.search(/\S/) <= lines[at].search(/\S/)) break;
      block.push(line.trim());
    }
    const listed = inline === "|" ? block : [inline];
    return {
      name: step.match(/- name:\s*(.+)/)?.[1] ?? "(unnamed)",
      paths: listed.filter((path) => !path.startsWith("!")),
      excluded: listed.filter((path) => path.startsWith("!")).map((path) => path.slice(1)),
      hidden: /^\s*include-hidden-files:\s*true\s*$/m.test(step),
    };
  });
}

/** The text of each job of a workflow, by job id. */
function workflowJobs(workflow) {
  const body = workflow.slice(workflow.search(/^jobs:\s*$/m));
  return Object.fromEntries(body.split(/\n(?= {2}[\w-]+:\s*$)/m).slice(1).map((job) => [job.match(/^ {2}([\w-]+):/)[1], job]));
}

const throughDotDirectory = (upload) =>
  upload.paths.some((path) => path.split("/").some((segment) => segment.startsWith(".")));

test("every artifact upload from a dot-directory includes hidden files", async () => {
  // upload-artifact@v4 leaves out whatever is named with a leading dot, the
  // given path included: `path: .ci-results` uploads nothing and only warns.
  const directory = join(defaultRepositoryRoot, ".github", "workflows");
  const uploads = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".yml"))) {
    for (const upload of artifactUploads(await readFile(join(directory, file), "utf8"))) uploads.push({ file, ...upload });
  }
  const fromDotDirectories = uploads.filter(throughDotDirectory);
  assert.deepEqual(fromDotDirectories.filter((upload) => !upload.hidden).map((upload) => `${upload.file}: ${upload.name}`), []);
  // Not vacuous: the layers' results are among the uploads it checked.
  for (const name of ["Upload UT results", "Upload ST results", "Upload E2E results"]) {
    assert.ok(fromDotDirectories.some((upload) => upload.name === name), `${name} was not found`);
  }
  // And it catches the step as it was.
  const [before] = artifactUploads(
    "      - name: Upload E2E results\n        uses: actions/upload-artifact@v4\n        with:\n          name: e2e-results\n          path: .ci-results\n          if-no-files-found: warn\n",
  );
  assert.ok(throughDotDirectory(before) && !before.hidden);
});

test("each layer uploads the coverage its run wrote, whichever profile ran it", async () => {
  // Nightly runs the gate with `profile: daily`. The runner used to put that
  // run under `daily-ut/`, the fixed `ut/` upload found nothing, and the
  // Coverage job failed on artifacts that were never uploaded. Every profile
  // now writes to the slice's own directory and records itself in plan.json.
  const ci = await readFile(join(defaultRepositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const jobs = workflowJobs(ci);
  for (const layer of ["ut", "st"]) {
    const uploads = artifactUploads(jobs[layer]);
    const coverage = uploads.find((upload) => upload.name === `Upload ${layer.toUpperCase()} coverage data`);
    const results = uploads.find((upload) => upload.name === `Upload ${layer.toUpperCase()} results`);
    assert.ok(coverage && results, `${layer}: upload steps not found`);
    const written = `.ci-results/${resultsLabel(layer)}/tagged/coverage`;
    assert.deepEqual(coverage.paths, [written]);
    // The results artifact leaves out the same directory, which the coverage artifact carries.
    assert.deepEqual(results.excluded, [written]);
  }
  // The directory does not depend on the profile: the runner takes none.
  assert.equal(resultsLabel.length, 1);
});
