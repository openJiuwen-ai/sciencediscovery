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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { resetSandboxCapabilityCache } from "@sciencediscovery/sandbox-capability";

import { findExecutable, missingBwrapMessage, probeSandbox, runPreflight } from "./preflight.js";

describe("host preflight", () => {
  let workspace = "";
  let fakeBinDirectory = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-preflight-"));
    fakeBinDirectory = join(workspace, "bin");
    await mkdir(fakeBinDirectory, { recursive: true });
    // A bwrap stand-in that always fails the sandbox probe, so preflight has
    // to warn rather than abort once the executable itself is present.
    const stub = join(fakeBinDirectory, "bwrap");
    await writeFile(stub, "#!/bin/sh\nexit 1\n");
    await chmod(stub, 0o755);
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("names the executable and how to install it when bubblewrap is absent", () => {
    const message = missingBwrapMessage("bwrap");
    assert.match(message, /bubblewrap \(bwrap\) was not found/);
    assert.match(message, /apt-get install -y bubblewrap/);
    assert.match(message, /--skip-sandbox-check/);
    // The message has to explain the omission, not just report it.
    assert.match(message, /kernel user namespaces/);
  });

  test("resolves an executable through PATH", async () => {
    assert.equal(await findExecutable("bwrap", { PATH: fakeBinDirectory }), join(fakeBinDirectory, "bwrap"));
    assert.equal(await findExecutable("bwrap", { PATH: "/nonexistent" }), undefined);
    assert.equal(await findExecutable("/nonexistent/bwrap", {}), undefined);
  });

  test("fails serve when bubblewrap is missing", async () => {
    await assert.rejects(
      runPreflight({
        bwrapPath: "bwrap",
        dataDir: join(workspace, "data-missing"),
        env: { PATH: "/nonexistent" },
        skipSandboxCheck: false,
        warn: () => {},
      }),
      /was not found on this host/,
    );
  });

  test("starts anyway with --skip-sandbox-check and says so", async () => {
    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-skipped"),
      env: { PATH: "/nonexistent" },
      skipSandboxCheck: true,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.sandboxUsable, false);
    assert.match(warnings.join("\n"), /sandboxed execution will fail/);
  });

  test("warns but continues when bubblewrap cannot build a sandbox", async () => {
    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-restricted"),
      env: { PATH: fakeBinDirectory },
      skipSandboxCheck: false,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.bwrapPath, join(fakeBinDirectory, "bwrap"));
    assert.equal(result.sandboxUsable, false);
    assert.match(warnings.join("\n"), /cannot create a sandbox/);
  });

  test("reports a usable but unhardened sandbox when only --disable-userns is refused", async () => {
    // The environment the runner must degrade in: a read-only /proc/sys makes
    // the option fail while the sandbox itself builds fine. Preflight has to
    // keep serve running and name the reason, not report a broken sandbox.
    const degradedBin = join(workspace, "degraded-bin");
    await mkdir(degradedBin, { recursive: true });
    const stub = join(degradedBin, "bwrap");
    await writeFile(stub, [
      "#!/bin/sh",
      'for argument in "$@"; do',
      '  if [ "$argument" = "--disable-userns" ]; then',
      "    echo 'bwrap: cannot open /proc/sys/user/max_user_namespaces: Read-only file system' >&2",
      "    exit 1",
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(stub, 0o755);
    resetSandboxCapabilityCache();

    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-degraded"),
      env: { PATH: degradedBin },
      skipSandboxCheck: false,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.sandboxUsable, true);
    assert.equal(result.disableUserns, false);
    // Only the userns axis degraded; /proc must be untouched.
    assert.equal(result.procMode, "new");
    assert.equal(result.procFallback, false);
    const warned = warnings.join("\n");
    assert.match(warned, /cannot use it here/);
    assert.match(warned, /\/proc\/sys read-only/);
    // "Cannot create a sandbox" would be wrong here and would send an operator
    // after the wrong sysctls.
    assert.ok(!/cannot create a sandbox/.test(warned));

    // The same conclusion the runner reads, so the two cannot diverge.
    assert.deepEqual(await probeSandbox(stub), { ok: true });
  });

  test("falls back to binding /proc and warns when a fresh procfs is refused", async () => {
    // Docker without systempaths=unconfined. serve must keep running, and the
    // warning has to name the weaker profile rather than stay silent.
    const procBin = join(workspace, "proc-bin");
    await mkdir(procBin, { recursive: true });
    const stub = join(procBin, "bwrap");
    await writeFile(stub, [
      "#!/bin/sh",
      'for candidate in "$@"; do',
      '  if [ "$candidate" = "--proc" ]; then',
      "    echo \"bwrap: Can't mount proc on /newroot/proc: Operation not permitted\" >&2",
      "    exit 1",
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(stub, 0o755);
    resetSandboxCapabilityCache();

    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-proc"),
      env: { PATH: procBin },
      skipSandboxCheck: false,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.sandboxUsable, true);
    assert.equal(result.procMode, "bind");
    assert.equal(result.procFallback, true);
    // The /proc fallback must not be reported as a userns problem.
    assert.equal(result.disableUserns, true);
    const warned = warnings.join("\n");
    assert.match(warned, /cannot mount a fresh \/proc/);
    assert.match(warned, /systempaths=unconfined/);
    assert.ok(!/does not support --disable-userns/.test(warned));
    assert.ok(!/cannot create a sandbox/.test(warned));

    // Same conclusion the runner reads.
    assert.deepEqual(await probeSandbox(stub), { ok: true });
  });

  test("reports both degradations independently when the environment refuses both", async () => {
    const bothBin = join(workspace, "both-bin");
    await mkdir(bothBin, { recursive: true });
    const stub = join(bothBin, "bwrap");
    await writeFile(stub, [
      "#!/bin/sh",
      'for candidate in "$@"; do',
      '  if [ "$candidate" = "--proc" ]; then',
      "    echo \"bwrap: Can't mount proc on /newroot/proc: Operation not permitted\" >&2",
      "    exit 1",
      "  fi",
      '  if [ "$candidate" = "--disable-userns" ]; then',
      "    echo 'bwrap: cannot open /proc/sys/user/max_user_namespaces: Read-only file system' >&2",
      "    exit 1",
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"));
    await chmod(stub, 0o755);
    resetSandboxCapabilityCache();

    const warnings: string[] = [];
    const result = await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-both"),
      env: { PATH: bothBin },
      skipSandboxCheck: false,
      warn: (message) => warnings.push(message),
    });
    assert.equal(result.sandboxUsable, true);
    assert.equal(result.procFallback, true);
    assert.equal(result.disableUserns, false);
    // Both are reported; neither warning swallows the other.
    const warned = warnings.join("\n");
    assert.match(warned, /cannot mount a fresh \/proc/);
    assert.match(warned, /cannot use it here/);
  });

  test("probes with --disable-userns so preflight cannot pass a launch the runner fails", async () => {
    const seenBin = join(workspace, "seen-bin");
    await mkdir(seenBin, { recursive: true });
    const argumentLog = join(workspace, "probe-args.log");
    const stub = join(seenBin, "bwrap");
    await writeFile(stub, `#!/bin/sh\necho "$@" >> '${argumentLog}'\nexit 0\n`);
    await chmod(stub, 0o755);
    resetSandboxCapabilityCache();

    await runPreflight({
      bwrapPath: "bwrap",
      dataDir: join(workspace, "data-seen"),
      env: { PATH: seenBin },
      skipSandboxCheck: false,
      warn: () => {},
    });
    assert.match(await readFile(argumentLog, "utf8"), /--disable-userns/);
  });

  test("rejects a data directory it cannot write", async () => {
    const readOnly = join(workspace, "read-only");
    await mkdir(readOnly, { recursive: true });
    await chmod(readOnly, 0o500);
    try {
      await assert.rejects(
        runPreflight({
          bwrapPath: "bwrap",
          dataDir: join(readOnly, "data"),
          env: { PATH: fakeBinDirectory },
          skipSandboxCheck: true,
          warn: () => {},
        }),
        /not writable|EACCES/,
      );
    } finally {
      await chmod(readOnly, 0o700);
    }
  });
});
