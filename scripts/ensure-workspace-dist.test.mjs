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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const SCRIPT = new URL("./ensure-workspace-dist.mjs", import.meta.url);

// Stands in for `typescript/bin/tsc`: it records the package it was pointed at
// and writes the `dist/` the real compiler would emit, so the run stays honest
// about what the script does without paying for a TypeScript build.
const FAKE_TSC = `const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..", "..", "..");
fs.appendFileSync(path.join(root, "builds.log"), path.relative(root, process.cwd()) + "\\n");
fs.mkdirSync(path.join(process.cwd(), "dist"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "dist", "index.js"), "// built\\n");
`;

/** A throwaway workspace root with a copy of the script and the fake compiler. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "science-ensure-dist-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "scripts", "ensure-workspace-dist.mjs"), await readFile(SCRIPT));
  const bin = join(root, "node_modules", "typescript", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "tsc"), FAKE_TSC);
  return root;
}

async function addPackage(root, group, name, { dependencies = {}, prebuilt = false } = {}) {
  const dir = join(root, group, name);
  await mkdir(dir, { recursive: true });
  const manifest = { name: `@fixture/${name}`, version: "0.0.0", dependencies };
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, "tsconfig.json"), "{}\n");
  if (prebuilt) {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "index.js"), "// prebuilt\n");
  }
  return dir;
}

function run(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "ensure-workspace-dist.mjs"), "apps/web"], {
    cwd: root,
    encoding: "utf8",
  });
}

/** Package directories the fake compiler was invoked for, in invocation order. */
async function builds(root) {
  try {
    return (await readFile(join(root, "builds.log"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("ensure-workspace-dist builds the packages without dist/ and skips the ones already built", async (t) => {
  const root = await fixture(t);
  await addPackage(root, "packages", "fresh");
  await addPackage(root, "packages", "prebuilt", { prebuilt: true });
  await addPackage(root, "apps", "web", {
    dependencies: { "@fixture/fresh": "workspace:*", "@fixture/prebuilt": "workspace:*" },
  });

  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(await builds(root), [join("packages", "fresh")], "only the package without dist/ is built");
  assert.match(first.stdout, /built workspace packages without dist: @fixture\/fresh$/m);
  assert.equal(await readFile(join(root, "packages", "prebuilt", "dist", "index.js"), "utf8"), "// prebuilt\n");

  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await builds(root), [join("packages", "fresh")], "a second run must not rebuild a built package");
  assert.equal(second.stdout, "", "a run with nothing missing says nothing");
});

test("ensure-workspace-dist builds a dependency before the package that imports it", async (t) => {
  const root = await fixture(t);
  await addPackage(root, "packages", "leaf");
  await addPackage(root, "packages", "middle", { dependencies: { "@fixture/leaf": "workspace:*" } });
  await addPackage(root, "packages", "top", { dependencies: { "@fixture/middle": "workspace:*" } });
  await addPackage(root, "packages", "sibling");
  await addPackage(root, "apps", "web", {
    dependencies: { "@fixture/top": "workspace:*", "@fixture/sibling": "workspace:*" },
  });

  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await builds(root), [
    join("packages", "leaf"),
    join("packages", "middle"),
    join("packages", "top"),
    join("packages", "sibling"),
  ], "a package is built only after everything it depends on");
});
