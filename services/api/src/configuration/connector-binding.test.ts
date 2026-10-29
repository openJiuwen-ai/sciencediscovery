// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
import { CustomMcpServers } from "../mcp/custom-servers.js";
import { SessionStore } from "../store.js";
import { ConversationalConfigurationFramework } from "./framework.js";

async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, `connector-binding-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  const manager = new CustomMcpServers(root, createMcpSourceRegistry(), ids => store.setCustomConnectorIds(ids), async () => undefined);
  await manager.load();
  store.setConfigurationConnectorRevisionSource(ids => manager.configurationRevision(ids));
  const project = await store.createProject("Transport binding");
  const session = await store.createSession(project.id, "Binding", {}, {}, { allowUnconfiguredModel: true });
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  return { root, store, manager, session };
}

test("CFG-T23/31 connector approvals bind URL and header changes independently from unchanged tools", async context => {
  const f = await fixture(context);
  const input = { name: "Private fixture", transport: "http", enabled: false, url: "https://mcp.example.test/a", headers: { Authorization: "Bearer fixture-a" } };
  const saved = await f.manager.save(input);
  const original = f.manager.configurationRevision();
  assert.match(original, /^[a-f0-9]{64}$/); assert.ok(!original.includes("fixture-a"));
  await f.manager.save({ ...input, headers: { Authorization: "Bearer fixture-b" } }, saved.id);
  const headerChanged = f.manager.configurationRevision(); assert.notEqual(headerChanged, original);
  await f.manager.save({ ...input, url: "https://mcp.example.test/b", headers: { Authorization: "Bearer fixture-b" } }, saved.id);
  assert.notEqual(f.manager.configurationRevision(), headerChanged);
  assert.deepEqual(f.manager.list()[0]!.tools, [], "No probe or tool catalog change was needed to detect the transport change");
});

test("CFG-T23/31 OAuth vault revocation invalidates a pending connector grant without exposing token material", async context => {
  const f = await fixture(context);
  const saved = await f.manager.save({ name: "OAuth fixture", transport: "http", enabled: false, url: "https://mcp.example.test/oauth", authMode: "oauth" });
  const framework = new ConversationalConfigurationFramework(f.store, { nativeExecutor: true, connector: () => ({ name: "Offline OAuth fixture", ready: true }) });
  const proposal = await framework.propose(f.session.id, { protocolVersion: 3, capabilityId: "connector.enable", values: { connectorId: saved.id } });
  const before = f.manager.configurationRevision();
  await f.manager.oauth.clear(saved.id);
  assert.notEqual(f.manager.configurationRevision(), before, "Even revocation with identical public authorization status advances the encrypted vault generation");
  await assert.rejects(framework.decide(f.session.id, proposal.id, { revision: proposal.revision, previewDigest: proposal.previewDigest!, selectedOptionId: proposal.selectedOptionId, decision: "apply" }), { code: "RESOURCE_VERSION_CONFLICT" });
  assert.equal(f.store.getSessionSettings(f.session.id).effective.enabledConnectorIds.includes(saved.id), false);
});

test("CFG-T31 private transport and encrypted authorization generations are stable across manager reopen", async context => {
  const f = await fixture(context);
  const saved = await f.manager.save({ name: "Reopen fixture", transport: "http", enabled: false, url: "https://mcp.example.test/oauth", authMode: "oauth", oauth: { clientId: "fixture-id", clientSecret: "fixture-client-secret" } });
  await f.manager.oauth.clear(saved.id);
  const original = f.manager.configurationRevision();
  const reopened = new CustomMcpServers(f.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await reopened.load();
  assert.equal(reopened.configurationRevision(), original);
  assert.equal(reopened.list()[0]!.oauth?.clientSecret, null);
});

test("CFG-R01 actual scoped transport and OAuth generations ignore unrelated MCP resources", async context => {
  const f = await fixture(context);
  const source = await f.manager.save({ name: "Used", transport: "http", enabled: false,
    url: "https://used.example.test/mcp", authMode: "oauth" });
  const proof = () => f.store.configurationRuntimeVersions([source.id], {}, f.session.id);
  const original = proof();
  const unrelated = await f.manager.save({ name: "Unrelated", transport: "http", enabled: false, url: "https://other.example.test/mcp", authMode: "oauth" });
  await f.manager.oauth.clear(unrelated.id);
  assert.deepEqual(proof(), original);
  await f.manager.oauth.clear(source.id);
  const revoked = proof(); assert.notDeepEqual(revoked, original);
  const reopened = new CustomMcpServers(f.root, createMcpSourceRegistry(), () => undefined, async () => undefined); await reopened.load();
  assert.equal(reopened.configurationRevision([source.id]), f.manager.configurationRevision([source.id]));
  await f.manager.save({ name: "Used", transport: "http", enabled: false, url: "https://used.example.test/mcp",
    authMode: "oauth", headers: { "x-credential": "replacement" } }, source.id);
  assert.notDeepEqual(proof(), revoked);
});

test("CFG-R01 relevant live plugin revocation invalidates the frozen proof without binding unrelated preferences", async context => {
  const f = await fixture(context);
  const original = f.store.configurationRuntimeVersions(["pubmed"], {}, f.session.id);
  await f.store.replaceSessionSettings(f.session.id, { plugins: { "connector.arxiv": { enabled: false } } });
  assert.deepEqual(f.store.configurationRuntimeVersions(["pubmed"], {}, f.session.id), original);
  await f.store.replaceSessionSettings(f.session.id, { plugins: { "connector.pubmed": { enabled: false } } });
  assert.notDeepEqual(f.store.configurationRuntimeVersions(["pubmed"], {}, f.session.id), original);
});
