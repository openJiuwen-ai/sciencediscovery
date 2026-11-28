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
import { SessionStore } from "../store.js";
import { ApiStatusError } from "./api-status-error.js";
import { closeApiServer, createApiServer } from "./index.js";

/** The control API on a real socket, with the operational log under `root`. */
async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "error-classification-http-"));
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

/** One request on the real socket; `body` is sent verbatim, so malformed JSON reaches the parser. */
function call(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const request = httpRequest(
      {
        headers: {
          authorization: "Bearer test-token",
          ...(body === undefined ? {} : {
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json",
          }),
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
    request.end(body);
  });
}

/**
 * Make the real `GET /api/settings` handler raise `fault` from the store, the
 * same seam the sandbox-settings test uses for a persistence failure. The route
 * and the catch-all are the production ones; only the store call is replaced.
 */
function throwFromSettingsRoute(context: TestContext, fault: unknown) {
  const original = SessionStore.prototype.getGlobalSettings;
  SessionStore.prototype.getGlobalSettings = (() => { throw fault; }) as typeof SessionStore.prototype.getGlobalSettings;
  context.after(() => {
    SessionStore.prototype.getGlobalSettings = original;
  });
}

async function apiLog(root: string): Promise<string> {
  return readFile(resolve(root, "logs", "api.log"), "utf8").catch(() => "");
}

test("an internal TypeError answers 500 with the generic body and the fault line", async (context) => {
  const { port, root } = await fixture(context);
  // The #1520 instance: a handler dereferenced a field that was not there, and
  // `/\bcannot\b/i` used to turn it into a 400 carrying raw JavaScript text.
  throwFromSettingsRoute(context, new TypeError("Cannot read properties of undefined (reading 'match')"));
  const response = await call(port, "GET", "/api/settings");
  assert.equal(response.status, 500, "a runtime error is this server's fault, whatever its words");
  assert.deepEqual(JSON.parse(response.body), { error: "Internal server error" });
  assert.doesNotMatch(response.body, /reading 'match'/, "JavaScript text must not reach the client");
  const log = await apiLog(root);
  assert.match(log, /unclassified_request_error/);
  assert.match(log, /reading 'match'/, "the operator-facing log keeps the real message");
});

test("a RangeError answers 500 instead of 400 from 'Invalid array length'", async (context) => {
  const { port, root } = await fixture(context);
  throwFromSettingsRoute(context, new RangeError("Invalid array length"));
  const response = await call(port, "GET", "/api/settings");
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { error: "Internal server error" });
  assert.match(await apiLog(root), /unclassified_request_error/);
});

test("an error carrying a system code is a fault even when its prose says 'cannot'", async (context) => {
  const { port, root } = await fixture(context);
  // `node:sqlite`, the filesystem and dependencies tag their failures this way.
  throwFromSettingsRoute(context, Object.assign(
    new Error("sqlite cannot start a transaction within a transaction"),
    { code: "ERR_SQLITE_ERROR" },
  ));
  const response = await call(port, "GET", "/api/settings");
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { error: "Internal server error" });
  assert.match(await apiLog(root), /unclassified_request_error/);
});

test("a typed ApiStatusError keeps its own status, code and message", async (context) => {
  const { port, root } = await fixture(context);
  // It carries a `code` too, so this pins the earlier typed branch: the new
  // internal-fault gate must not swallow it.
  throwFromSettingsRoute(context, new ApiStatusError(409, "The catalog is locked and cannot be read", "CATALOG_LOCKED"));
  const response = await call(port, "GET", "/api/settings");
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), { code: "CATALOG_LOCKED", error: "The catalog is locked and cannot be read" });
  assert.doesNotMatch(await apiLog(root), /unclassified_request_error/);
});

test("a legacy plain-Error validator still answers 400 with its own sentence", async (context) => {
  const { port, root } = await fixture(context);
  // The route's own plain `Error`, exactly like the store validators the list exists for.
  const response = await call(port, "POST", "/api/settings/clear-model-if-current", JSON.stringify({}));
  assert.equal(response.status, 400, "the legacy word list still names the caller's mistake");
  assert.deepEqual(JSON.parse(response.body), { error: "modelId is required" });
  assert.doesNotMatch(await apiLog(root), /unclassified_request_error/);
});

test("a body that is not JSON still answers 400 from the parser", async (context) => {
  const { port, root } = await fixture(context);
  const response = await call(port, "POST", "/api/settings/clear-model-if-current", "{");
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "Request body must be valid JSON" });
  assert.doesNotMatch(await apiLog(root), /unclassified_request_error/);
});
