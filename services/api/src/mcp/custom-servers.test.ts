// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { McpSourceCatalog, McpGovernanceBroker } from "@sciencediscovery/data-source";
import { CustomMcpServers, normalizeCustomMcpConfig } from "./custom-servers.js";
import { McpNodeClient } from "./node-client.js";
import { SessionStore } from "../store.js";
import { inspectMcpTool } from "./inspector.js";

const fixture = fileURLToPath(new URL("../../../../test/fixtures/mcp-echo.mjs", import.meta.url));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "custom-mcp-"));
  const registry = createMcpSourceRegistry();
  const store = new SessionStore(dir);
  const manager = new CustomMcpServers(dir, registry, (ids) => store.setCustomConnectorIds(ids), () => catalog.refresh(), (id) => store.removeCustomConnectorReferences(id));
  const client = new McpNodeClient(() => {
    const config = manager.transportConfig();
    // Isolate this integration test from bundled Python servers and external providers.
    return { ...config, servers: Object.fromEntries(Object.entries(config.servers).filter(([id]) => id.startsWith("custom-"))) };
  });
  const catalog = new McpSourceCatalog(registry, client, undefined, (snapshot) => manager.applyCatalog(snapshot));
  await manager.load();
  await store.load();
  return { dir, registry, store, manager, client, catalog, close: async () => { await client.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("custom stdio tools are discovered, authorized, invoked, audited and retained after restart", async () => {
  const f = await setup();
  try {
    const saved = await f.manager.save({ name: "Local echo", transport: "stdio", command: process.execPath, args: [fixture], enabled: true, env: { PRIVATE_TEST: "fixture-secret-value" } });
    assert.equal(saved.status, "ready");
    assert.equal(saved.tools.length, 2);
    assert.deepEqual(saved.env, { PRIVATE_TEST: null });
    const persisted = await readFile(join(f.dir, "custom-mcp-servers.enc"), "utf8");
    assert.ok(!persisted.includes("fixture-secret-value"));
    assert.ok(!persisted.includes("Local echo"));
    const project = await f.store.createProject("MCP integration");
    const session = await f.store.createSession(project.id, "Use echo", { enabledConnectorIds: [saved.sourceId] }, {}, { allowUnconfiguredModel: true });
    const broker = new McpGovernanceBroker(f.dir, f.store, f.registry, f.catalog, f.client);
    const tool = Object.values(f.registry.get(saved.sourceId).manifest.tools).find((item) => item.mcpToolName === "echo")!;
    assert.ok(`mcp__${saved.sourceId}__${tool.id}`.length <= 64);
    let permissions = 0;
    const request = { input: { text: "mcp works" }, projectId: project.id, sessionId: session.id, sourceId: saved.sourceId, toolCallId: "echo-call", toolId: tool.id, turnId: "turn", authorize: async () => { permissions += 1; } };
    const first = await broker.invoke(request);
    assert.equal((first.result.data as { structuredContent: { echoed: string } }).structuredContent.echoed, "MCP WORKS");
    const second = await broker.invoke({ ...request, toolCallId: "echo-call-2" });
    assert.equal(second.invocation.cache.hit, false);
    assert.equal(permissions, 2);
    assert.equal((await f.store.listMcpInvocations(session.id)).length, 2);
    const inspection = await inspectMcpTool(saved.id, { sessionId: session.id, toolName: "add_numbers", input: { a: 2, b: 3 } }, { servers: f.manager, registry: f.registry, broker, store: f.store });
    assert.equal(inspection.ok, true);
    assert.ok(JSON.stringify(inspection.raw).includes("5"));
    assert.ok(inspection.invocationId);
    const failedInspection = await inspectMcpTool(saved.id, { sessionId: session.id, toolName: "echo", input: { text: "error" } }, { servers: f.manager, registry: f.registry, broker, store: f.store });
    assert.equal(failedInspection.ok, false);
    assert.match(failedInspection.error!, /Requested fixture error/);
    assert.equal((await f.store.listMcpInvocations(session.id)).length, 4);
    await assert.rejects(broker.invoke({ ...request, input: { text: 1 } }), /string/);
    await assert.rejects(broker.invoke({ ...request, allowedSourceIds: [] }), /not enabled/);
    await assert.rejects(broker.invoke({ ...request, input: { text: "error" } }), /Requested fixture error/);
    const disabled = await f.manager.save({ ...saved, enabled: false }, saved.id);
    assert.equal(disabled.status, "disabled");
    assert.equal(Object.keys(f.registry.get(saved.sourceId).manifest.tools).length, 0);
    await f.manager.save({ ...saved, name: "Renamed echo", enabled: true }, saved.id);
    assert.equal(f.manager.transportConfig().servers[saved.id]!.env.PRIVATE_TEST, "fixture-secret-value");
    const restoredStore = new SessionStore(f.dir);
    const restored = new CustomMcpServers(f.dir, createMcpSourceRegistry(), (ids) => restoredStore.setCustomConnectorIds(ids), async () => undefined);
    await restored.load();
    await restoredStore.load();
    assert.equal(restored.list()[0]!.name, "Renamed echo");
    assert.deepEqual(restoredStore.getSessionSettings(session.id).effective.enabledConnectorIds, [saved.sourceId]);
    await f.manager.remove(saved.id);
    assert.equal(f.registry.has(saved.sourceId), false);
    assert.equal(f.manager.list().length, 0);
    assert.deepEqual(f.store.getSessionSettings(session.id).effective.enabledConnectorIds, []);
  } finally { await f.close(); }
});

test("JSON import is atomic, disabled by default, and concurrent saves do not lose entries", async () => {
  const f = await setup();
  try {
    await assert.rejects(f.manager.import({ mcpServers: { valid: { command: process.execPath }, invalid: { type: "ftp", url: "ftp://localhost" } } }), /Unsupported/);
    assert.equal(f.manager.list().length, 0);
    const imported = await f.manager.import({ mcpServers: { echo: { command: process.execPath, args: [fixture], enabled: true } } });
    assert.equal(imported[0]!.enabled, false);
    assert.equal(imported[0]!.tools.length, 0);
    const tested = await f.manager.test(imported[0]!.id);
    assert.equal(tested.tools.length, 2);
    assert.equal(tested.enabled, false);
    await assert.rejects(f.manager.import({ mcpServers: { echo: { command: process.execPath } } }), /already exists/);
    await Promise.all([f.manager.save({ name: "A", command: process.execPath }), f.manager.save({ name: "B", command: process.execPath })]);
    assert.equal(f.manager.list().length, 3);
    const broken = await f.manager.save({ name: "Broken", command: "/nonexistent-mcp-command", enabled: true });
    assert.equal(broken.status, "error");
    assert.match(broken.error!, /ENOENT/);
  } finally { await f.close(); }
});

for (const transport of ["http", "sse"] as const) {
  test(`custom ${transport} supports authenticated tool discovery and connection failure feedback`, async () => {
    const f = await setup();
    const child = spawn(process.execPath, [fixture, `--${transport}`, "0"], { env: { ...process.env, MCP_FIXTURE_AUTH: "Bearer fixture-only" }, stdio: ["ignore", "ignore", "pipe"] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture startup timeout")), 10_000);
        child.once("error", reject);
        child.stderr.once("data", (data) => { clearTimeout(timer); try { resolve(JSON.parse(String(data)).port); } catch (error) { reject(error); } });
      });
      const base = { name: transport, transport, url: `http://127.0.0.1:${port}/${transport === "sse" ? "sse" : "mcp"}`, enabled: true, headers: { Authorization: "Bearer fixture-only" } };
      const saved = await f.manager.save(base);
      assert.equal(saved.status, "ready", saved.error ?? "");
      assert.equal(saved.tools.length, 2);
      assert.deepEqual(saved.headers, { Authorization: null });
      const broken = await f.manager.save({ ...base, headers: { Authorization: "wrong-fixture-secret" } }, saved.id);
      assert.equal(broken.status, "error");
      assert.ok(!broken.error!.includes("wrong-fixture-secret"));
    } finally { child.kill(); await f.close(); }
  });
}

test("custom configuration rejects malformed URLs, fields and secrets", () => {
  for (const value of [
    { name: "x", url: "file:///tmp/data" },
    { name: "x", url: "http://name:pass@localhost/mcp" },
    { name: "x", command: "node", args: "--help" },
    { name: "x", command: "node", timeoutSeconds: 0 },
    { name: "x", url: "http://localhost", headers: { Authorization: "a\nb" } },
  ]) assert.throws(() => normalizeCustomMcpConfig(value));
});
