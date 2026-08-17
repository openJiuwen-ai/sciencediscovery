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
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  detectSandboxCapability,
  disableUsernsOmittedMessage,
  procFallbackMessage,
  procMountArguments,
  resetSandboxCapabilityCache,
  sandboxProbeArguments,
} from "./index.js";

/** bubblewrap's real refusals, used verbatim so the stubs model the environments. */
const PROC_EPERM = "bwrap: Can't mount proc on /newroot/proc: Operation not permitted";
const USERNS_EROFS = "bwrap: cannot open /proc/sys/user/max_user_namespaces: Read-only file system";
const UNKNOWN_OPTION = "bwrap: Unknown option --disable-userns";

/** Quote for a shell single-quoted string; bubblewrap messages contain apostrophes. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * A bubblewrap stand-in that fails whenever the command line contains any of
 * `rejects`, so a stub can model "refuses a fresh procfs", "refuses
 * --disable-userns", or both at once.
 */
function stubRejecting(rejects: Array<{ argument: string; failure: string }>): string {
  const clauses = rejects.flatMap(({ argument, failure }) => [
    `  if [ "$candidate" = "${argument}" ]; then`,
    `    echo ${shellQuote(failure)} >&2`,
    "    exit 1",
    "  fi",
  ]);
  return [
    "#!/bin/sh",
    'for candidate in "$@"; do',
    "  :",  // keep the loop body non-empty when nothing is rejected
    ...clauses,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

describe("sandbox capability detection", () => {
  let workspace = "";

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "science-agent-sandbox-capability-"));
  });

  after(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  beforeEach(() => {
    resetSandboxCapabilityCache();
  });

  async function writeStub(name: string, script: string): Promise<string> {
    const path = join(workspace, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
    return path;
  }

  test("mounts a fresh procfs by default and binds only as a fallback", () => {
    assert.deepEqual(procMountArguments("new"), ["--proc", "/proc"]);
    assert.deepEqual(procMountArguments("bind"), ["--ro-bind", "/proc", "/proc"]);
  });

  test("probes the real options rather than trusting --help", () => {
    const hardened = sandboxProbeArguments({ disableUserns: true, procMode: "new" });
    const baseline = sandboxProbeArguments({ disableUserns: false, procMode: "new" });
    assert.ok(hardened.includes("--disable-userns"));
    assert.ok(!baseline.includes("--disable-userns"));
    // The disable-userns probes must differ by exactly that flag, or the
    // classification below could not attribute a failure to it.
    assert.deepEqual(hardened.filter((argument) => argument !== "--disable-userns"), baseline);
    // The /proc probes must differ by exactly the /proc arguments.
    const bound = sandboxProbeArguments({ disableUserns: false, procMode: "bind" });
    assert.ok(baseline.includes("--proc"));
    assert.ok(!bound.includes("--proc"));
    assert.ok(bound.join(" ").includes("--ro-bind /proc /proc"));
    // A probe that cannot unshare a user namespace would exercise neither.
    assert.ok(baseline.includes("--unshare-user"));
    assert.ok(baseline.includes("--unshare-all"));
  });

  test("keeps both hardenings when the full sandbox launches", async () => {
    const stub = await writeStub("bwrap-ok", "#!/bin/sh\nexit 0\n");
    const capability = await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.equal(capability.procMode, "new");
    assert.equal(capability.procFallback, false);
    assert.equal(capability.procDetail, undefined);
    assert.equal(capability.disableUserns, true);
    assert.equal(capability.sandboxUsable, true);
    assert.equal(capability.reason, "supported");
  });

  test("falls back to binding /proc when a fresh procfs is refused", async () => {
    // Docker's default readonlyPaths/maskedPaths, i.e. Compose without
    // systempaths=unconfined.
    const stub = await writeStub(
      "bwrap-proc-eperm",
      stubRejecting([{ argument: "--proc", failure: PROC_EPERM }]),
    );
    const capability = await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.equal(capability.procMode, "bind");
    assert.equal(capability.procFallback, true);
    assert.match(capability.procDetail ?? "", /Can't mount proc/);
    assert.equal(capability.sandboxUsable, true);
    // The fallback must not be mistaken for the option being unavailable.
    assert.equal(capability.disableUserns, true);
    assert.equal(capability.reason, "supported");

    const message = procFallbackMessage(stub, capability);
    assert.match(message, /--ro-bind \/proc \/proc/);
    assert.match(message, /container's \/proc/);
    assert.match(message, /systempaths=unconfined/);
    assert.match(message, /Do not use privileged/);
  });

  test("does not fall back when a fresh procfs works", async () => {
    // Only --disable-userns is refused here; /proc must stay untouched.
    const stub = await writeStub(
      "bwrap-userns-only",
      stubRejecting([{ argument: "--disable-userns", failure: USERNS_EROFS }]),
    );
    const capability = await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.equal(capability.procMode, "new");
    assert.equal(capability.procFallback, false);
    assert.equal(capability.disableUserns, false);
    assert.equal(capability.reason, "option-rejected");
    assert.equal(capability.sandboxUsable, true);
  });

  test("resolves both degradations independently when the environment refuses both", async () => {
    // The real LXC / unrelaxed-Docker shape: no fresh procfs, and a read-only
    // /proc/sys that also refuses the sysctl write.
    const stub = await writeStub(
      "bwrap-proc-and-userns",
      stubRejecting([
        { argument: "--proc", failure: PROC_EPERM },
        { argument: "--disable-userns", failure: USERNS_EROFS },
      ]),
    );
    const capability = await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.equal(capability.procMode, "bind");
    assert.equal(capability.procFallback, true);
    assert.match(capability.procDetail ?? "", /Can't mount proc/);
    assert.equal(capability.disableUserns, false);
    assert.equal(capability.reason, "option-rejected");
    assert.match(capability.detail ?? "", /max_user_namespaces: Read-only file system/);
    assert.equal(capability.sandboxUsable, true);
  });

  test("omits the option on pre-0.8 bubblewrap and says to upgrade", async () => {
    const stub = await writeStub(
      "bwrap-old",
      stubRejecting([{ argument: "--disable-userns", failure: UNKNOWN_OPTION }]),
    );
    const capability = await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.equal(capability.disableUserns, false);
    assert.equal(capability.reason, "option-unknown");
    assert.equal(capability.procMode, "new");
    assert.match(disableUsernsOmittedMessage(stub, capability), /Upgrade bubblewrap/);
  });

  test("reports an unusable sandbox when neither /proc shape works", async () => {
    const stub = await writeStub(
      "bwrap-broken",
      "#!/bin/sh\necho 'bwrap: No permissions to creating new namespace' >&2\nexit 1\n",
    );
    const capability = await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.equal(capability.sandboxUsable, false);
    assert.equal(capability.disableUserns, false);
    assert.equal(capability.reason, "sandbox-unusable");
    // No fallback is claimed: binding /proc did not rescue this host either.
    assert.equal(capability.procFallback, false);
    assert.match(capability.detail ?? "", /new namespace/);
  });

  test("treats a missing binary as an unusable sandbox instead of throwing", async () => {
    const capability = await detectSandboxCapability(join(workspace, "absent-bwrap"), { timeoutMs: 5_000 });
    assert.equal(capability.sandboxUsable, false);
    assert.equal(capability.disableUserns, false);
    assert.equal(capability.procFallback, false);
    assert.equal(capability.reason, "sandbox-unusable");
  });

  test("probes a binary once and reuses the answer", async () => {
    const callLog = join(workspace, "calls.log");
    await writeFile(callLog, "");
    const stub = await writeStub("bwrap-counted", `#!/bin/sh\necho call >> '${callLog}'\nexit 0\n`);
    const [first, second] = await Promise.all([
      detectSandboxCapability(stub, { timeoutMs: 5_000 }),
      detectSandboxCapability(stub, { timeoutMs: 5_000 }),
    ]);
    await detectSandboxCapability(stub, { timeoutMs: 5_000 });
    assert.deepEqual(first, second);
    // One /proc probe plus one --disable-userns probe; no fallback probe,
    // because the first succeeded.
    const calls = (await readFile(callLog, "utf8")).split("\n").filter(Boolean);
    assert.equal(calls.length, 2);
  });
});
