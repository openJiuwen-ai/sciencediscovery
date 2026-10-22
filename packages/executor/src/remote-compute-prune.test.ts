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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";


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
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"];
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
  await copyFile("/bin/sleep", resolve(root, BUSY));
  await chmod(resolve(root, BUSY), 0o700);
  return root;
}

/** A process genuinely executing a binary out of the directory under test. */
async function runningBinary(context: TestContext, directory: string): Promise<void> {
  const path = resolve(directory, BUSY);
  const child = spawn(path, ["30"], { stdio: "ignore" });
  context.after(() => void child.kill("SIGKILL"));
  await once(child, "spawn");
  const deadline = Date.now() + 5_000;
  let executable: string | undefined;
  do {
    executable = await readlink(`/proc/${child.pid}/exe`).catch(() => undefined);
    if (executable === path) return;
    assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < deadline,
      `Expected /proc/${child.pid}/exe to become ${path}; last observed exe: ${executable ?? "<unreadable>"}`);
    await delay(10);
  } while (true);
}

interface ScriptResult { code: number; stdout: string; stderr: string }

function runScript(shell: string, script: string, options: {
  beforeFirstRemoval?: () => Promise<void>;
  unreadableSelf?: boolean;
} = {}): Promise<ScriptResult> {
  // FD 3 survives the product's readlink stderr redirection. Record precisely
  // what each call returned, rather than taking another /proc snapshot later.
  const observe = `exec 3>&2
readlink() {
  if [ "${options.unreadableSelf ? "1" : "0"}" = 1 ] && [ "$1" = "/proc/$$/exe" ]; then
    printf '%s => <unreadable>\\n' "$1" >&3
    return 1
  fi
  if observed_exe=$(command readlink "$@"); then
    printf '%s => %s\\n' "$1" "$observed_exe" >&3
    printf '%s\\n' "$observed_exe"
  else
    printf '%s => <unreadable>\\n' "$1" >&3
    return 1
  fi
}
`;
  // Stop after the first candidate's busy check, before its rm. Starting BUSY
  // here makes a directory-wide snapshot deterministically stale.
  const barrier = options.beforeFirstRemoval ? `rm() {
  if [ -z "\${removal_started:-}" ]; then
    removal_started=1
    printf 'BEFORE_FIRST_REMOVAL\\n' >&3
    IFS= read -r ready
  fi
  command rm "$@"
}
` : "";
  return new Promise((done, reject) => {
    const child = spawn(shell, ["-c", observe + barrier + script], { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
    let stdout = "";
    let stderr = "";
    let removalStarted = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (!removalStarted && stderr.includes("BEFORE_FIRST_REMOVAL\n") && options.beforeFirstRemoval) {
        removalStarted = true;
        options.beforeFirstRemoval().then(() => child.stdin.end("ready\n"), (error: unknown) => {
          child.kill("SIGKILL");
          reject(new Error(`${String(error)}\n${scriptEvidence({ code: -1, stdout, stderr })}`, { cause: error }));
        });
      }
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

function scriptEvidence(result: ScriptResult): string {
  return `Pruning exit code: ${result.code}\nstdout:\n${result.stdout}\nExecutables observed by pruning script:\n${result.stderr}`;
}

async function assertDeployments(directory: string, result: ScriptResult, extraPruned: string[] = []): Promise<void> {
  const evidence = scriptEvidence(result);
  assert.equal(result.code, 0, evidence);
  assert.deepEqual(parsePrunedBinaries(result.stdout).sort(), [...extraPruned, ...SUPERSEDED].sort(), evidence);
  assert.deepEqual((await readdir(directory)).sort(), [
    `.upload-${"f".repeat(24)}`, CURRENT, BUSY, name("e").slice(0, 63), "sciencediscovery-runner",
  ].sort(), evidence);
}

for (const shell of SHELLS) {
  test(`pruning under ${shell} keeps the current and the busy binary and removes the rest`, async (context) => {
    const directory = await binDirectory(context);
    await runningBinary(context, directory);

    const result = await runScript(shell, pruneRunnerBinariesScript(resolve(directory, CURRENT)));

    await assertDeployments(directory, result);
  });

  test(`pruning under ${shell} rechecks a binary that starts after the first busy scan`, async (context) => {
    const directory = await binDirectory(context);
    // Sort before BUSY so its process starts after an earlier busy scan, but
    // before the script reaches BUSY's deletion decision.
    const first = name("0");
    await writeFile(resolve(directory, first), "superseded");
    let started = false;
    const result = await runScript(shell, pruneRunnerBinariesScript(resolve(directory, CURRENT)), {
      beforeFirstRemoval: async () => {
        await runningBinary(context, directory);
        started = true;
      },
    });

    assert.ok(started, scriptEvidence(result));
    await assertDeployments(directory, result, [first]);
  });

  test(`pruning under ${shell} preserves busy entries when another process is unreadable`, async (context) => {
    const directory = await binDirectory(context);
    await runningBinary(context, directory);

    const result = await runScript(shell, pruneRunnerBinariesScript(resolve(directory, CURRENT)), { unreadableSelf: true });

    assert.match(result.stderr, /=> <unreadable>/, scriptEvidence(result));
    await assertDeployments(directory, result);
  });
}

test("pruning a directory that is not there is not an error", async () => {
  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(`${resolve(tmpdir(), "prune-runner-absent")}/${CURRENT}`));
  assert.equal(result.code, 0, scriptEvidence(result));
  assert.deepEqual(parsePrunedBinaries(result.stdout), [], scriptEvidence(result));
});

test("pruning an empty directory removes nothing", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-empty-"));
  context.after(() => rm(root, { force: true, recursive: true }));

  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(resolve(root, CURRENT)));

  assert.equal(result.code, 0, scriptEvidence(result));
  assert.deepEqual(parsePrunedBinaries(result.stdout), [], scriptEvidence(result));
  assert.deepEqual(await readdir(root), [], scriptEvidence(result));
});

// root deletes from a read-only directory, so the situation cannot be staged.
test("a file that cannot be removed is reported as kept, not as pruned", {}, async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-locked-"));
  context.after(async () => {
    await chmod(root, 0o700);
    await rm(root, { force: true, recursive: true });
  });
  await writeFile(resolve(root, SUPERSEDED[0]!), "superseded");
  await chmod(root, 0o500);

  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(resolve(root, CURRENT)));

  // The connection must survive housekeeping it could not carry out.
  assert.equal(result.code, 0, scriptEvidence(result));
  assert.deepEqual(parsePrunedBinaries(result.stdout), [], scriptEvidence(result));
  assert.deepEqual(await readdir(root), [SUPERSEDED[0]], scriptEvidence(result));
});

test("a directory whose name needs quoting is handled", async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), "prune-runner-'odd name-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(resolve(root, SUPERSEDED[0]!), "superseded");

  const result = await runScript("/bin/sh", pruneRunnerBinariesScript(resolve(root, CURRENT)));

  assert.equal(result.code, 0, scriptEvidence(result));
  assert.deepEqual(parsePrunedBinaries(result.stdout), [SUPERSEDED[0]], scriptEvidence(result));
  assert.deepEqual(await readdir(root), [], scriptEvidence(result));
});
