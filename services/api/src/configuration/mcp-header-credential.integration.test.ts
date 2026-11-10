// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import type { ConfigurationRequestView, ConfigurationValues } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { CustomMcpServers } from "../mcp/custom-servers.js";
import { SessionStore } from "../store.js";
import { configurationFramework } from "./framework.js";
import { discoverConfiguration } from "./discovery.js";
import { isMcpCredentialHeader, isMcpHeaderCredentialValue } from "../mcp/header-credential-policy.js";
import { digest } from "./validation.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
const operation = () => ({ operationId: `${randomUUID()}:1:external_submit`, bindingDigest: digest(randomUUID()) });
function approval(card: ConfigurationRequestView) { assert.ok(card.previewDigest); return { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" as const }; }
async function harness(context: { after(action: () => Promise<void>): void }, url = "http://127.0.0.1:1/hidden-path?key=synthetic-url-secret") {
  const parent = resolve(process.cwd(), ".tmp"), root = resolve(parent, "mcp-header-credential-" + randomUUID()), store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
  const state = { refreshes: 0, submits: 0 }, registry = createMcpSourceRegistry(), manager = new CustomMcpServers(root, registry, ids => store.setCustomConnectorIds(ids), async () => { state.refreshes++; }); await manager.load();
  const server = await manager.save({ name: "Owned header credential", transport: "http", enabled: true, url, headers: { Authorization: "synthetic-old", authorization: "synthetic-alias", "X-Retained": "synthetic-retained", Host: "synthetic-transport" }, timeoutSeconds: 37 });
  manager.applyCatalog({ loadedAt: new Date().toISOString(), revision: "owned-tools", servers: [{ id: server.id, transport: "http", enabled: true, tools: [{ name: "owned_echo", description: "Owned", inputSchema: { type: "object", properties: {} }, schemaHash: "owned" }] }] });
  const project = await store.createProject("MCP credential"), session = await store.createSession(project.id, "Owned", {}, {}, { allowUnconfiguredModel: true });
  const submit = manager.submitConfigurationHeaderCredential.bind(manager); manager.submitConfigurationHeaderCredential = (...args) => { state.submits++; return submit(...args); };
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => undefined, mcpHeaderCredential: manager });
  const propose = (values: ConfigurationValues = { headerName: "AUTHORIZATION" }) => framework.propose(session.id, { protocolVersion: 3, capabilityId: "mcp.header_credential", values: { serverId: server.id, ...values } });
  const consent = (card: ConfigurationRequestView) => { assert.ok(card.endpointAuthorization); return framework.confirmEndpoint(session.id, card.id, { revision: card.revision, endpointTarget: card.endpointAuthorization.endpointTarget }); };
  const fill = async (card: ConfigurationRequestView, secret = "Bearer synthetic-new") => { const draft = await framework.provideCredential(session.id, card.id, { expectedRevision: card.revision, fieldId: "apiToken", secret }); return framework.preview(session.id, card.id, { expectedRevision: card.revision, values: { serverId: server.id, headerName: "authorization" }, selectedOptionId: "persist", credentialHandle: draft.handle }); };
  const source = () => manager.configurationHeaderCredential(JSON.stringify([server.id, "authorization"]));
  return { root, store, manager, registry, state, server, session, framework, propose, consent, fill, source };
}

test("CFG-X03g: independent recipient approval precedes exact secure input and manual global confirmation", async context => {
  const h = await harness(context); await h.store.updateSession(h.session.id, { autoApplyLowRiskConfiguration: true }); let card = await h.propose(); assert.equal(card.state, "collecting_input"); assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.endpointAuthorization?.status, "required"); assert.equal(card.verificationPlan.maxRequests, 0);
  await assert.rejects(h.framework.provideCredential(h.session.id, card.id, { expectedRevision: card.revision, fieldId: "apiToken", secret: "synthetic-new" }), { code: "ENDPOINT_CONSENT_REQUIRED", field: "serverId" });
  const invalid: ConfigurationValues[] = [{ apiToken: "ordinary-secret" }, { headers: "ordinary-secret" }, { baseUrl: "https://other.invalid" }, { headerName: "Host" }, { headerName: "Authorization " }, { tokenOptional: true }];
  for (const values of invalid) { await assert.rejects(h.propose(values), { code: "INVALID_CONFIGURATION_INPUT" }); }
  card = await h.fill(await h.consent(card)); assert.equal(card.state, "awaiting_confirmation"); await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card), undefined, "auto"), { code: "CONFIGURATION_AUTO_NOT_AUTHORIZED" }); assert.equal(h.state.submits, 0);
});

test("CFG-X03g: safe recipient binds hidden saved path/query and no model preset bypasses approval", async context => {
  for (const [url, classification] of [["http://public.invalid/mcp?key=synthetic-url-secret", "public_http"], ["http://10.0.0.1/mcp", "private_network"], ["https://api.openai.com/hidden-path?key=synthetic-url-secret", "public_https"]]) {
    const h = await harness(context, url); const card = await h.propose(); assert.equal(card.endpointAuthorization?.classification, classification); assert.equal(card.endpointAuthorization?.status, classification === "public_http" ? "blocked" : "required"); assert.doesNotMatch(JSON.stringify(card), /hidden-path|synthetic-url-secret|synthetic-old|synthetic-alias/u);
    await assert.rejects(h.framework.provideCredential(h.session.id, card.id, { expectedRevision: card.revision, fieldId: "apiToken", secret: "synthetic-new" }), { code: classification === "public_http" ? "ENDPOINT_CREDENTIAL_INSECURE" : "ENDPOINT_CONSENT_REQUIRED", field: "serverId" });
    if (classification === "public_http") { await assert.rejects(h.consent(card), { code: "ENDPOINT_CREDENTIAL_INSECURE", field: "serverId" }); }
  }
});

test("CFG-X03g: atomic replacement merges aliases, invalidates tools and replays without a probe or another encryption", async context => {
  const h = await harness(context), settings = h.store.getSessionSettings(h.session.id), file = resolve(h.root, "custom-mcp-servers.enc"), before = h.manager.transportConfig().servers[h.server.id], refreshes = h.state.refreshes;
  const card = await h.fill(await h.consent(await h.propose())), bytesBefore = await readFile(file, "utf8"); const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "needs_user_action"); assert.doesNotMatch(JSON.stringify(saved), /synthetic-new|synthetic-old|synthetic-url-secret/u);
  assert.deepEqual(h.manager.transportConfig().servers[h.server.id], { ...before, headers: { authorization: "Bearer synthetic-new", "X-Retained": "synthetic-retained", Host: "synthetic-transport" } }); assert.equal(h.manager.list()[0]?.tools.length, 0); assert.equal(h.manager.list()[0]?.status, "untested"); assert.deepEqual(h.store.getSessionSettings(h.session.id), settings); assert.equal(h.state.refreshes, refreshes);
  const bytes = await readFile(file, "utf8"); assert.notEqual(bytes, bytesBefore); await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(await readFile(file, "utf8"), bytes); assert.equal(h.state.submits, 1);
});

test("CFG-X03g: selected formal target changes invalidate both consent and old secure input", async context => {
  const h = await harness(context); let card = await h.fill(await h.consent(await h.propose())); const oldEndpoint = card.endpointAuthorization?.endpointTarget;
  await h.manager.save({ ...h.server, url: "http://127.0.0.1:2/new-hidden?key=synthetic-new-url" }, h.server.id); await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card)), { code: "RESOURCE_VERSION_CONFLICT" });
  card = await h.framework.preview(h.session.id, card.id, { expectedRevision: card.revision, values: { serverId: h.server.id, headerName: "authorization" }, selectedOptionId: "persist" }); assert.notEqual(card.endpointAuthorization?.endpointTarget, oldEndpoint); assert.equal(card.endpointAuthorization?.status, "required"); assert.equal(card.fields.find(field => field.kind === "credential")?.status, "missing"); assert.doesNotMatch(JSON.stringify(card), /new-hidden|synthetic-new-url/u);
  card = await h.fill(await h.consent(card)); assert.equal((await h.framework.decide(h.session.id, card.id, approval(card))).state, "applied");
});

test("CFG-X03g: invalid field values are rejected without trimming, interpolation or authority submission", async context => {
  for (const secret of [" synthetic ", "synthetic\r\ninjected: x", "synthetic\tvalue", "$UNREAD_HOST_SECRET", "\u00a0synthetic", "x".repeat(16385)]) {
    const h = await harness(context), card = await h.consent(await h.propose());
    if (secret.length > 16384) { await assert.rejects(h.fill(card, secret), { code: "INVALID_CONFIGURATION_CREDENTIAL" }); }
    else { const filled = await h.fill(card, secret), result = await h.framework.decide(h.session.id, filled.id, approval(filled)); assert.equal(result.state, "needs_fix"); }
    assert.equal(h.state.submits, 0); assert.ok(h.manager.transportConfig().servers[h.server.id]?.headers.Authorization === "synthetic-old");
  }
  assert.equal(isMcpHeaderCredentialValue("Bearer internal  spaces"), true); for (const name of ["Host", "Content-Length", "Proxy-Authorization", "Sec-Fetch-Site", "Mcp-Session-Id"]) { assert.equal(isMcpCredentialHeader(name), false); }
});

test("CFG-X03g: genuine pre-write failure preserves authority bytes and resolution fences late secret submission", async context => {
  const h = await harness(context), source = h.source(), op = operation(), file = resolve(h.root, "custom-mcp-servers.enc"), blocker = file + ".tmp", before = await readFile(file, "utf8"); assert.ok(source.version); await mkdir(blocker);
  await assert.rejects(h.manager.submitConfigurationHeaderCredential(op, source.target, source.version, "Bearer synthetic-new")); assert.equal(await readFile(file, "utf8"), before); assert.equal(h.manager.list()[0]?.status, "ready");
  assert.ok(blocker.startsWith(h.root + sep)); await rm(blocker, { recursive: true }); const rejected = await h.manager.resolveConfigurationMetadata(op); assert.equal(rejected.status, "rejected"); assert.deepEqual(await h.manager.submitConfigurationHeaderCredential(op, source.target, source.version, "Bearer synthetic-new"), rejected); assert.ok(h.manager.transportConfig().servers[h.server.id]?.headers.Authorization === "synthetic-old");
});

test("CFG-X03g: a lost response reconciles the saved secret through the authority receipt without re-upload", async context => {
  const h = await harness(context), submit = h.manager.submitConfigurationHeaderCredential.bind(h.manager), card = await h.fill(await h.consent(await h.propose())); h.manager.submitConfigurationHeaderCredential = async (...args) => { await submit(...args); throw new Error("synthetic private response"); };
  const saved = await h.framework.decide(h.session.id, card.id, approval(card)); assert.equal(saved.state, "applied"); assert.equal(h.state.submits, 1); assert.doesNotMatch(JSON.stringify(saved), /synthetic private response|synthetic-new/u);
});

test("CFG-X03g: a failed root receipt recovers without a surviving draft or another secret submission", async context => {
  const h = await harness(context), card = await h.fill(await h.consent(await h.propose())), save = h.framework.repository.saveReceipt.bind(h.framework.repository);
  h.framework.repository.saveReceipt = () => { throw new Error("synthetic root receipt failure"); }; await assert.rejects(h.framework.decide(h.session.id, card.id, approval(card))); assert.equal(h.framework.service.get(h.session.id, card.id).state, "applying");
  h.framework.repository.saveReceipt = save; h.framework.credentials.clearRequest(card.id);
  const job = h.framework.repository.getOutbox(`${card.id}:${card.revision}:external_submit`); assert.ok(job); job.payload.leaseUntil = 0; job.payload.nextAttemptAt = 0; h.framework.repository.updateOutbox(job); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "applied"); assert.equal(h.state.submits, 1); assert.ok(h.framework.repository.getReceipt(card.id, card.revision));
});

test("CFG-X03g: collection excludes OAuth/STDIO/unsupported headers; refusal and Stop cannot submit a key", async context => {
  const h = await harness(context), collecting = await h.propose({}); assert.equal(collecting.fields.some(field => field.kind === "credential"), false); let card = await h.framework.preview(h.session.id, collecting.id, { expectedRevision: collecting.revision, values: {}, selectedOptionId: "dismiss" }); await h.framework.decide(h.session.id, card.id, { ...approval(card), decision: "dismiss", selectedOptionId: "dismiss" });
  const oauth = await h.manager.save({ name: "Owned OAuth", transport: "http", enabled: false, url: "http://127.0.0.1:1/oauth", authMode: "oauth", headers: { "X-Key": "synthetic-oauth-header" } }); await assert.rejects(h.propose({ serverId: oauth.id, headerName: "X-Key" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  const stdio = await h.manager.save({ name: "Owned STDIO", transport: "stdio", enabled: false, command: "owned-never-executed", env: { OWNED_KEY: "synthetic-owned" } }); await assert.rejects(h.propose({ serverId: stdio.id, headerName: "Authorization" }), { code: "CONFIGURATION_RESOURCE_UNAVAILABLE" });
  card = await h.fill(await h.consent(await h.propose())); h.store.notifications.stop(h.session.id); await h.framework.tick(); assert.equal(h.framework.service.get(h.session.id, card.id).state, "cancelled"); assert.equal(h.state.submits, 0);
  const page = await discoverConfiguration(h.store, h.session.id, "owned", "describe", { capabilityId: "mcp.header_credential", targetId: h.server.id }); assert.doesNotMatch(JSON.stringify(page), /synthetic-old|hidden-path|synthetic-url-secret|Host/u);
});
