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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:windows", "arch:amd64"] });
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { condaActivationPaths, environmentInterpreterPath, environmentShellPath, micromambaBinaryName, packageInstallGuidance, renameReplace, restrictToOwner, starterPackages, terminateTree } from "./index.js";

function processAlive(pid: number): boolean {
  // tasklist exit code stays 0 even for no match, so inspect the output.
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes(`"${pid}"`);
}

test("terminateTree kills a child and the grandchild it spawned", async (context) => {
  // The child prints its grandchild's pid, then both idle forever.
  const script = "const {spawn}=require('node:child_process');"
    + "const g=spawn(process.execPath,['-e','setInterval(()=>{},1e3)']);"
    + "console.log('grandchild:'+g.pid);setInterval(()=>{},1e3);";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  context.after(() => {
    try { terminateTree(child); } catch { /* already gone */ }
  });

  const grandchildPid = await new Promise<number>((resolvePromise, rejectPromise) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = /grandchild:(\d+)/.exec(buffer);
      if (match) resolvePromise(Number(match[1]));
    });
    child.once("error", rejectPromise);
    setTimeout(() => rejectPromise(new Error("grandchild pid never appeared")), 10_000);
  });
  assert.ok(processAlive(child.pid!));
  assert.ok(processAlive(grandchildPid));

  assert.equal(terminateTree(child), true);
  await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  // Give taskkill a beat to finish the tree walk.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

  assert.equal(processAlive(child.pid!), false);
  assert.equal(processAlive(grandchildPid), false, "grandchild must not be orphaned");
});

test("restrictToOwner removes inherited group access from a file", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-runner-platform-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, "sync-payload.bin");
  await writeFile(file, "payload");

  await restrictToOwner(file);

  const report = spawnSync("icacls", [file], { encoding: "utf8" });
  assert.equal(report.status, 0);
  assert.ok(!/BUILTIN\\Users|Everyone|Authenticated Users/i.test(report.stdout), report.stdout);
});

test("micromamba binary name carries the .exe Windows needs to execute", () => {
  assert.equal(micromambaBinaryName, "micromamba.exe");
});

test("environmentInterpreterPath follows the win-64 conda layout", () => {
  // win-64 conda: python.exe at the prefix root, R.exe under Scripts/.
  assert.equal(environmentInterpreterPath("C:\\envs\\rev-1", "python"), "C:\\envs\\rev-1\\python.exe");
  assert.equal(environmentInterpreterPath("C:\\envs\\rev-1", "r"), "C:\\envs\\rev-1\\Scripts\\R.exe");
});

test("condaActivationPaths cover the win-64 delay-load DLL directories", () => {
  // Without Library\bin on PATH, importing numpy/scipy dies with 0xC06D007F.
  assert.deepEqual(condaActivationPaths("C:\\envs\\rev-1"),
    ["C:\\envs\\rev-1", "C:\\envs\\rev-1\\Library\\bin", "C:\\envs\\rev-1\\Scripts"]);
});

test("renameReplace replaces an existing destination", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "sd-runner-platform-"));
  context.after(() => rm(dir, { force: true, recursive: true }));
  const source = join(dir, "incoming");
  const destination = join(dir, "existing");
  await writeFile(source, "new");
  await writeFile(destination, "old");

  await renameReplace(source, destination);

  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(destination, "utf8"), "new");
});

test("starterPackages swaps matplotlib for matplotlib-base on win32", () => {
  // qt6's in-package qml test resources exceed MAX_PATH even under a shallow
  // prefix; agents render via Agg to files, so matplotlib-base loses nothing.
  // m2-bash (MSYS2 bash) is bundled so run_shell works on the
  // direct-execution provider — Windows hosts have no system bash.
  assert.deepEqual(starterPackages("python"),
    ["python=3.12", "numpy=2.0", "pandas=2.2", "scipy=1.14", "matplotlib-base=3.9", "m2-bash"]);
  assert.deepEqual(starterPackages("r"), ["r-base=4.4", "r-tidyverse=2.0", "r-data.table=1.16"]);
});

test("environmentShellPath resolves the m2-bash location inside a win-64 prefix", () => {
// Verified on a real install: m2-bash lands at Library\usr\bin\bash.exe inside a win-64 prefix.
  assert.equal(environmentShellPath("C:\\envs\\rev-1"), "C:\\envs\\rev-1\\Library\\usr\\bin\\bash.exe");
});

test("packageInstallGuidance explains missing win-64 builds with alternatives", () => {
  for (const raw of [
    "critical libmamba Could not solve for environment specs\nThe following package could not be located: pysam",
    "error    libmamba nothing provides requested jaxlib",
    "PackagesNotFoundError: The following packages are not available from current channels: tensorflow",
  ]) {
    const guidance = packageInstallGuidance(raw);
    assert.ok(guidance, `guidance expected for: ${raw.slice(0, 60)}`);
    assert.match(guidance, /win-64/);
    assert.match(guidance, /pip/);
    assert.match(guidance, /sandbox/);
  }
  assert.equal(packageInstallGuidance("error    libmamba SSL certificate verify failed"), null);
  assert.equal(packageInstallGuidance("disk full"), null);
});
