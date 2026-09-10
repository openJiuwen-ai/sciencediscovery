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
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import type { RemoteComputeClient } from "@sciencediscovery/executor";
import type { NpuInventory } from "@sciencediscovery/schema";

import type { ServerConfig } from "./bootstrap/config.js";
import { createApiServer } from "./http/index.js";
import { SessionStore } from "./store.js";

const inventory: NpuInventory = {
  capturedAt: new Date().toISOString(),
  supported: true,
  devices: [
    {
      chipName: "910B3", health: "OK", hostIndex: 0, sandboxUsable: false,
      sandboxUnusableReason: "NPU 0 cannot be opened inside the sandbox: dcmi model initialized failed, because the device is used. ret is -8020",
    },
    { chipName: "910B3", health: "OK", hostIndex: 4, sandboxUsable: true },
  ],
};

/**
 * Ticking a card on a registered Runner must consult that Runner, not a
 * connection record. `RemoteHostTarget.runnerStatus` is ephemeral state the
 * HTTP layer attaches while listing machines; it is never persisted, so the
 * stored host this test seeds carries none — exactly the state a freshly
 * started API is in. Reading it there would reject every card as "this machine
 * reports no Ascend NPU cards" and make the tick impossible to save.
 */
test("saving an NPU selection reads the Runner's current inventory, not a stored connection record", async (context) => {
  const root = resolve(process.cwd(), ".tmp", `npu-selection-api-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const seed = new SessionStore(root);
  seed.setAvailableSkillIds([]);
  await seed.load();
  const host = await seed.registerRemoteHost({
    alias: "npu-910b",
    connectionKind: "direct",
    endpoint: { host: "127.0.0.1", port: 4311, protocol: "http" },
    token: "runner-test-token",
  });
  assert.equal(host.runnerStatus, undefined, "a persisted machine carries no connection state");

  const consulted: string[] = [];
  const remoteCompute = {
    close: async () => undefined,
    runnerStatusWithResources: async (hostId: string) => {
      consulted.push(hostId);
      return { hostId, state: "ready", resources: { npu: inventory } };
    },
  } as unknown as RemoteComputeClient;
  const config: ServerConfig = {
    authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"),
    paperWorkerPath: resolve(root, "no-worker"), permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1",
    sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  const catalog = { loadedAt: new Date().toISOString(), revision: "npu-selection-test", servers: [] };
  const server = createApiServer(config, {
    remoteCompute,
    mcpTransport: {
      catalog: async () => catalog, reload: async () => catalog,
      invoke: async () => { throw new Error("No MCP in this test"); },
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (devices: number[]) => fetch(`${origin}/api/runners/${host.id}/npu-devices`, {
    body: JSON.stringify({ devices }),
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    method: "PUT",
  });

  const accepted = await put([4]);
  const acceptedBody = await accepted.text();
  assert.equal(accepted.status, 200, acceptedBody);
  assert.deepEqual(JSON.parse(acceptedBody), { devices: [4], runnerId: host.id });
  assert.deepEqual(consulted, [host.id], "the Runner itself decides which cards are selectable");

  // The Runner's verdict still governs: a card its probe refused is refused
  // here, with the driver's own words rather than a generic rejection.
  const refused = await put([0, 4]);
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /dcmi model initialized failed/u);

  const selections = await fetch(`${origin}/api/runners/npu`, { headers: { authorization: "Bearer test-token" } });
  assert.equal(selections.status, 200);
  assert.deepEqual((await selections.json() as { selections: Record<string, number[]> }).selections[host.id], [4]);
});
