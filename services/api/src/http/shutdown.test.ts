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
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { McpCatalog } from "@sciencediscovery/schema";
import type { McpTransportClient } from "@sciencediscovery/data-source";

import { createApiServer } from "./index.js";

const emptyCatalog: McpCatalog = { loadedAt: "test", revision: "test", servers: [] };

/**
 * Regression: the platform warm-up spawns stdio MCP subprocesses and starts
 * the KE job runner's 1s poll chain; if server close does not tear both down,
 * their handles keep every process that boots this server alive forever
 * (observed as `node --test` files passing all assertions but never exiting).
 * The transport is injectable, so the wiring is asserted at that seam.
 */
test("server close tears down the platform MCP transport sessions", async (context) => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "sd-shutdown-"));
  context.after(() => import("node:fs/promises").then(({ rm }) => rm(dataDir, { force: true, recursive: true })));
  await mkdir(resolve(dataDir, "web"), { recursive: true });
  await writeFile(resolve(dataDir, "paper-worker.py"), "# stub\n");

  let closed = 0;
  const transport: McpTransportClient = {
    async catalog() { return emptyCatalog; },
    async close() { closed += 1; },
    async invoke() { throw new Error("no MCP calls in the shutdown wiring test"); },
    async reload() { return emptyCatalog; },
  };

  const server = createApiServer({
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(dataDir, "model-catalog/absent.json"),
    paperPythonPath: resolve(dataDir, "paper-python"),
    paperWorkerPath: resolve(dataDir, "paper-worker.py"),
    permissionWaitTimeoutMs: 0,
    port: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-token",
    runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(dataDir, "ssh-config"),
    staticDir: resolve(dataDir, "web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:17674", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:4313", internalToken: "test" },
  }, { mcpTransport: transport });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Ensure the platform initialized (the MCP warm-up runs during init).
  const response = await fetch(`${origin}/api/settings`, { headers: { authorization: "Bearer test-token" } });
  await response.arrayBuffer();
  assert.equal(response.status, 200);

  assert.equal(closed, 0, "transport must not be closed while the server runs");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  assert.equal(closed, 1, "server close must tear down the platform MCP sessions");
});
