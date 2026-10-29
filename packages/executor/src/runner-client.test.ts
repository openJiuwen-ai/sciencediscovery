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

test("RunnerClient resolves environment proxy for each setup and install operation", async (context) => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  let policy: import("@sciencediscovery/schema").ResolvedProxy = { mode: "environment", noProxy: "internal.test" };
  const client = new RunnerClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "test-token", () => policy);
  await client.setupScientificEnvironments();
  policy = { mode: "direct" };
  await client.installEnvironment("env", { packages: ["numpy"] } as Parameters<RunnerClient["installEnvironment"]>[1]);
  assert.deepEqual(bodies.map(body => body.networkProxy), [{ mode: "environment", noProxy: "internal.test" }, { mode: "direct" }]);
});

test("RunnerClient retains an HTTP failure status even when the Runner supplies an error message", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "temporarily unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const port = (server.address() as AddressInfo).port;
  const client = new RunnerClient(`http://127.0.0.1:${port}`, "test-token");
  await assert.rejects(client.status(), (error: unknown) => {
    assert.equal((error as Error).message, "temporarily unavailable");
    assert.equal((error as Error & { statusCode?: number }).statusCode, 503);
    return true;
  });
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
