// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { CustomMcpServers } from "./custom-servers.js";
import { decryptSecretValue, encryptSecretValue, loadOrCreateModelSecretKey } from "../store/secrets.js";
import { digest } from "../configuration/validation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const operation = () => ({ operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) });
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-metadata-authority-" + randomUUID()), registry = createMcpSourceRegistry(), state = { refreshes: 0 };
  const manager = new CustomMcpServers(root, registry, () => undefined, async () => { state.refreshes++; }); await manager.load();
  context.after(async () => { assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const server = await manager.save({ name: "Owned STDIO metadata", description: "Initial", transport: "stdio", enabled: true, command: "owned-must-never-execute", args: ["--owned"], cwd: root, env: { OWNED_SECRET: "synthetic-env" }, timeoutSeconds: 37 });
  manager.applyCatalog({ loadedAt: new Date().toISOString(), revision: "owned-tools", servers: [{ id: server.id, transport: "stdio", enabled: true, tools: [{ name: "owned_echo", description: "Owned", inputSchema: { type: "object", properties: {} }, schemaHash: "owned" }] }] });
  return { root, registry, manager, state, server };
}

test("CFG-X03a: metadata writes preserve transport/auth/tool state and perform no refresh or STDIO execution", async context => {
  const h = await harness(context), before = h.manager.transportConfig().servers[h.server.id]!, details = h.manager.list().find(item => item.id === h.server.id)!, refreshes = h.state.refreshes, version = h.manager.configurationMetadata(h.server.id).version!, op = operation();
  const saved = await h.manager.submitConfigurationMetadata(op, h.server.id, version, { name: "Renamed 服务", description: "Updated description" }); assert.equal(saved.status, "applied"); assert.equal(h.state.refreshes, refreshes);
  const next = h.manager.transportConfig().servers[h.server.id]!; assert.equal(h.manager.configurationMetadata(h.server.id).current?.name, "Renamed 服务"); assert.equal(next.description, "Updated description"); for (const field of ["command", "args", "cwd", "env", "headers", "enabled", "transport", "toolCallTimeoutSeconds"] as const) assert.deepEqual(next[field], before[field]);
  assert.equal(h.manager.list().find(item => item.id === h.server.id)?.authMode, details.authMode); assert.deepEqual(h.manager.list().find(item => item.id === h.server.id)?.oauth, details.oauth);
  assert.deepEqual(h.manager.list().find(item => item.id === h.server.id)?.tools, details.tools); assert.equal(h.manager.list().find(item => item.id === h.server.id)?.status, "ready");
  assert.doesNotMatch(JSON.stringify(h.manager.configurationMetadata(h.server.id)), /synthetic-env|owned-must-never-execute/u);
  assert.deepEqual(await h.manager.submitConfigurationMetadata(op, h.server.id, version, { name: "Renamed 服务", description: "Updated description" }), saved); assert.deepEqual(await h.manager.resolveConfigurationMetadata(op), saved);
});

test("CFG-X03a: a negative authority resolution persists a tombstone that fences a late submit across restart", async context => {
  const h = await harness(context), op = operation(), before = h.manager.configurationMetadata(h.server.id), rejected = await h.manager.resolveConfigurationMetadata(op); assert.equal(rejected.status, "rejected");
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => { throw new Error("No refresh"); }); await reloaded.load();
  assert.deepEqual(await reloaded.submitConfigurationMetadata(op, h.server.id, before.version!, { name: "Late update" }), rejected); assert.deepEqual(reloaded.configurationMetadata(h.server.id), before);
});

test("CFG-X03a: stale resource/auth version, duplicate names and unregistered executable fields are rejected durably", async context => {
  const h = await harness(context), old = h.manager.configurationMetadata(h.server.id).version!, other = await h.manager.save({ name: "Other", transport: "http", url: "http://127.0.0.1:1/mcp", enabled: false });
  assert.equal(h.manager.configurationMetadata(h.server.id).version, old, "Unrelated service editing must not invalidate selected metadata");
  let result = await h.manager.submitConfigurationMetadata(operation(), h.server.id, old, { name: other.name }); assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.code, "MCP_METADATA_NAME_CONFLICT");
  result = await h.manager.submitConfigurationMetadata(operation(), h.server.id, old, { command: "forbidden" }); assert.equal(result.status, "rejected");
  await h.manager.save({ ...h.manager.list().find(item => item.id === h.server.id)!, env: { OWNED_SECRET: "synthetic-rotated" } }, h.server.id);
  const staleOperation = operation(); result = await h.manager.submitConfigurationMetadata(staleOperation, h.server.id, old, { name: "Stale rename" }); assert.equal(result.status, "rejected"); if (result.status === "rejected") assert.equal(result.code, "RESOURCE_VERSION_CONFLICT"); assert.deepEqual(await h.manager.resolveConfigurationMetadata(staleOperation), result);
});

test("CFG-X03a: old encrypted servers-only files load and migrate on write, retaining bound receipts after reload", async context => {
  const h = await harness(context), key = await loadOrCreateModelSecretKey(resolve(h.root, "model-secrets.key")), file = resolve(h.root, "custom-mcp-servers.enc"), saved = JSON.parse(decryptSecretValue(key, "custom-mcp-servers", await readFile(file, "utf8")));
  assert.equal(saved.format, undefined, "Ordinary saves without operation receipts retain the legacy format");
  await writeFile(file, encryptSecretValue(key, "custom-mcp-servers", JSON.stringify(saved)));
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => { throw new Error("Metadata must not refresh"); }); await reloaded.load(); const op = operation(); const result = await reloaded.submitConfigurationMetadata(op, h.server.id, reloaded.configurationMetadata(h.server.id).version!, { description: "Migrated metadata" }); assert.equal(result.status, "applied");
  const again = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await again.load(); assert.deepEqual(await again.resolveConfigurationMetadata(op), result); assert.equal(again.configurationMetadata(h.server.id).current?.description, "Migrated metadata");
  const disk = await readFile(file, "utf8"); assert.doesNotMatch(disk, /synthetic-env|Migrated metadata/u);
});

test("CFG-X03a: failure after atomic rename retains the authoritative saved receipt rather than reporting an unsaved mutation", async context => {
  const h = await harness(context), op = operation(), upsert = h.registry.upsert.bind(h.registry); h.registry.upsert = () => { throw new Error("synthetic post-commit callback failure"); };
  await assert.rejects(h.manager.submitConfigurationMetadata(op, h.server.id, h.manager.configurationMetadata(h.server.id).version!, { description: "Committed before callback" })); h.registry.upsert = upsert;
  assert.equal((await h.manager.resolveConfigurationMetadata(op)).status, "applied", "Reconciliation retries only in-memory metadata publication, never the configuration write or catalog discovery");
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await reloaded.load(); assert.equal((await reloaded.resolveConfigurationMetadata(op)).status, "applied"); assert.equal(reloaded.configurationMetadata(h.server.id).current?.description, "Committed before callback");
});

test("CFG-X03a: operation identity/binding mismatch cannot overwrite an existing authority receipt", async context => {
  const h = await harness(context), op = operation(), first = await h.manager.resolveConfigurationMetadata(op); await assert.rejects(h.manager.resolveConfigurationMetadata({ ...op, bindingDigest: digest("different") })); assert.deepEqual(await h.manager.resolveConfigurationMetadata(op), first);
  await assert.rejects(h.manager.resolveConfigurationMetadata({ operationId: "__proto__", bindingDigest: op.bindingDigest }));
});
