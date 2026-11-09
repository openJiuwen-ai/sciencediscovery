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
import type { ConfigurationExternalOutcome } from "../configuration/types.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const operation = () => ({ operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) });
function metadataVersion(manager: CustomMcpServers, id: string): string { const version = manager.configurationMetadata(id).version; assert.ok(version); return version; }
function transportEntry(manager: CustomMcpServers, id: string) { const entry = manager.transportConfig().servers[id]; assert.ok(entry); return entry; }
function serverDetails(manager: CustomMcpServers, id: string) { const details = manager.list().find(item => item.id === id); assert.ok(details); return details; }
async function harness(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-metadata-authority-" + randomUUID()), registry = createMcpSourceRegistry(), state = { refreshes: 0 };
  const manager = new CustomMcpServers(root, registry, () => undefined, async () => { state.refreshes++; }); await manager.load();
  context.after(async () => { assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const server = await manager.save({ name: "Owned STDIO metadata", description: "Initial", transport: "stdio", enabled: true, command: "owned-must-never-execute", args: ["--owned"], cwd: root, env: { OWNED_SECRET: "synthetic-env" }, timeoutSeconds: 37 });
  manager.applyCatalog({ loadedAt: new Date().toISOString(), revision: "owned-tools", servers: [{ id: server.id, transport: "stdio", enabled: true, tools: [{ name: "owned_echo", description: "Owned", inputSchema: { type: "object", properties: {} }, schemaHash: "owned" }] }] });
  return { root, registry, manager, state, server };
}

test("CFG-X03a: metadata writes preserve transport/auth/tool state and perform no refresh or STDIO execution", async context => {
  const h = await harness(context), before = transportEntry(h.manager, h.server.id), details = serverDetails(h.manager, h.server.id), refreshes = h.state.refreshes, version = metadataVersion(h.manager, h.server.id), op = operation();
  const saved = await h.manager.submitConfigurationMetadata(op, h.server.id, version, { name: "Renamed 服务", description: "Updated description" }); assert.equal(saved.status, "applied"); assert.equal(h.state.refreshes, refreshes);
  const next = transportEntry(h.manager, h.server.id); assert.equal(h.manager.configurationMetadata(h.server.id).current?.name, "Renamed 服务"); assert.equal(next.description, "Updated description"); for (const field of ["command", "args", "cwd", "env", "headers", "enabled", "transport", "toolCallTimeoutSeconds"] as const) assert.deepEqual(next[field], before[field]);
  assert.equal(h.manager.list().find(item => item.id === h.server.id)?.authMode, details.authMode); assert.deepEqual(h.manager.list().find(item => item.id === h.server.id)?.oauth, details.oauth);
  assert.deepEqual(h.manager.list().find(item => item.id === h.server.id)?.tools, details.tools); assert.equal(h.manager.list().find(item => item.id === h.server.id)?.status, "ready");
  assert.doesNotMatch(JSON.stringify(h.manager.configurationMetadata(h.server.id)), /synthetic-env|owned-must-never-execute/u);
  assert.deepEqual(await h.manager.submitConfigurationMetadata(op, h.server.id, version, { name: "Renamed 服务", description: "Updated description" }), saved); assert.deepEqual(await h.manager.resolveConfigurationMetadata(op), saved);
});

test("CFG-X03a: a negative authority resolution persists a tombstone that fences a late submit across restart", async context => {
  const h = await harness(context), op = operation(), before = h.manager.configurationMetadata(h.server.id), rejected = await h.manager.resolveConfigurationMetadata(op); assert.equal(rejected.status, "rejected");
  assert.ok(before.version);
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => { throw new Error("No refresh"); }); await reloaded.load();
  assert.deepEqual(await reloaded.submitConfigurationMetadata(op, h.server.id, before.version, { name: "Late update" }), rejected); assert.deepEqual(reloaded.configurationMetadata(h.server.id), before);
});

test("CFG-X03a: stale resource/auth version, duplicate names and unregistered executable fields are rejected durably", async context => {
  const h = await harness(context), old = metadataVersion(h.manager, h.server.id), other = await h.manager.save({ name: "Other", transport: "http", url: "http://127.0.0.1:1/mcp", enabled: false });
  assert.equal(h.manager.configurationMetadata(h.server.id).version, old, "Unrelated service editing must not invalidate selected metadata");
  let result = await h.manager.submitConfigurationMetadata(operation(), h.server.id, old, { name: other.name }); assert.equal(result.status, "rejected"); if (result.status === "rejected") { assert.equal(result.code, "MCP_METADATA_NAME_CONFLICT"); }
  result = await h.manager.submitConfigurationMetadata(operation(), h.server.id, old, { command: "forbidden" }); assert.equal(result.status, "rejected");
  await h.manager.save({ ...serverDetails(h.manager, h.server.id), env: { OWNED_SECRET: "synthetic-rotated" } }, h.server.id);
  const staleOperation = operation(); result = await h.manager.submitConfigurationMetadata(staleOperation, h.server.id, old, { name: "Stale rename" }); assert.equal(result.status, "rejected"); if (result.status === "rejected") { assert.equal(result.code, "RESOURCE_VERSION_CONFLICT"); } assert.deepEqual(await h.manager.resolveConfigurationMetadata(staleOperation), result);
});

test("CFG-X03a: old encrypted servers-only files load and migrate on write, retaining bound receipts after reload", async context => {
  const h = await harness(context), key = await loadOrCreateModelSecretKey(resolve(h.root, "model-secrets.key")), file = resolve(h.root, "custom-mcp-servers.enc"), saved = JSON.parse(decryptSecretValue(key, "custom-mcp-servers", await readFile(file, "utf8")));
  assert.equal(saved.format, undefined, "Ordinary saves without operation receipts retain the legacy format");
  await writeFile(file, encryptSecretValue(key, "custom-mcp-servers", JSON.stringify(saved)));
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => { throw new Error("Metadata must not refresh"); }); await reloaded.load(); const op = operation(); const result = await reloaded.submitConfigurationMetadata(op, h.server.id, metadataVersion(reloaded, h.server.id), { description: "Migrated metadata" }); assert.equal(result.status, "applied");
  const again = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await again.load(); assert.deepEqual(await again.resolveConfigurationMetadata(op), result); assert.equal(again.configurationMetadata(h.server.id).current?.description, "Migrated metadata");
  const disk = await readFile(file, "utf8"); assert.doesNotMatch(disk, /synthetic-env|Migrated metadata/u);
});

test("CFG-X03a: failure after atomic rename retains the authoritative saved receipt rather than reporting an unsaved mutation", async context => {
  const h = await harness(context), op = operation(), upsert = h.registry.upsert.bind(h.registry); h.registry.upsert = () => { throw new Error("synthetic post-commit callback failure"); };
  await assert.rejects(h.manager.submitConfigurationMetadata(op, h.server.id, metadataVersion(h.manager, h.server.id), { description: "Committed before callback" })); h.registry.upsert = upsert;
  assert.equal((await h.manager.resolveConfigurationMetadata(op)).status, "applied", "Reconciliation retries only in-memory metadata publication, never the configuration write or catalog discovery");
  const reloaded = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await reloaded.load(); assert.equal((await reloaded.resolveConfigurationMetadata(op)).status, "applied"); assert.equal(reloaded.configurationMetadata(h.server.id).current?.description, "Committed before callback");
});

test("CFG-X03a: a full journal rejects new edits and deletions while preserving existing receipts", async context => {
  const h = await harness(context);
  const file = resolve(h.root, "custom-mcp-servers.enc");
  const key = await loadOrCreateModelSecretKey(resolve(h.root, "model-secrets.key"));
  const servers: unknown = JSON.parse(decryptSecretValue(key, "custom-mcp-servers", await readFile(file, "utf8")));
  const prior: ConfigurationExternalOutcome = { ...operation(), status: "applied", resourceVersions: { mcpMetadata: metadataVersion(h.manager, h.server.id) } };
  const operations = Object.fromEntries<ConfigurationExternalOutcome>(Array.from({ length: 9_999 }, () => {
    const rejected: ConfigurationExternalOutcome = { ...operation(), status: "rejected", code: "EXTERNAL_OPERATION_NOT_SAVED" };
    return [rejected.operationId, rejected];
  }));
  operations[prior.operationId] = prior;
  const disk = encryptSecretValue(key, "custom-mcp-servers", JSON.stringify({ format: "sciencediscovery-custom-mcp-v2", servers, operations }));
  await writeFile(file, disk);
  const reload = async () => {
    const manager = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined);
    await manager.load();
    return manager;
  };
  const manager = await reload();
  const edit = operation(), deletion = operation(), version = metadataVersion(manager, h.server.id);
  const rejection = (op: ReturnType<typeof operation>) => ({ ...op, status: "rejected", code: "MCP_CONFIGURATION_JOURNAL_FULL" });
  assert.deepEqual(await manager.submitConfigurationMetadata(edit, h.server.id, version, { name: "Must not save" }), rejection(edit));
  assert.deepEqual(await manager.submitConfigurationDeletion(deletion, h.server.id, version), rejection(deletion));
  const restarted = await reload();
  assert.deepEqual(await restarted.resolveConfigurationMetadata(edit), rejection(edit));
  assert.deepEqual(await restarted.resolveConfigurationMetadata(deletion), rejection(deletion));
  assert.deepEqual(await restarted.resolveConfigurationMetadata(prior), prior);
  assert.equal(metadataVersion(restarted, h.server.id), version);
  assert.equal(await readFile(file, "utf8"), disk);
});

test("CFG-X03a: operation identity/binding mismatch cannot overwrite an existing authority receipt", async context => {
  const h = await harness(context), op = operation(), first = await h.manager.resolveConfigurationMetadata(op); await assert.rejects(h.manager.resolveConfigurationMetadata({ ...op, bindingDigest: digest("different") })); assert.deepEqual(await h.manager.resolveConfigurationMetadata(op), first);
  await assert.rejects(h.manager.resolveConfigurationMetadata({ operationId: "__proto__", bindingDigest: op.bindingDigest }));
});

test("CFG-X03a: an empty operation journal persists the legacy bare custom-server map", async context => {
  const h = await harness(context);
  await h.manager.save({ name: "Owned STDIO metadata", description: "Still legacy", transport: "stdio", enabled: true, command: "owned-must-never-execute", args: ["--owned"], cwd: h.root, env: { OWNED_SECRET: null }, timeoutSeconds: 37 }, h.server.id);
  const key = await loadOrCreateModelSecretKey(resolve(h.root, "model-secrets.key"));
  const saved = JSON.parse(decryptSecretValue(key, "custom-mcp-servers", await readFile(resolve(h.root, "custom-mcp-servers.enc"), "utf8"))) as Record<string, unknown>;
  for (const field of ["format", "servers", "operations", "pendingDeletions"]) assert.equal(Object.hasOwn(saved, field), false, field);
  assert.ok(Object.keys(saved).length > 0);
  for (const id of Object.keys(saved)) assert.match(id, /^custom-[a-f0-9]{12}$/u);
  assert.equal((saved[h.server.id] as { description?: string }).description, "Still legacy");
});

test("CFG-X03a: the first deletion keeps the v3 envelope after no deletion is pending", async context => {
  const h = await harness(context);
  const deleted = await h.manager.submitConfigurationDeletion(operation(), h.server.id, metadataVersion(h.manager, h.server.id));
  assert.equal(deleted.status, "applied");
  const key = await loadOrCreateModelSecretKey(resolve(h.root, "model-secrets.key"));
  const readSaved = async () => JSON.parse(decryptSecretValue(key, "custom-mcp-servers", await readFile(resolve(h.root, "custom-mcp-servers.enc"), "utf8"))) as { format?: string; pendingDeletions?: Record<string, string>; servers?: Record<string, unknown> };
  const saved = await readSaved();
  assert.equal(saved.format, "sciencediscovery-custom-mcp-v3");
  assert.deepEqual(saved.pendingDeletions, {});
  assert.equal(saved.servers?.[h.server.id], undefined);
  const other = await h.manager.save({ name: "After deletion", transport: "stdio", command: "never-run", enabled: false });
  const again = await readSaved();
  assert.equal(again.format, "sciencediscovery-custom-mcp-v3");
  assert.deepEqual(again.pendingDeletions, {});
  assert.ok(again.servers?.[other.id]);
});

test("CFG-X03a: one unreadable journal row does not block loading the saved servers", async context => {
  const h = await harness(context);
  const key = await loadOrCreateModelSecretKey(resolve(h.root, "model-secrets.key"));
  const file = resolve(h.root, "custom-mcp-servers.enc");
  const servers = JSON.parse(decryptSecretValue(key, "custom-mcp-servers", await readFile(file, "utf8"))) as Record<string, unknown>;
  const kept: ConfigurationExternalOutcome = { ...operation(), status: "rejected", code: "EXTERNAL_OPERATION_NOT_SAVED" };
  const bad = operation();
  const short = operation();
  const operations: Record<string, unknown> = {
    [kept.operationId]: kept,
    [bad.operationId]: { ...bad, status: "archived", code: "FUTURE_STATUS" },
    [short.operationId]: { ...short, status: "applied", resourceVersions: { mcpMetadata: "abcd", extra: "field" } },
    "not-an-operation": { status: "applied" },
  };
  await writeFile(file, encryptSecretValue(key, "custom-mcp-servers", JSON.stringify({
    format: "sciencediscovery-custom-mcp-v3", servers, operations,
    pendingDeletions: { [bad.operationId]: h.server.id, "not-an-operation": "nope" },
  })));
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  const manager = new CustomMcpServers(h.root, createMcpSourceRegistry(), () => undefined, async () => undefined);
  try { await manager.load(); } finally { console.warn = original; }
  assert.equal(manager.configurationMetadata(h.server.id).current?.name, "Owned STDIO metadata");
  assert.deepEqual(await manager.resolveConfigurationMetadata(kept), kept);
  const version = metadataVersion(manager, h.server.id);
  const fence = (op: ReturnType<typeof operation>): ConfigurationExternalOutcome => ({ ...op, status: "rejected", code: "MCP_CONFIGURATION_JOURNAL_ROW_UNREADABLE" });
  assert.deepEqual(await manager.submitConfigurationMetadata(bad, h.server.id, version, { name: "Must not apply" }), fence(bad));
  assert.deepEqual(await manager.submitConfigurationMetadata(short, h.server.id, version, { description: "Must not apply" }), fence(short));
  assert.equal(manager.configurationMetadata(h.server.id).current?.name, "Owned STDIO metadata");
  assert.ok(warnings.some(line => line === `mcp_configuration_journal_row_unreadable: ${bad.operationId}`));
  assert.ok(warnings.some(line => line === `mcp_configuration_journal_row_unreadable: ${short.operationId}`));
  assert.ok(warnings.some(line => line === "mcp_configuration_journal_row_skipped: unrecognised-id"));
  assert.ok(warnings.some(line => line === `mcp_configuration_pending_deletion_skipped: ${bad.operationId}`));
  assert.ok(warnings.some(line => line === "mcp_configuration_pending_deletion_skipped: unrecognised-id"));
});
