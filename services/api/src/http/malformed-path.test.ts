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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import type { ServerConfig } from "../bootstrap/config.js";
import { configureApiLogging } from "../logging.js";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";
import { closeApiServer, createApiServer } from "./index.js";

/** The control API on a real socket, so a path reaches it byte for byte. */
async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "malformed-path-"));
  const config: ServerConfig = {
    authToken: "test-token",
    dataDir: root,
    evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
    modelCatalogPath: resolve(root, "absent.json"),
    paperPythonPath: resolve(root, "no-python"),
    paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0,
    port: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token",
    runnerUrl: "http://127.0.0.1:1",
    sampleSession: false,
    sshConfigPath: resolve(root, "ssh-config"),
    staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
  };
  const server = createApiServer(config, { mcpTransport: offlineMcpTransport });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  // The operational log is a file under the data directory; pointing it here is
  // what lets the test read back what the request wrote.
  configureApiLogging(root);
  context.after(async () => {
    await closeApiServer(server);
    await rm(root, { force: true, recursive: true });
  });
  return { port: (server.address() as AddressInfo).port, root };
}

/** `http.request` takes the path as given, so `%%` is not normalised away. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      { headers: { authorization: "Bearer test-token" }, host: "127.0.0.1", method: "GET", path, port },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => done({ body: Buffer.concat(chunks).toString(), status: response.statusCode ?? 0 }));
      },
    );
    request.on("error", fail);
    request.end();
  });
}

/** The same, for the one route that only answers POST. */
function send(port: number, method: string, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        headers: {
          authorization: "Bearer test-token",
          "content-length": Buffer.byteLength(payload),
          "content-type": "application/json",
        },
        host: "127.0.0.1",
        method,
        path,
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => done({ body: Buffer.concat(chunks).toString(), status: response.statusCode ?? 0 }));
      },
    );
    request.on("error", fail);
    request.end(payload);
  });
}

test("a path segment that is not valid percent-encoding answers 400, not 500", async (context) => {
  const { port, root } = await fixture(context);
  const response = await get(port, "/api/skills/id-%%");
  assert.equal(response.status, 400, "a malformed escape is the caller's mistake");
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed path parameter: skillId" });
  // The event the team watches for real server faults must stay quiet here.
  const log = await readFile(resolve(root, "logs", "api.log"), "utf8").catch(() => "");
  assert.doesNotMatch(log, /unclassified_request_error/);
});

test("a malformed escape in a static path answers 400, not 500", async (context) => {
  const { port } = await fixture(context);
  const response = await get(port, "/%");
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed path parameter: pathname" });
});

test("a malformed segment answers 400 on a route outside the route table", async (context) => {
  const { port } = await fixture(context);
  const response = await get(port, "/api/skill-libraries/%zz");
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed path parameter: libraryId" });
});

test("a malformed decision segment answers 400, not the branch's 409", async (context) => {
  const { port } = await fixture(context);
  const response = await send(port, "POST", "/api/sessions/anything/execution-blocks/%zz", { action: "cancel" });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed path parameter: decisionId" });
});

test("a malformed run id on the internal runner route answers 400, not 500", async (context) => {
  const { port } = await fixture(context);
  const response = await get(port, "/internal/evolve-runner/%zz/shell-executions");
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed path parameter: runId" });
});

test("a route main added after the report is covered too", async (context) => {
  const { port } = await fixture(context);
  const response = await get(port, "/api/skills/%zz/package");
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed path parameter: skillId" });
});

test("a well-formed but unknown id keeps its 404", async (context) => {
  const { port } = await fixture(context);
  const response = await get(port, "/api/skills/id-plain");
  assert.equal(response.status, 404);
  assert.match(JSON.parse(response.body).error, /^Skill not found: id-plain$/);
});
