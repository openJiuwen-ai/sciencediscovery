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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, closeApiServer } from "../http/index.js";
import { loadServerConfig, repositoryRoot } from "../bootstrap/config.js";
import { createPlatformServices } from "../bootstrap/platform.js";

test("public status/init require API auth; uninitialized Tasks/API paths refuse with no sidecar transport", async () => {
  const data = await mkdtemp(join(tmpdir(), "evolve-api-test-"));
  const original = globalThis.fetch; let origin = ""; let sidecarRequests = 0;
  globalThis.fetch = async (url, init) => {
    if (origin && String(url).startsWith(origin + "/")) return original(url, init);
    sidecarRequests++; throw new Error("Unexpected outbound fixture request");
  };
  const config = loadServerConfig({ SCIENCE_AGENT_AUTH_TOKEN: "synthetic-access", SCIENCE_AGENT_RUNNER_TOKEN: "synthetic-runner", SCIENCE_AGENT_DATA_DIR: data,
    SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_PORT: "0" });
  const server = createApiServer(config);
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const path of ["status", "init"]) assert.equal((await fetch(`${origin}/api/evolve/${path}`, { method: path === "init" ? "POST" : "GET" })).status, 401);
    const headers = { authorization: "Bearer synthetic-access" };
    const status = await fetch(`${origin}/api/evolve/status`, { headers });
    assert.deepEqual(await status.json(), { state: "not_initialized", canInitialize: false });
    assert.deepEqual(await (await fetch(`${origin}/api/evolve/init`, { headers, method: "POST" })).json(), { state: "not_initialized", canInitialize: false });
    // Idea Tree is independent and reports its own unavailable service.
    assert.equal((await fetch(`${origin}/api/settings/idea-tree`, { headers })).status, 503);
    const before = sidecarRequests;
    for (const path of ["/api/evolve/runs", "/api/evolve/runs/fake/stop"]) {
      const response = await fetch(origin + path, { headers });
      assert.equal(response.status, 503); assert.match(await response.text(), /not initialized/);
    }
    assert.equal(sidecarRequests, before);
  } finally { await closeApiServer(server); globalThis.fetch = original; await rm(data, { recursive: true, force: true }); }
});
test("native Evolve/research tools are absent until the launcher reports authenticated readiness", async () => {
  const data = await mkdtemp(join(tmpdir(), "evolve-native-test-")); const original = globalThis.fetch;
  let ready = false;
  globalThis.fetch = async () => Response.json({ state: ready ? "ready" : "not_initialized", canInitialize: true,
    ...(ready ? { connection: { url: "http://owned.invalid", internalToken: "synthetic-owned" } } : {}) });
  const config = loadServerConfig({ SCIENCE_AGENT_AUTH_TOKEN: "synthetic", SCIENCE_AGENT_RUNNER_TOKEN: "synthetic", SCIENCE_AGENT_DATA_DIR: data,
    SCIENCE_AGENT_EVOLVE_CONTROL_URL: "http://launcher.invalid", SCIENCE_AGENT_EVOLVE_CONTROL_TOKEN: "synthetic-control" });
  const platform = createPlatformServices(config, repositoryRoot, {});
  try {
    await platform.evolveAvailability.refresh();
    assert.equal(platform.evolveRuntimeFactory({} as never), undefined);
    ready = true; await platform.evolveAvailability.refresh();
    const runtime = platform.evolveRuntimeFactory({} as never)!;
    assert(runtime.createEvolveRun);
    ready = false;
    await assert.rejects(runtime.createEvolveRun({} as never), /not initialized/); await platform.evolveAvailability.refresh();
    assert.equal(platform.evolveRuntimeFactory({} as never), undefined);
  } finally { platform.ideaResearch.close(); globalThis.fetch = original; await rm(data, { recursive: true, force: true }); }
});
