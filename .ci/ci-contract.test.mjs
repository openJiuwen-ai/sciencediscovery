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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64", "npu:none", "model:none", "judge:none", "status:reviewed"] });
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


import {
  assertCiContract,
  catalogProblems,
  utContractProblems,
  workspaceProjects,
} from "./ci-contract.mjs";
import * as catalog from "./test-catalog.mjs";

// Repository-local, like the other script tests, so a fixture never lands
// outside the checkout CI cleans up.
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "ci-script-tests");

/** A structured clone of the real catalog that a test can then break. */
function mutableCatalog() {
  return {
    layers: structuredClone(catalog.layers),
    tagDimensions: structuredClone(catalog.tagDimensions),
    testCases: structuredClone(catalog.testCases),
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
  assert.deepEqual(catalog.layers.ut, [["node", ["test/support/tagged/shared.mjs", "run", "--slice", "ut"]]]);
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
