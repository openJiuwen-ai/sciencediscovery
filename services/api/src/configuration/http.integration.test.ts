// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64", "model:mock", "isolation:fresh"] });
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import type { ConfigurationCapabilityId, ConfigurationCredentialDraftView, ConfigurationRequestView, ConfigurationValues,
  ModelProfile, ModelProvider, Project, RuntimeSettingsDetails, Session, SessionDetail } from "@sciencediscovery/schema";
import { DEFAULT_MODEL_API_VARIANT } from "@sciencediscovery/schema";
import { createApiServer, closeApiServer } from "../http/index.js";
import type { ServerConfig } from "../bootstrap/config.js";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";

// DEV-CFG-05/07, CFG-T01/T03/T06/T08/T14/T17/T20/T23: exercise the real
// authenticated routes and authoritative domain stores, without a remote LLM.
type Result<T> = { status: number; body: T; text: string; headers: Headers };
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
}
async function fixture(context: TestContext) {
  const tmp = resolve(process.cwd(), ".tmp");
  await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(resolve(tmp, "configuration-http-"));
  const previousExecutor = process.env.SCIENCE_AGENT_EXECUTOR;
  process.env.SCIENCE_AGENT_EXECUTOR = "native";
  const probes: Array<{ authorization?: string; model?: unknown; path?: string }> = [];
  const provider = createServer(async (request, response) => {
    const body = await readBody(request);
    probes.push({ authorization: request.headers.authorization, model: body.model, path: request.url });
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization?.includes("bad-credential")) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { message: "Do not reflect bad-credential from provider diagnostics" } }));
    } else {
      response.writeHead(200);
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    }
  });
  const providerOrigin = await listen(provider);
  // Settings tests need only the Runner's kernel-teardown acknowledgment when
  // archiving a session. No command, sandbox or real host Runner is involved.
  const runner = createServer((_request, response) => {
    _request.resume();
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
  });
  const runnerOrigin = await listen(runner);
  const config: ServerConfig = {
    authToken: "configuration-http-token", dataDir: root, host: "127.0.0.1", port: 0,
    modelCatalogPath: resolve(root, "absent-model-catalog.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    gatewayIdleTimeoutMs: 10_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0, permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "configuration-runner-token", runnerUrl: runnerOrigin, sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "", internalToken: "" }, evolve: { url: "", internalToken: "" },
  };
  let api: Server | undefined;
  context.after(async () => {
    try { if (api) await closeApiServer(api); }
    finally {
      await close(runner); await close(provider);
      if (previousExecutor === undefined) delete process.env.SCIENCE_AGENT_EXECUTOR;
      else process.env.SCIENCE_AGENT_EXECUTOR = previousExecutor;
      assert.ok(root.startsWith(`${tmp}${sep}`), "Only this fixture's generated directory may be removed");
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  api = createApiServer(config, { mcpTransport: offlineMcpTransport });
  const origin = await listen(api);
  async function call<T = Record<string, unknown>>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", key?: string): Promise<Result<T>> {
    let response: Response;
    try { response = await fetch(origin + path, { method, headers: { authorization: "Bearer configuration-http-token",
      ...(body !== undefined ? { "content-type": "application/json", "Idempotency-Key": key ?? randomUUID() } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) }); }
    catch { throw new Error(`Fixture request did not complete: ${method} ${path}`); }
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as T, text, headers: response.headers };
  }
  async function ok<T>(path: string, body?: unknown, method?: string, status = body === undefined ? 200 : 201): Promise<T> {
    const result = await call<T>(path, body, method);
    assert.equal(result.status, status, `${method ?? (body === undefined ? "GET" : "POST")} ${path}: ${result.text}`);
    return result.body;
  }
  const project = await ok<Project>("/api/projects", { name: "Configuration HTTP isolated fixture" });
  const session = await ok<Session>(`/api/projects/${project.id}/sessions`, { title: "Configuration subject" });
  const sibling = await ok<Session>(`/api/projects/${project.id}/sessions`, { title: "Configuration sibling" });
  const path = (request?: ConfigurationRequestView, action?: string, owner = session.id) => `/api/sessions/${owner}/configuration-requests${request ? `/${request.id}` : ""}${action ? `/${action}` : ""}`;
  async function proposal(capabilityId: ConfigurationCapabilityId, values: ConfigurationValues = {}) {
    return ok<ConfigurationRequestView>(path(), { capabilityId, values });
  }
  async function preview(request: ConfigurationRequestView, values: ConfigurationValues, credentialHandle?: string) {
    return ok<ConfigurationRequestView>(path(request, "preview"), { expectedRevision: request.revision, values,
      ...(credentialHandle ? { credentialHandle } : {}) }, "POST", 200);
  }
  async function withCredential(request: ConfigurationRequestView, values: ConfigurationValues, secret: string) {
    const target = await preview(request, values);
    if (target.endpointAuthorization?.status === "required") await ok<ConfigurationRequestView>(path(target, "endpoint-consent"), { revision: target.revision, endpointTarget: target.endpointAuthorization.endpointTarget }, "POST", 200);
    const uploaded = await call<ConfigurationCredentialDraftView>(path(target, "credentials"), { expectedRevision: target.revision, fieldId: "apiToken", secret });
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(uploaded.body).sort(), ["expiresAt", "handle"]);
    return preview(target, values, uploaded.body.handle);
  }
  async function decision(request: ConfigurationRequestView, key?: string) {
    return call<ConfigurationRequestView>(path(request, "decision"), { revision: request.revision, previewDigest: request.previewDigest, decision: "apply" }, "POST", key);
  }
  const values: ConfigurationValues = { name: "Isolated fixture provider", baseUrl: `${providerOrigin}/v1`, model: "fixture-model",
    apiProtocol: "openai-chat-completions", apiVariant: DEFAULT_MODEL_API_VARIANT["openai-chat-completions"] };
  return { root, origin, providerOrigin, project, session, sibling, probes, values, call, ok, path, proposal, preview, withCredential, decision };
}

async function assertNoPlaintext(root: string, forbidden: string[]) {
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) {
        const contents = await readFile(path);
        for (const secret of forbidden) assert.equal(contents.includes(Buffer.from(secret)), false, `Credential plaintext must not be stored in ${entry.name}`);
      }
    }
  }
  await scan(root);
}

test("CFG HTTP: invalid connection previews return a safe baseUrl field error before any provider request", async (context) => {
  const f = await fixture(context);
  for (const baseUrl of ["not a URL", "file:///private", "https://user:synthetic-secret@example.test/v1", "https://example.test/v1?key=synthetic-secret", "https://example.test/v1#synthetic-secret"]) {
    const proposal = await f.proposal("model.connect");
    const result = await f.call(f.path(proposal, "preview"), {
      expectedRevision: proposal.revision, values: { ...f.values, baseUrl },
    });
    assert.equal(result.status, 400, result.text);
    assert.equal(result.body.code, "INVALID_CONFIGURATION_URL");
    assert.equal(result.body.field, "baseUrl");
    assert.doesNotMatch(result.text, /synthetic-secret|file:\/\/\/private|user:/);
    assert.equal(f.probes.length, 0);
  }
});

test("CFG HTTP: first connection is preview-only until confirmation, applies once, and establishes the global default", async (context) => {
  const f = await fixture(context);
  const capabilities = await f.ok<{ items: Array<{ id: string }>; executor: string }>(`/api/sessions/${f.session.id}/configuration/capabilities`);
  assert.deepEqual(capabilities.items.map((item) => item.id).sort(), ["connector.enable", "idea_tree.configure", "model.connect", "model.repair_credential", "model.select", "quotas.configure", "review.configure", "skill.select", "thinking.configure", "timeouts.configure"]);
  assert.equal(capabilities.executor, "native");
  const initial = await f.proposal("model.connect");
  assert.equal(initial.state, "collecting_input");
  assert.equal(initial.scope.kind, "global");
  const ready = await f.withCredential(initial, f.values, "good-first-credential");
  assert.equal(ready.state, "awaiting_confirmation");
  assert.match(ready.impact.effectiveScope, /Global default/);
  assert.equal(ready.verificationPlan.maxRequests, 1);
  assert.equal(ready.verificationPlan.mayCharge, true);
  assert.deepEqual(await f.ok<ModelProfile[]>("/api/models"), []);
  assert.deepEqual((await f.ok<{ providers: ModelProvider[] }>("/api/providers")).providers, []);
  assert.equal((await f.ok<RuntimeSettingsDetails>("/api/settings")).overrides.modelId, undefined);
  assert.equal(f.probes.length, 0, "Proposal, target preview and credential draft cannot probe the provider");
  assert.doesNotMatch(JSON.stringify(ready), /good-first-credential|credentialHandle|secretRef|ciphertext/);
  const key = randomUUID();
  const doubleClick = await Promise.all([f.decision(ready, key), f.decision(ready, key)]);
  assert.ok(doubleClick.every((result) => result.status === 200));
  const saved = await f.ok<ConfigurationRequestView>(f.path(ready));
  assert.equal(saved.state, "applied");
  assert.equal(saved.activation.state, "active", "Saving and verified activation have distinct receipts");
  assert.ok(saved.activation.effectiveRevision);
  assert.equal(saved.resumption.state, "not_requested");
  assert.equal(f.probes.length, 1, "Concurrent confirmation must not duplicate a charged probe");
  assert.equal(f.probes[0]?.path, "/v1/chat/completions");
  assert.equal(f.probes[0]?.model, "fixture-model");
  const models = await f.ok<ModelProfile[]>("/api/models");
  assert.equal(models.length, 1);
  const settings = await f.ok<RuntimeSettingsDetails>("/api/settings");
  assert.equal(settings.overrides.modelId, models[0]!.id);
  const sibling = await f.ok<SessionDetail>(`/api/sessions/${f.sibling.id}`);
  assert.equal(sibling.modelId, models[0]!.id, "Existing inheriting sessions gain the first default");
  const future = await f.ok<Session>(`/api/projects/${f.project.id}/sessions`, { title: "Future inheriting session" });
  assert.equal(future.modelId, models[0]!.id);
  const replay = await f.decision(ready, key);
  assert.equal(replay.status, 200);
  assert.equal(f.probes.length, 1);
  const mismatch = await f.call(f.path(ready, "decision"), { revision: ready.revision, previewDigest: ready.previewDigest, decision: "dismiss" }, "POST", key);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, "IDEMPOTENCY_MISMATCH");
  await assertNoPlaintext(f.root, ["good-first-credential"]);
});

test("CFG HTTP v3: credentials are unnecessary to close an incomplete proposal; unselected legacy apply is rejected", async (context) => {
  const f = await fixture(context);
  const proposed = await f.ok<ConfigurationRequestView>(f.path(), { capabilityId: "model.connect", values: {}, protocolVersion: 3 });
  assert.equal(proposed.protocolVersion, 3); assert.equal(proposed.state, "collecting_input");
  const legacy = await f.call(f.path(proposed, "decision"), { revision: proposed.revision, previewDigest: proposed.previewDigest, decision: "apply" });
  assert.equal(legacy.status, 409); assert.equal(legacy.body.code, "CONFIGURATION_OPTION_REQUIRED");
  const dismissedOption = proposed.options!.find(option => option.kind === "dismiss")!;
  const selected = await f.ok<ConfigurationRequestView>(f.path(proposed, "preview"), { expectedRevision: proposed.revision, values: {}, selectedOptionId: dismissedOption.id }, "POST", 200);
  assert.equal(selected.revision, proposed.revision + 1); assert.deepEqual(selected.fields, []);
  const result = await f.ok<ConfigurationRequestView>(f.path(selected, "decision"), { revision: selected.revision, previewDigest: selected.previewDigest, selectedOptionId: dismissedOption.id, decision: "dismiss" }, "POST", 200);
  assert.equal(result.state, "dismissed"); assert.equal(result.choiceReceipt?.configurationWritten, false);
  assert.equal(result.choiceReceipt?.kind, "dismiss"); assert.equal(f.probes.length, 0);
  assert.deepEqual(await f.ok<ModelProfile[]>("/api/models"), []);
  const reloaded = await f.ok<ConfigurationRequestView>(f.path(result));
  assert.equal(reloaded.selectedOptionId, dismissedOption.id); assert.deepEqual(reloaded.choiceReceipt, result.choiceReceipt);
  const sibling = await f.call(f.path(result, undefined, f.sibling.id));
  assert.equal(sibling.status, 404);
});

test("CFG HTTP: failed isolated repair preserves a shared provider credential; successful repair affects only the selected model", async (context) => {
  const f = await fixture(context);
  const provider = await f.ok<ModelProvider>("/api/providers", { name: "Shared fixture provider", baseUrl: `${f.providerOrigin}/v1`, apiToken: "good-original-credential" });
  const first = await f.ok<ModelProfile>(`/api/providers/${provider.id}/models`, { model: "first-model" });
  const second = await f.ok<ModelProfile>(`/api/providers/${provider.id}/models`, { model: "second-model" });
  const repair = await f.proposal("model.repair_credential", { modelId: first.id });
  assert.equal(repair.scope.kind, "global");
  assert.match(repair.impact.effectiveScope, /Every session using this model profile/);
  assert.match(repair.impact.message, /other models keep their credentials/);
  const bad = await f.withCredential(repair, { modelId: first.id }, "bad-credential-must-remain-isolated");
  const beforeProbe = f.probes.length;
  const rejected = await f.decision(bad);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.state, "needs_fix");
  assert.equal(f.probes.length, beforeProbe + 1);
  assert.doesNotMatch(rejected.text, /bad-credential|good-original-credential|credentialHandle/);
  const firstTest = await f.call<{ ok: boolean }>(`/api/models/${first.id}/test`, { consent: true });
  assert.equal(firstTest.status, 200);
  assert.equal(firstTest.body.ok, true);
  assert.equal(f.probes.at(-1)?.authorization, "Bearer good-original-credential");
  const fixed = await f.withCredential(rejected.body, { modelId: first.id }, "good-replacement-credential");
  const applied = await f.decision(fixed);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.state, "applied");
  const nowFirst = await f.call<{ ok: boolean }>(`/api/models/${first.id}/test`, { consent: true });
  assert.equal(nowFirst.body.ok, true);
  assert.equal(f.probes.at(-1)?.authorization, "Bearer good-replacement-credential");
  const nowSecond = await f.call<{ ok: boolean }>(`/api/models/${second.id}/test`, { consent: true });
  assert.equal(nowSecond.body.ok, true);
  assert.equal(f.probes.at(-1)?.authorization, "Bearer good-original-credential", "Sibling model keeps the shared provider credential");
  const list = await f.call(f.path());
  assert.doesNotMatch(list.text, /good-original-credential|good-replacement-credential|bad-credential|credentialHandle|ciphertext/);
  await assertNoPlaintext(f.root, ["good-original-credential", "good-replacement-credential", "bad-credential-must-remain-isolated"]);
});

test("CFG HTTP: capability entry, ownership, revision, resource versions and archived sessions enforce the same safe boundary", async (context) => {
  const f = await fixture(context);
  const modelA = await f.ok<ModelProfile>("/api/models", { name: "Model A", baseUrl: `${f.providerOrigin}/v1`, model: "a", apiToken: "good-model-a-credential" });
  const modelB = await f.ok<ModelProfile>("/api/models", { name: "Model B", baseUrl: `${f.providerOrigin}/v1`, model: "b", apiToken: "good-model-b-credential" });
  const select = await f.proposal("model.select", { modelId: modelA.id });
  const proposalKey = randomUUID();
  const repeatedProposal = await Promise.all([f.call<ConfigurationRequestView>(f.path(), { capabilityId: "model.select", values: { modelId: modelA.id } }, "POST", proposalKey),
    f.call<ConfigurationRequestView>(f.path(), { capabilityId: "model.select", values: { modelId: modelA.id } }, "POST", proposalKey)]);
  assert.ok(repeatedProposal.every((result) => result.status === 201));
  assert.equal(repeatedProposal[0]!.body.id, repeatedProposal[1]!.body.id);
  const connectors = await f.ok<Array<{ id: string }>>("/api/connectors");
  const connectorId = connectors.find((item) => item.id !== "web")?.id ?? connectors[0]?.id;
  assert.ok(connectorId, "Fixture must expose at least one registered connector");
  const connector = await f.proposal("connector.enable", { connectorId });
  assert.equal(connector.capabilityId, "connector.enable");
  assert.equal(connector.scope.kind, "session");
  const newConnect = await f.proposal("model.connect");
  assert.equal(newConnect.scope.kind, "session", "Connections after the first model cannot change the global default");
  assert.equal((await f.proposal("model.repair_credential", { modelId: modelA.id })).capabilityId, "model.repair_credential");
  const collection = await f.ok<{ items: ConfigurationRequestView[] }>(f.path());
  assert.ok(collection.items.some((item) => item.id === select.id));
  assert.ok(collection.items.every((item) => item.sessionId === f.session.id));
  const wrongScopeOwner = await f.call(f.path(), { capabilityId: "model.select", values: { modelId: modelA.id }, scope: { kind: "session", id: f.sibling.id } });
  assert.equal(wrongScopeOwner.status, 403);
  const understatedRepairScope = await f.call(f.path(), { capabilityId: "model.repair_credential", values: { modelId: modelA.id }, scope: { kind: "session", id: f.session.id } });
  assert.equal(understatedRepairScope.status, 400, "Shared model credentials cannot be presented as a session-only write");
  assert.equal(f.probes.length, 0);
  const changed = await f.preview(select, { modelId: modelB.id });
  assert.ok(changed.revision > select.revision);
  const stale = await f.decision(select);
  assert.equal(stale.status, 409);
  assert.equal((stale.body as unknown as { code: string }).code, "STALE_CONFIGURATION_PREVIEW");
  const sessionSettings = await f.ok<RuntimeSettingsDetails>(`/api/sessions/${f.session.id}/settings`);
  await f.ok(`/api/sessions/${f.session.id}/settings`, { ...sessionSettings.overrides, modelId: modelA.id }, "PUT", 200);
  const resourceChanged = await f.decision(changed);
  assert.equal(resourceChanged.status, 409);
  assert.equal((resourceChanged.body as unknown as { code: string }).code, "RESOURCE_VERSION_CONFLICT");
  const crossSession = await f.call(f.path(select, undefined, f.sibling.id));
  assert.equal(crossSession.status, 404);
  const crossDecision = await f.call(f.path(changed, "decision", f.sibling.id), { revision: changed.revision, previewDigest: changed.previewDigest, decision: "apply" });
  assert.equal(crossDecision.status, 404);
  const crossCredential = await f.call(f.path(select, "credentials", f.sibling.id), { expectedRevision: changed.revision, fieldId: "apiToken", secret: "cross-session-secret" });
  assert.equal(crossCredential.status, 404);
  assert.doesNotMatch(crossCredential.text, /cross-session-secret/);
  const unknown = await f.call(f.path(), { capabilityId: "model.connect", values: { ...f.values, apiToken: "must-use-dedicated-channel" } });
  assert.equal(unknown.status, 400);
  assert.doesNotMatch(unknown.text, /must-use-dedicated-channel/);
  const maliciousUrl = await f.call(f.path(), { capabilityId: "model.connect", values: { ...f.values, baseUrl: "http://user:url-secret@127.0.0.1/v1" } });
  assert.equal(maliciousUrl.status, 400);
  assert.doesNotMatch(maliciousUrl.text, /url-secret/);
  const forbiddenField = await f.call(f.path(newConnect, "credentials"), { expectedRevision: newConnect.revision, fieldId: "name", secret: "wrong-field-secret" });
  assert.equal(forbiddenField.status, 400);
  assert.doesNotMatch(forbiddenField.text, /wrong-field-secret/);
  const unauthenticated = await fetch(f.origin + f.path());
  assert.equal(unauthenticated.status, 401);
  const latest = await f.preview(changed, { modelId: modelB.id });
  const selected = await f.decision(latest);
  assert.equal(selected.status, 200);
  assert.equal(selected.body.state, "applied");
  const continuation = await f.call<ConfigurationRequestView>(f.path(latest, "continue"), {});
  assert.equal(continuation.status, 200);
  assert.equal(continuation.body.resumption.state, "not_requested", "An explicit settings change cannot create a blank continuation run");
  const reversal = await f.call<ConfigurationRequestView>(f.path(latest, "reversal"), {});
  assert.equal(reversal.status, 201);
  assert.notEqual(reversal.body.id, latest.id);
  assert.equal(reversal.body.state, "awaiting_confirmation");
  assert.equal((await f.ok<RuntimeSettingsDetails>(`/api/sessions/${f.session.id}/settings`)).overrides.modelId, modelB.id,
    "Creating a reversal proposal cannot apply it");
  const beforeArchive = await f.ok<RuntimeSettingsDetails>(`/api/sessions/${f.session.id}/settings`);
  await f.ok(`/api/sessions/${f.session.id}/archive`, {}, "POST", 200);
  const archived = await f.decision(latest);
  assert.equal(archived.status, 409);
  assert.deepEqual((await f.ok<RuntimeSettingsDetails>(`/api/sessions/${f.session.id}/settings`)).overrides, beforeArchive.overrides);
  assert.equal(f.probes.length, 0, "Rejected proposals and archived/stale decisions cannot make a model call");
});
