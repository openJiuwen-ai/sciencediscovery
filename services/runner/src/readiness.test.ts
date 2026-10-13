// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
