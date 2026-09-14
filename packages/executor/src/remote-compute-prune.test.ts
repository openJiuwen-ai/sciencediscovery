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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { parsePrunedBinaries, pruneRunnerBinariesScript } from "./remote-compute.js";

/**
 * The pruning runs as a shell script on someone else's machine, so the risk is
 * not in the TypeScript: it is in `set -e`, in globbing, and in what
 * `/proc/<pid>/exe` answers for a process this user may not inspect. These
 * tests run the real script through a real shell against a real directory with
 * a real process running out of it.
 */
// /bin/sh is the one the product actually gets; the others are checked when the
// machine has them, because a remote login shell is not always dash.
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((shell) => existsSync(shell));
const name = (character: string) => character.repeat(64);
const CURRENT = name("a");
const BUSY = name("b");
const SUPERSEDED = [name("c"), name("d")];

async function binDirectory(context: TestContext): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  for (const binary of [CURRENT, ...SUPERSEDED]) await writeFile(resolve(root, binary), binary);
  // Names that are not a deployment, and one that only looks like one. A
  // pre-installed runner is the case that matters: the product did not put it
  // there and must not take it away.
  await writeFile(resolve(root, "sciencediscovery-runner"), "a pre-installed runner");
  await writeFile(resolve(root, name("e").slice(0, 63)), "63 hex characters");
  await writeFile(resolve(root, `.upload-${"f".repeat(24)}`), "an interrupted transfer");
  return root;
}

/** A process genuinely executing a binary out of the directory under test. */
async function runningBinary(context: TestContext, directory: string): Promise<void> {
  const path = resolve(directory, BUSY);
  await copyFile("/bin/sleep", path);
  await chmod(path, 0o700);
  const child = spawn(path, ["30"], { stdio: "ignore" });
  context.after(() => void child.kill("SIGKILL"));
  await new Promise((ready) => child.once("spawn", ready));
}

function runScript(shell: string, script: string): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(shell, ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("close", (code) => done({ code: code ?? -1, stdout }));
  });
}

for (const shell of SHELLS) {
  test(`pruning under ${shell} keeps the current and the busy binary and removes the rest`, async (context) => {
    const directory = await binDirectory(context);
    await runningBinary(context, directory);

    const result = await runScript(shell, pruneRunnerBinariesScript(resolve(directory, CURRENT)));

    assert.equal(result.code, 0);
    assert.deepEqual(parsePrunedBinaries(result.stdout).sort(), [...SUPERSEDED].sort());
    assert.deepEqual((await readdir(directory)).sort(), [
      `.upload-${"f".repeat(24)}`, CURRENT, BUSY, name("e").slice(0, 63), "sciencediscovery-runner",
    ].sort());
  });
}

test("pruning a directory that is not there is not an error", async () => {
  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(`${resolve(tmpdir(), "prune-runner-absent")}/${CURRENT}`));
  assert.equal(result.code, 0);
  assert.deepEqual(parsePrunedBinaries(result.stdout), []);
});

test("pruning an empty directory removes nothing", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-empty-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(resolve(root, CURRENT)));

  assert.equal(result.code, 0);
  assert.deepEqual(parsePrunedBinaries(result.stdout), []);
  assert.deepEqual(await readdir(root), []);
});

// root deletes from a read-only directory, so the situation cannot be staged.
test("a file that cannot be removed is reported as kept, not as pruned", { skip: process.getuid?.() === 0 }, async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-locked-"));
  context.after(async () => {
    await chmod(root, 0o700);
    await rm(root, { force: true, recursive: true });
  });
  await writeFile(resolve(root, SUPERSEDED[0]!), "superseded");
  await chmod(root, 0o500);

  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(resolve(root, CURRENT)));

  // The connection must survive housekeeping it could not carry out.
  assert.equal(result.code, 0);
  assert.deepEqual(parsePrunedBinaries(result.stdout), []);
  assert.deepEqual(await readdir(root), [SUPERSEDED[0]]);
});

test("a directory whose name needs quoting is handled", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-'odd name-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(resolve(root, SUPERSEDED[0]!), "superseded");

  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(resolve(root, CURRENT)));

  assert.equal(result.code, 0);
  assert.deepEqual(parsePrunedBinaries(result.stdout), [SUPERSEDED[0]]);
  assert.deepEqual(await readdir(root), []);
});
