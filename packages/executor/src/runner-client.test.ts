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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { RunnerClient } from "./runner-client.js";

test("RunnerClient retains an HTTP failure status but never copies the remote error text", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "SENTINEL_SECRET_XYZ temporarily unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as AddressInfo).port;
  const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token");
  await assert.rejects(client.status(), (error: unknown) => {
    assert.match((error as Error).message, /Runner request failed \(503\)/);
    assert.equal((error as Error & { statusCode?: number }).statusCode, 503);
    assert.equal((error as Error & { code?: string }).code, undefined, "an unallowlisted remote code is not trusted");
    assert.doesNotMatch((error as Error).message, /SENTINEL_SECRET_XYZ/);
    return true;
  });
});

test("allowlisted remote conflict codes survive classification but never carry remote text", async t => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.statusCode = 409;
    response.end(JSON.stringify({ code: "EXECUTION_ID_CONFLICT", error: "SENTINEL_SECRET_XYZ conflict" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const client = new RunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "fixture-token");
  await assert.rejects(client.getShellExecution("job", { sessionId: "session", agentId: "main" }), (error: unknown) => {
    assert.equal((error as Error & { statusCode?: number }).statusCode, 409);
    assert.equal((error as Error & { code?: string }).code, "EXECUTION_ID_CONFLICT");
    assert.equal((error as Error).message, "Runner execution identity conflict");
    assert.doesNotMatch((error as Error).message, /SENTINEL_SECRET_XYZ/);
    return true;
  });
});

test("prototype-chain keys are never accepted as a remote code", async t => {
  for (const forged of ["constructor", "toString", "__proto__"]) {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.statusCode = 409;
      response.end(JSON.stringify({ code: forged, error: "SENTINEL_SECRET_XYZ" }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
    const client = new RunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "fixture-token");
    await assert.rejects(client.getShellExecution("job", { sessionId: "session", agentId: "main" }), (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, undefined, `${forged} is not an allowlisted code`);
      assert.equal((error as Error).message, "Runner request failed (409)");
      assert.doesNotMatch((error as Error).message, /SENTINEL_SECRET_XYZ/);
      return true;
    });
  }
});

test("direct capability probes preserve target workspace scope and caller cancellation", async t => {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    const url = new URL(request.url!, "http://fixture"); requests.push(url);
    assert.equal(url.pathname, "/direct-execution-capability");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ available: true, target: "instance", account: "user",
      ...(url.search ? { workspaceRoot: "/target/workspace", cwd: url.searchParams.get("cwd") } : {}) }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const client = new RunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "fixture-token");
  assert.equal((await client.directExecutionCapability()).workspaceRoot, undefined);
  const remote = { runnerWorkspaceKey: "session/a space+&", cwd: "sub directory" };
  assert.equal((await client.directExecutionCapability(undefined, remote)).cwd, remote.cwd);
  const local = { workspaceRoot: "/target/space & plus+", cwd: "" };
  await client.directExecutionCapability(new AbortController().signal, local);
  assert.equal(requests[0]!.search, "");
  assert.deepEqual(Object.fromEntries(requests[1]!.searchParams), remote);
  assert.deepEqual(Object.fromEntries(requests[2]!.searchParams), local);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.directExecutionCapability(controller.signal, remote), /abort/i);
  assert.equal(requests.length, 3, "an aborted probe must not reach the target");
});

test("managed result integrity is checked before clock conversion and structured conflicts survive HTTP", async t => {
  const { createHash } = await import("node:crypto");
  const result = { stdout: "original", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))));
  const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  let tamper = false; let conflict = false;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("date", "Thu, 01 Jan 2026 01:00:00 GMT");
    if (conflict) { response.statusCode = 409; response.end(JSON.stringify({ code: "EXECUTION_ID_CONFLICT", error: "conflict" })); return; }
    response.end(JSON.stringify({ id: "job", sessionId: "session", agentId: "main", state: "completed", queuedAt: "now",
      evidence: { resultDigest: digest }, result: { ...result, stdout: tamper ? "changed" : result.stdout } }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const client = new RunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "fixture-token");
  const value = await client.getShellExecution("job", { sessionId: "session", agentId: "main" });
  assert.equal(value.result!.stdout, "original");
  assert.notEqual(value.result!.startedAt, result.startedAt, "clock adjustment occurs after verification");
  tamper = true;
  await assert.rejects(client.getShellExecution("job", { sessionId: "session", agentId: "main" }), { code: "RESULT_DIGEST_MISMATCH" });
  conflict = true;
  await assert.rejects(client.getShellExecution("job", { sessionId: "session", agentId: "main" }), (error: unknown) => {
    assert.equal((error as Error & { statusCode?: number }).statusCode, 409);
    assert.equal((error as Error & { code?: string }).code, "EXECUTION_ID_CONFLICT");
    assert.equal((error as Error).message, "Runner execution identity conflict");
    assert.doesNotMatch((error as Error).message, /^conflict$/);
    return true;
  });
});
