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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:windows"] });
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { restrictToOwner, terminateTree } from "./index.js";

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
