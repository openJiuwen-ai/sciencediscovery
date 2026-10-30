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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { condaActivationPaths, environmentInterpreterPath, micromambaBinaryName, packageInstallGuidance, renameReplace, restrictToOwner, starterPackages, terminateTree } from "./index.js";

test("terminateTree keeps the upstream single-child SIGKILL semantics", async (context) => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e3)"], { stdio: "ignore" });
  context.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });

  assert.equal(terminateTree(child), true);
  const [, signal] = await new Promise<[number | null, string | null]>((resolvePromise) => {
    child.once("exit", (code, sig) => resolvePromise([code, sig]));
  });
  assert.equal(signal, "SIGKILL");
});

test("restrictToOwner chmods 0600 on a file", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-runner-platform-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, "sync-payload.bin");
  await writeFile(file, "payload");

  await restrictToOwner(file);

  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("micromamba binary name has no extension on POSIX", () => {
  assert.equal(micromambaBinaryName, "micromamba");
});

test("environmentInterpreterPath follows the POSIX conda layout", () => {
  assert.equal(environmentInterpreterPath("/envs/rev-1", "python"), "/envs/rev-1/bin/python");
  assert.equal(environmentInterpreterPath("/envs/rev-1", "r"), "/envs/rev-1/bin/R");
});

test("condaActivationPaths is just bin/ on POSIX", () => {
  assert.deepEqual(condaActivationPaths("/envs/rev-1"), ["/envs/rev-1/bin"]);
});

test("starterPackages keep the upstream matplotlib spec on POSIX", () => {
  assert.deepEqual(starterPackages("python"),
    ["python=3.12", "numpy=2.0", "pandas=2.2", "scipy=1.14", "matplotlib=3.9"]);
  assert.deepEqual(starterPackages("r"), ["r-base=4.4", "r-tidyverse=2.0", "r-data.table=1.16"]);
});

test("packageInstallGuidance passes solver errors through unchanged on POSIX", () => {
  assert.equal(packageInstallGuidance("critical libmamba Could not solve for environment specs"), null);
});
