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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { McpSourceCatalog, McpGovernanceBroker } from "@sciencediscovery/data-source";
import { CustomMcpServers, normalizeCustomMcpConfig } from "./custom-servers.js";
import { McpNodeClient } from "./node-client.js";
import { SessionStore } from "../store.js";
import { inspectMcpTool } from "./inspector.js";
import type { McpCatalog } from "@sciencediscovery/schema";
import { apiLog } from "../logging.js";

const fixture = fileURLToPath(new URL("../../../../test/fixtures/mcp-echo.mjs", import.meta.url));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("custom MCP mutations do not wait for the full catalog refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "custom-mcp-background-"));
  const gate = deferred();
  let refreshCalls = 0;
  const manager = new CustomMcpServers(
    dir,
    createMcpSourceRegistry(),
    () => undefined,
    () => {
      refreshCalls += 1;
      return gate.promise;
    },
  );
  try {
    await manager.load();
    const saved = await manager.save({ name: "Disabled server", transport: "http", url: "http://127.0.0.1/mcp", enabled: false });
    assert.equal(refreshCalls, 1);
    await manager.remove(manager.list()[0]!.id);
    assert.equal(refreshCalls, 1);
    assert.equal(saved.status, "disabled");
  } finally {
    gate.resolve();
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom MCP testing probes through the server's effective proxy policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "custom-mcp-proxy-"));
  const proxy = { mode: "url" as const, url: "http://127.0.0.1:18080" };
  const manager = new CustomMcpServers(
    dir,
    createMcpSourceRegistry(),
    () => undefined,
    async () => undefined,
    async () => undefined,
    () => proxy,
  );
  const originalReload = McpNodeClient.prototype.reload;
  const originalClose = McpNodeClient.prototype.close;
  let capturedProxy: unknown;
  try {
    McpNodeClient.prototype.reload = (async function (this: McpNodeClient, proxies: Record<string, unknown>) {
      capturedProxy = proxies;
      return { loadedAt: new Date(0).toISOString(), revision: "", servers: [{ id: "custom-000000000000", enabled: true, transport: "http", tools: [] }] };
    }) as typeof McpNodeClient.prototype.reload;
    McpNodeClient.prototype.close = async () => undefined;
    await manager.load();
    const saved = await manager.save({ name: "Proxied server", transport: "http", url: "http://127.0.0.1/mcp", enabled: false });
    const tested = await manager.test(saved.id);
    assert.equal(tested.enabled, false);
    assert.equal(tested.error, undefined);
    assert.ok(String(saved.id).startsWith("custom-"));
    assert.deepEqual(capturedProxy, { [saved.id]: proxy });
  } finally {
    McpNodeClient.prototype.reload = originalReload;
    McpNodeClient.prototype.close = originalClose;
    await rm(dir, { recursive: true, force: true });
  }
});

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
  const catalog = new McpSourceCatalog(registry, client, undefined, (snapshot) => manager.applyCatalog(snapshot), undefined,
    () => manager.discoveryRevision());
  await manager.load();
  await store.load();
  return { dir, registry, store, manager, client, catalog, close: async () => { await manager.close(); await client.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("saving an enabled MCP discovers tools without a separate connection test", async () => {
  const f = await setup();
  try {
    const saved = await f.manager.save({ name: "Background echo", command: process.execPath, args: [fixture], enabled: true });
    assert.equal(saved.status, "untested");
    for (let attempt = 0; f.manager.list()[0]?.status === "untested" && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.manager.list()[0]?.status, "ready");
    assert.equal(Object.keys(f.registry.get(saved.id).manifest.tools).length, 2);
  } finally { await f.close(); }
});

test("background discovery failure is redacted and a later save recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "custom-mcp-recovery-"));
  let fail = true;
  const manager = new CustomMcpServers(dir, createMcpSourceRegistry(), () => undefined, async () => {
    if (fail) throw new Error("Failed Bearer private-fixture-secret at http://127.0.0.1/private");
    manager.applyCatalog({ loadedAt: new Date().toISOString(), revision: "ready", servers: manager.list().map((item) => ({ id: item.id, enabled: true, tools: [], transport: "http" })) });
  });
  try {
    await manager.load();
    const saved = await manager.save({ name: "Recovery", url: "http://127.0.0.1/private", headers: { Authorization: "Bearer private-fixture-secret" }, enabled: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.list()[0]?.status, "error");
    assert.doesNotMatch(manager.list()[0]?.error ?? "", /private-fixture-secret|\/private/);
    fail = false;
    await manager.save(saved, saved.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.list()[0]?.status, "ready");
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a catalog captured before a configuration edit cannot repopulate cleared tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "custom-mcp-stale-"));
  const gate = deferred();
  const registry = createMcpSourceRegistry();
  let snapshot!: McpCatalog;
  let calls = 0;
  const manager = new CustomMcpServers(dir, registry, () => undefined, () => catalog.reload());
  const catalog = new McpSourceCatalog(registry, {
    catalog: async () => snapshot,
    reload: async () => { calls += 1; await gate.promise; return snapshot; },
    invoke: async () => { throw new Error("unused"); },
  }, undefined, (value) => manager.applyCatalog(value), undefined, () => manager.discoveryRevision());
  try {
    await manager.load();
    const saved = await manager.save({ name: "Edited", url: "http://127.0.0.1/old", enabled: true });
    snapshot = { loadedAt: new Date().toISOString(), revision: "old", servers: [{ id: saved.id, enabled: true, transport: "http", tools: [{ name: "old", description: "old", inputSchema: { type: "object" }, schemaHash: "old" }] }] };
    assert.equal(calls, 1);
    await manager.save({ ...saved, url: "http://127.0.0.1/new" }, saved.id);
    // 关闭后只排空正在执行的旧刷新，不执行排队的新刷新，以观察旧结果是否被拒绝。
    const closing = manager.close();
    gate.resolve();
    await closing;
    assert.equal(manager.list()[0]?.status, "untested");
    assert.equal(Object.keys(registry.get(saved.id).manifest.tools).length, 0);
  } finally { gate.resolve(); await manager.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const fault of ["invalid JSON", "missing file", "unreadable file"] as const) {
  test(`background snapshot failure (${fault}) is observable and a later save recovers`, async () => {
    const f = await setup();
    const path = join(f.dir, "extensions.json");
    const previous = process.env.SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH;
    try {
      await writeFile(path, "{}");
      process.env.SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH = path;
      if (fault === "invalid JSON") await writeFile(path, "{");
      else {
        await rm(path);
        if (fault === "unreadable file") await mkdir(path);
      }
      const saved = await f.manager.save({ name: "Recover snapshot", command: process.execPath, args: [fixture], enabled: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.manager.list()[0]?.status, "error");
      assert.ok(f.manager.list()[0]?.error);
      await rm(path, { recursive: true, force: true }); await writeFile(path, "{}");
      await f.manager.save(saved, saved.id);
      for (let attempt = 0; f.manager.list()[0]?.status === "untested" && attempt < 300; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(f.manager.list()[0]?.status, "ready");
      assert.equal(f.manager.list()[0]?.tools.length, 2);
    } finally {
      if (previous === undefined) delete process.env.SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH;
      else process.env.SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH = previous;
      await f.close();
    }
  });
}

test("an error in background failure reporting cannot poison later refreshes", async context => {
  const f = await setup();
  let fail = true;
  const original = f.manager.discoveryRevision.bind(f.manager);
  context.mock.method(f.manager, "discoveryRevision", () => {
    if (fail) throw new Error("broken configuration");
    return original();
  });
  context.mock.method(apiLog, "warn", () => { if (fail) throw new Error("broken log sink"); });
  try {
    const saved = await f.manager.save({ name: "Recover logging", command: process.execPath, args: [fixture], enabled: true });
    await new Promise(resolve => setImmediate(resolve));
    fail = false;
    await f.manager.save(saved, saved.id);
    for (let attempt = 0; f.manager.list()[0]?.status === "untested" && attempt < 300; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.manager.list()[0]?.status, "ready");
  } finally { await f.close(); }
});

test("custom stdio tools are discovered, authorized, invoked, audited and retained after restart", async () => {
  const f = await setup();
  try {
    const saved = await f.manager.save({ name: "Local echo", transport: "stdio", command: process.execPath, args: [fixture], enabled: true, env: { PRIVATE_TEST: "fixture-secret-value" } });
    const tested = await f.manager.test(saved.id);
    assert.equal(tested.status, "ready");
    assert.equal(tested.tools.length, 2);
    assert.deepEqual(tested.env, { PRIVATE_TEST: null });
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
    const brokenTest = await f.manager.test(broken.id);
    assert.equal(brokenTest.status, "error");
    assert.match(brokenTest.error!, /ENOENT/);
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
      const tested = await f.manager.test(saved.id);
      assert.equal(tested.status, "ready", tested.error ?? "");
      assert.equal(tested.tools.length, 2);
      assert.deepEqual(tested.headers, { Authorization: null });
      const broken = await f.manager.save({ ...base, headers: { Authorization: "wrong-fixture-secret" } }, saved.id);
      const brokenTest = await f.manager.test(broken.id);
      assert.equal(brokenTest.status, "error");
      assert.ok(!brokenTest.error!.includes("wrong-fixture-secret"));
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

for (const field of ["env", "headers"] as const) {
  test(`${field}: retaining secrets is keyed by original name and invalid renames are atomic`, async () => {
    const f = await setup();
    try {
      const config = field === "env" ? { command: process.execPath } : { transport: "http", url: "http://127.0.0.1/mcp" };
      const saved = await f.manager.save({ name: "Secret retention", ...config, enabled: false, [field]: { ORIGINAL: "synthetic-secret" } });
      await f.manager.save({ ...saved, [field]: { ORIGINAL: null } }, saved.id);
      const values = () => f.manager.transportConfig().servers[saved.id]![field];
      assert.deepEqual(values(), { ORIGINAL: "synthetic-secret" });
      await assert.rejects(f.manager.save({ ...saved, [field]: { RENAMED: null } }, saved.id), /Invalid/);
      assert.deepEqual(values(), { ORIGINAL: "synthetic-secret" });
      await f.manager.save({ ...saved, [field]: { RENAMED: "synthetic-replacement" } }, saved.id);
      assert.deepEqual(values(), { RENAMED: "synthetic-replacement" });
      const restored = new CustomMcpServers(f.dir, createMcpSourceRegistry(), () => undefined, async () => undefined);
      await restored.load();
      assert.deepEqual(restored.transportConfig().servers[saved.id]![field], { RENAMED: "synthetic-replacement" });
    } finally { await f.close(); }
  });
}
