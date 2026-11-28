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
import { closeApiServer, createApiServer } from "./index.js";

/** The control API on a real socket, with the operational log under `root`. */
async function fixture(context: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "sandbox-network-settings-"));
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

function put(port: number, body: unknown): Promise<{ status: number; body: string }> {
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
        method: "PUT",
        path: "/api/sandbox-network-settings",
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

/** The event the team watches for real server faults must stay quiet. */
async function assertNoUnclassifiedFault(root: string) {
  const log = await readFile(resolve(root, "logs", "api.log"), "utf8").catch(() => "");
  assert.doesNotMatch(log, /unclassified_request_error/);
}

/** A rejected save is the caller's mistake: 400 and the store's own sentence. */
async function assertRejected(context: TestContext, body: unknown, message: string) {
  const { port, root } = await fixture(context);
  const response = await put(port, body);
  assert.equal(response.status, 400, "the store refused the body as client input");
  assert.deepEqual(JSON.parse(response.body), { error: message });
  await assertNoUnclassifiedFault(root);
}

test("an empty domain allowlist answers 400 with the store's sentence", async (context) => {
  await assertRejected(
    context,
    { allowedDomains: [], mode: "domain-allowlist" },
    "Sandbox network mode domain-allowlist requires at least one allowed domain",
  );
});

test("open mode with allowed domains answers 400 with the store's sentence", async (context) => {
  await assertRejected(
    context,
    { allowedDomains: ["a.example.org"], mode: "open" },
    "Sandbox network mode open does not use allowed domains; remove them or use domain-allowlist",
  );
});

test("an unknown setting answers 400 with the store's sentence", async (context) => {
  await assertRejected(context, { proxyUrl: "http://x" }, "Unknown sandbox network setting: proxyUrl");
});

test("a valid body still answers 200 with the normalized settings", async (context) => {
  const { port, root } = await fixture(context);
  const response = await put(port, { allowedDomains: ["B.example.org", "a.example.org"], mode: "domain-allowlist" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    allowPrivateNetwork: false,
    allowedDomains: ["a.example.org", "b.example.org"],
    egressProxyPolicy: "inherit",
    mode: "domain-allowlist",
  });
  await assertNoUnclassifiedFault(root);
});

test("a persistence fault in the same save still answers 500 and stays logged", async (context) => {
  // Only the validation is tagged: a catalog write failure in the same route
  // must keep the generic 500 and the event the team watches for real faults.
  const { port, root } = await fixture(context);
  const original = SessionStore.prototype.replaceSandboxNetworkSettings;
  SessionStore.prototype.replaceSandboxNetworkSettings = (async () => {
    throw new Error("Catalog database is not initialized");
  }) as typeof SessionStore.prototype.replaceSandboxNetworkSettings;
  context.after(() => {
    SessionStore.prototype.replaceSandboxNetworkSettings = original;
  });
  const response = await put(port, { mode: "open" });
  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(response.body), { error: "Internal server error" });
  const log = await readFile(resolve(root, "logs", "api.log"), "utf8").catch(() => "");
  assert.match(log, /unclassified_request_error/);
});
