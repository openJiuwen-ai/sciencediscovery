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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
    utGuestPackages: structuredClone(catalog.utGuestPackages),
    utWorkloads: structuredClone(catalog.utWorkloads),
  };
}

function utCase(copy, id) {
  const found = copy.testCases.find((testCase) => testCase.id === id);
  assert.ok(found, `${id} is missing from the catalog`);
  return found;
}

test("the checked-in catalog satisfies the whole CI contract", async () => {
  await assertCiContract();
});

test("UT is exactly two tiers and every UT case carries one of them", () => {
  const utCases = catalog.testCases.filter((testCase) => testCase.tags.includes("layer:ut"));
  assert.deepEqual(
    utCases.map((testCase) => testCase.id).sort(),
    ["ut.guest", "ut.host"],
  );
  for (const testCase of utCases) {
    const tiers = testCase.tags.filter((tag) => tag.startsWith("ut:"));
    assert.equal(tiers.length, 1, `${testCase.id} must carry exactly one ut:* tag`);
  }
  for (const testCase of catalog.testCases.filter((candidate) => !candidate.tags.includes("layer:ut"))) {
    assert.equal(testCase.tags.filter((tag) => tag.startsWith("ut:")).length, 0);
  }
});

test("a UT case without a tier tag is rejected", () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.host");
  target.tags = target.tags.filter((tag) => tag !== "ut:host");
  assert.match(catalogProblems(copy).join("\n"), /ut\.host: expected exactly one ut:\* tag, found 0/);
});

test("a UT case in both tiers is rejected", () => {
  const copy = mutableCatalog();
  utCase(copy, "ut.host").tags.push("ut:guest");
  assert.match(catalogProblems(copy).join("\n"), /ut\.host: expected exactly one ut:\* tag, found 2/);
});

test("an unknown tier value is rejected", () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.host");
  target.tags = target.tags.map((tag) => (tag === "ut:host" ? "ut:unclassified" : tag));
  assert.match(catalogProblems(copy).join("\n"), /ut\.host: unknown tag ut:unclassified/);
});

test("a non-UT case may not claim a UT tier", () => {
  const copy = mutableCatalog();
  utCase(copy, "e2e.mocked").tags.push("ut:guest");
  assert.match(catalogProblems(copy).join("\n"), /e2e\.mocked: ut:\* is only for layer:ut cases, found 1/);
});

test("a tier whose sandbox requirement disagrees with it is rejected", async () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.guest");
  target.tags = target.tags.map((tag) => (tag === "sandbox:bubblewrap" ? "sandbox:none" : tag));
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /ut\.guest: ut:guest requires sandbox:bubblewrap/);
});

test("the two tiers cover every workspace package that has tests, and none twice", async () => {
  const projects = await workspaceProjects();
  const testable = projects.filter((project) => project.hasTestScript).map((project) => project.name);
  const guest = catalog.utGuestPackages.map(({ name }) => name);
  const host = testable.filter((name) => !guest.includes(name));
  assert.ok(testable.length > guest.length, "the host tier must own at least one package");
  assert.deepEqual([...host, ...guest].sort(), [...testable].sort());
  assert.deepEqual(host.filter((name) => guest.includes(name)), []);
});

test("a guest package that is not a workspace project is rejected", async () => {
  const copy = mutableCatalog();
  copy.utGuestPackages = [{ directory: "services/ghost", name: "@sciencediscovery/ghost" }];
  copy.utWorkloads = copy.utWorkloads.map((workload) => {
    if (workload.id === "sandbox-packages") return { ...workload, command: ["pnpm", "--filter", "@sciencediscovery/ghost", "test"] };
    if (workload.id === "workspace-packages") return { ...workload, command: ["pnpm", "--recursive", "--filter", "!@sciencediscovery/ghost", "test"] };
    return workload;
  });
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /UT guest package @sciencediscovery\/ghost is not a workspace project/);
  assert.match(problems.join("\n"), /the guest tier selects @sciencediscovery\/ghost, which is not a workspace project/);
});

test("a hand-edited package filter that orphans a package is rejected", async () => {
  const copy = mutableCatalog();
  copy.utWorkloads = copy.utWorkloads.map((workload) => (workload.id === "workspace-packages"
    ? { ...workload, command: ["pnpm", "--recursive", "--filter", "!@sciencediscovery/runner", "--filter", "!@sciencediscovery/api", "test"] }
    : workload));
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /@sciencediscovery\/api has tests but belongs to neither UT tier/);
  assert.match(problems.join("\n"), /UT workload workspace-packages runs /);
});

test("a package claimed by both tiers is rejected", async () => {
  const copy = mutableCatalog();
  copy.utWorkloads = copy.utWorkloads.map((workload) => (workload.id === "workspace-packages"
    ? { ...workload, command: ["pnpm", "--recursive", "test"] }
    : workload));
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /@sciencediscovery\/runner has tests and is claimed by both UT tiers/);
});

test("the ut aggregate is exactly the host tier followed by the guest tier", async () => {
  assert.deepEqual(catalog.layers.ut, [...catalog.layers["ut-host"], ...catalog.layers["ut-guest"]]);
  const copy = mutableCatalog();
  copy.layers.ut = copy.layers.ut.filter(([, args]) => args[0] !== "evolve:test");
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /layer ut is not exactly ut-host followed by ut-guest/);
});

test("the guest tier neither installs nor builds", async () => {
  for (const [command, args] of catalog.layers["ut-guest"]) {
    assert.ok(!(command === "pnpm" && (args[0] === "install" || args[0] === "build")), `${command} ${args.join(" ")}`);
  }
  const copy = mutableCatalog();
  copy.layers["ut-guest"] = [["pnpm", ["build"]], ...copy.layers["ut-guest"]];
  copy.layers.ut = [...copy.layers["ut-host"], ...copy.layers["ut-guest"]];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /layer ut-guest must not build/);
});

test("a third UT entry point outside the two tiers is rejected", async (t) => {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "ci-contract-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "services", "runner"), { recursive: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - services/*\n");
  await writeFile(join(root, "services", "runner", "package.json"), JSON.stringify({
    name: "@sciencediscovery/runner",
    scripts: { test: "node --test dist/*.test.js" },
  }));
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: {
      "ci:ut": "node .ci/run-layer.mjs ut",
      "ci:ut:guest": "node .ci/run-layer.mjs ut-guest",
      "ci:ut:host": "node .ci/run-layer.mjs ut-host",
      "ci:ut:macos": "pnpm build && node --test services/runner/dist/macos-seatbelt.test.js",
    },
  }));
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /script ci:ut:macos is a UT entry point outside the two tiers/);
  assert.deepEqual(problems.filter((problem) => problem.startsWith("script ci:ut") && !problem.includes("macos")), []);
});

test("no CI script restates a value ci-constants.sh owns", async () => {
  const ciDirectory = dirname(fileURLToPath(import.meta.url));
  // Take the names from the file and the values from sourcing it. Reading the
  // text alone would miss the versions, which are read from where the product
  // pins them; diffing the shell's variables instead would pick up both bash's
  // own bookkeeping and the CI_* settings the build task exports, and the
  // latter already failed a script for carrying its own default.
  const constants = await readFile(join(ciDirectory, "ci-constants.sh"), "utf8");
  const names = [
    ...constants.matchAll(/^([A-Z][A-Z0-9_]*)=/gm),
    ...constants.matchAll(/^\s*read -r ([A-Z][A-Z0-9_]*)$/gm),
  ].map(([, name]) => name);
  assert.ok(names.length >= 4, "ci-constants.sh defines nothing to check");

  const printed = spawnSync("bash", ["-c",
    `source ${JSON.stringify(join(ciDirectory, "ci-constants.sh"))}\n`
    + names.map((name) => `printf '%s=%s\\n' ${name} "\${${name}}"`).join("\n")],
  { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  const owned = [...printed.stdout.matchAll(/^([A-Z][A-Z0-9_]*)=(\S+)$/gm)]
    .map(([, name, value]) => ({ name, value }));
  assert.equal(owned.length, names.length, printed.stdout);
  assert.ok(owned.length >= 4, "ci-constants.sh defines nothing to check");

  const scripts = (await readdir(ciDirectory))
    .filter((name) => name.endsWith(".sh") && name !== "ci-constants.sh");
  const restated = [];
  for (const script of scripts) {
    const source = await readFile(join(ciDirectory, script), "utf8");
    for (const { name, value } of owned) {
      // A version like 22.19.0 is short enough to appear by accident, so the
      // check is on the exact value and the script is expected to interpolate.
      if (source.includes(value)) restated.push(`${script} spells out ${name}=${value}`);
    }
  }
  // The recipe name drifted exactly this way on the resources branch: one of
  // two copies was bumped, the image announced a generation it did not carry,
  // and both guest layers failed a preflight that printed nothing.
  assert.deepEqual(restated, []);
});
