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
 * The guest runs tests and nothing else, which only holds while it refuses to
 * start on a workspace its host did not prepare. These cases pin that refusal:
 * without it the guest would quietly fall back to installing and building
 * under emulation, which is the cost the split removed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ciDirectory = dirname(fileURLToPath(import.meta.url));
const script = join(ciDirectory, "run-qemu-layer.sh");
// Repository-local, like the other script tests: a fixture that reaches for
// the system temporary directory escapes the checkout CI cleans up.
const testRoot = resolve(ciDirectory, "..", ".tmp", "ci-script-tests");
// The host half needs an x86_64 Linux host before it reaches the handover
// check; elsewhere it refuses earlier and for a different reason.
const hostRunsGuests = process.platform === "linux" && process.arch === "x64";

function runScript(scriptPath, argument, environment = {}) {
  const result = spawnSync("bash", [scriptPath, ...(argument === undefined ? [] : [argument])], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

/** A repository skeleton holding only what the host half inspects. */
async function skeleton(t, present) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "qemu-layer-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, ".ci"), { recursive: true });
  await copyFile(script, join(root, ".ci", "run-qemu-layer.sh"));
  for (const path of present) await mkdir(join(root, path), { recursive: true });
  return root;
}

test("the host half names both layers it can run", () => {
  const { output, status } = runScript(script);
  assert.equal(status, 2);
  assert.match(output, /Usage: \.ci\/run-qemu-layer\.sh ut-guest\|e2e/);
});

test("an unknown layer is refused", () => {
  const { output, status } = runScript(script, "st");
  assert.equal(status, 2);
  assert.match(output, /'st' is not a layer this guest runs/);
});

test("the UT guest tier refuses a workspace its host did not build", { skip: !hostRunsGuests }, async (t) => {
  const root = await skeleton(t, ["node_modules"]);
  const { output, status } = runScript(join(root, ".ci", "run-qemu-layer.sh"), "ut-guest", {
    CI_RESULTS_DIR: join(root, "results"),
  });
  assert.equal(status, 1);
  assert.match(output, /services\/runner\/dist is missing; install and build on this host before running the ut-guest guest/);
});

test("the E2E guest refuses a workspace whose host did not prepare .e2e", { skip: !hostRunsGuests }, async (t) => {
  const root = await skeleton(t, ["node_modules", "apps/web/dist"]);
  const { output, status } = runScript(join(root, ".ci", "run-qemu-layer.sh"), "e2e", {
    CI_RESULTS_DIR: join(root, "results"),
  });
  assert.equal(status, 1);
  assert.match(output, /\.e2e\/node_modules is missing; install and build on this host before running the e2e guest/);
});

test("the packer refuses to build a payload without a dependency tree", async (t) => {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "pack-workspace-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, ".ci"), { recursive: true });
  await copyFile(join(ciDirectory, "pack-workspace.sh"), join(root, ".ci", "pack-workspace.sh"));
  const { output, status } = runScript(join(root, ".ci", "pack-workspace.sh"), undefined, {});
  assert.equal(status, 2);
  assert.match(output, /--output is required/);

  const withOutput = spawnSync("bash", [join(root, ".ci", "pack-workspace.sh"), "--output", resolve(root, "payload.tar.gz")], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(withOutput.status, 1);
  assert.match(`${withOutput.stdout}${withOutput.stderr}`, /node_modules is missing; install before packing the workspace/);
});
