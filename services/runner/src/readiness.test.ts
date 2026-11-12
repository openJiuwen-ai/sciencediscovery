// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { RunnerReadiness } from "./readiness.js";
import { createRunnerServer, loadRunnerConfig } from "./server.js";

test("readiness refresh observes repairs in the Runner process and keeps instance identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "runner-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "bwrap"), readiness = new RunnerReadiness("bubblewrap", executable);
  const missing = await readiness.get();
  assert.equal(missing.reason, "dependency-unavailable");
  await writeFile(executable, "#!/bin/sh\necho '--cap-drop --die-with-parent --new-session --seccomp --unshare-all --unshare-user --disable-userns'\nexit 0\n");
  await chmod(executable, 0o755);
  assert.equal((await readiness.get()).ready, false);
  const [repaired, concurrent] = await Promise.all([readiness.get(true), readiness.get(true)]);
  assert.equal(repaired.ready, true);
  assert.equal(repaired, concurrent);
  assert.equal(repaired.instanceId, missing.instanceId);
  await writeFile(executable, "#!/bin/sh\necho 'old bwrap'\n");
  assert.equal((await readiness.get(true)).reason, "incompatible");
  assert.notEqual((await new RunnerReadiness("bubblewrap", executable).get()).instanceId, missing.instanceId);
});

test("a missing sandbox executable says how to install it, in at most three lines", async t => {
  const root = await mkdtemp(join(tmpdir(), "runner-missing-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bubblewrap = await new RunnerReadiness("bubblewrap", join(root, "bwrap")).get();
  assert.equal(bubblewrap.reason, "dependency-unavailable");
  // The package and the executable have different names; the message carries both.
  assert.match(bubblewrap.detail ?? "", /ENOENT/);
  assert.match(bubblewrap.detail ?? "", /bubblewrap package, which provides the bwrap executable/);
  assert.match(bubblewrap.detail ?? "", /sudo apt-get install -y bubblewrap/);
  assert.match(bubblewrap.detail ?? "", /docs\/en\/getting-started\/deployment\.md#linux-reports-missing-bwrap/);
  const seatbelt = await new RunnerReadiness("seatbelt", join(root, "sandbox-exec")).get();
  assert.equal(seatbelt.reason, "dependency-unavailable");
  assert.match(seatbelt.detail ?? "", /ships with macOS and is not installed separately/);
  assert.match(seatbelt.detail ?? "", /#macos-reports-seatbelt-is-unavailable/);
  for (const detail of [bubblewrap.detail, seatbelt.detail]) assert.ok((detail ?? "").split("\n").length <= 3);
});

test("none-provider readiness without a managed shell probe stays ready", async () => {
  const capability = await new RunnerReadiness("none", "unused").get();
  assert.equal(capability.ready, true);
  assert.equal(capability.dependencyAvailable, true);
  assert.equal(capability.reason, "ready");
  assert.deepEqual(capability.readyFor, { python: true, shell: true });
  // An absent `shell` field is an older Runner that cannot report it, so it stays
  // unknown rather than counting as unavailable.
  assert.equal(capability.shell, undefined);
});

test("none-provider readiness reports and rechecks its managed shell contract", async () => {
  let available = false;
  const readiness = new RunnerReadiness("none", "unused", async () => ({
    available,
    name: "bash",
    utilities: available ? ["cat", "grep", "head", "sed", "tail", "wc"] : [],
    ...(available ? {} : { unavailableReason: "Managed Bash is missing required utilities: head" }),
  }));
  const missing = await readiness.get();
  assert.equal(missing.ready, true);
  assert.equal(missing.dependencyAvailable, true);
  // The Python channel stays ready, but the verdict is no longer presented as a
  // general green light: `reason` names the Shell gap and `readyFor` says which
  // route is which (#1108).
  assert.equal(missing.reason, "shell-unavailable");
  assert.deepEqual(missing.readyFor, { python: true, shell: false });
  assert.equal(missing.detail, "Managed Bash is missing required utilities: head");
  assert.equal(missing.shell?.available, false);
  available = true;
  const repaired = await readiness.get();
  assert.equal(repaired.ready, true);
  assert.equal(repaired.reason, "ready");
  assert.deepEqual(repaired.readyFor, { python: true, shell: true });
  assert.equal(repaired.shell?.utilities.includes("head"), true);
  assert.equal(repaired.platform, "linux");
});

test("management remains reachable and execution fails closed without a sandbox", async t => {
  const root = await mkdtemp(join(tmpdir(), "runner-no-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createRunnerServer({ ...loadRunnerConfig(), dataDir: root, authToken: "test-token", bwrapPath: join(root, "missing"), sandboxProvider: "bubblewrap", scientificEnvsEnabled: false, npuBrokerEnabled: false });
  // Exercise the actual request handler without a listening socket. CI also
  // covers startup over HTTP in server.test.ts.
  const request = (method: string, url: string, token = "test-token") => new Promise<{status: number; body: any}>(resolve => {
    let status = 0;
    server.emit("request", { method, url, headers: { authorization: `Bearer ${token}` } }, {
      writeHead(code: number) { status = code; },
      end(body: string) { resolve({ status, body: JSON.parse(body) }); },
    });
  });
  assert.equal((await request("GET", "/execution-capability", "wrong")).status, 401);
  const capability = await request("POST", "/execution-capability");
  assert.equal(capability.status, 200);
  assert.equal(capability.body.reason, "dependency-unavailable");
  for (const path of ["/execute", "/execute-shell", "/shell-executions"]) {
    const result = await request("POST", path);
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "EXECUTION_UNAVAILABLE");
  }
});

for (const unavailableReason of [
  "Managed Bash is unavailable: ENOENT",
  "Scientific environments are disabled by configuration",
]) {
  test(`none-provider shell gap only blocks shell routes: ${unavailableReason}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "runner-shell-gap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const authToken = randomUUID();
    const readiness = new RunnerReadiness("none", "unused", async () => ({
      available: false, name: "bash", utilities: [], unavailableReason,
    }));
    const server = createRunnerServer({ ...loadRunnerConfig(), dataDir: root, authToken,
      sandboxProvider: "none", scientificEnvsEnabled: false, npuBrokerEnabled: false },
      undefined, undefined, undefined, undefined, undefined, undefined, readiness);
    const request = (method: string, url: string) => new Promise<{ status: number; body: Record<string, unknown> }>(resolve => {
      const input = Object.assign(Readable.from(["{}"]), {
        method, url, headers: { authorization: `Bearer ${authToken}` },
      });
      let status = 0;
      server.emit("request", input, {
        writeHead(code: number) { status = code; },
        end(body: string) { resolve({ status, body: JSON.parse(body) }); },
      });
    });
    const capability = await request("POST", "/execution-capability");
    assert.equal(capability.status, 200);
    assert.equal(capability.body.ready, true);
    assert.equal(capability.body.reason, "shell-unavailable");
    assert.deepEqual(capability.body.readyFor, { python: true, shell: false });
    // The synchronous route has no execution record to settle, so it fails closed.
    const synchronous = await request("POST", "/execute-shell");
    assert.equal(synchronous.status, 503);
    assert.equal(synchronous.body.code, "EXECUTION_UNAVAILABLE");
    assert.equal(synchronous.body.error, unavailableReason);
    // The managed route must accept the request and record a deterministic
    // failure later; a 503 here would be an unverified outcome for the API.
    const managed = await request("POST", "/shell-executions");
    assert.equal(managed.status, 401);
    assert.equal(managed.body.error, "Invalid or expired execution signature");
    // An unsigned Python request reaches authentication rather than being
    // rejected by shell readiness. No code is dispatched in this handler test.
    const python = await request("POST", "/execute");
    assert.equal(python.status, 401);
    assert.equal(python.body.error, "Invalid or expired execution signature");
  });
}
