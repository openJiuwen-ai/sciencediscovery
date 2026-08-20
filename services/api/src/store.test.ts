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
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import type { ArtifactJob, ComposerReference, ExecutionRun, ModelInvocationUsage, Subagent } from "@science-agent/schema";
import { reviewerSpecialistSupportsLevel } from "@science-agent/schema";
import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  DEFAULT_SUBAGENT_TIMEOUT_SECONDS,
} from "@science-agent/orchestration";

import {
  SessionStore,
} from "./store.js";
import { encryptModelApiToken } from "./store/secrets.js";
import { normalizeMemoryGraphSettings } from "./store/settings.js";

interface PersistedCatalog {
  environmentSourceSettings?: { condaSource: string; pipSource: string };
  globalSettings: Record<string, unknown>;
  models: Array<Record<string, unknown>>;
  permissionEpochs: Array<{ id: string; networkPolicy: string }>;
  projects: Array<{ id: string; name: string; settingsOverrides: Record<string, unknown> }>;
  reviewerSpecialistEnabled?: boolean;
  reviewerSpecialistLevel?: string;
  sessions: Array<{
    approvalMode: "always_allow" | "ask_for_dangerous";
    id: string;
    modelId?: string;
    permissionEpochId: string;
    reviewModelId?: string;
    settingsOverrides: Record<string, unknown>;
    title: string;
  }>;
}

test("SessionStore persists global package sources and migrates old catalogs to upstream", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `environment-sources-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  assert.deepEqual(store.getEnvironmentSourceSettings(), {
    condaSource: "upstream",
    pipSource: "upstream",
  });
  assert.deepEqual((await readPersistedCatalog(tempRoot)).environmentSourceSettings, {
    condaSource: "upstream",
    pipSource: "upstream",
  });

  const database = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"));
  const row = database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string };
  const legacyCatalog = JSON.parse(row.json) as Record<string, unknown>;
  delete legacyCatalog.environmentSourceSettings;
  database.prepare("UPDATE catalog_state SET json = ? WHERE id = 1").run(JSON.stringify(legacyCatalog));
  database.close();

  const migrated = new SessionStore(tempRoot);
  await migrated.load();
  assert.deepEqual(migrated.getEnvironmentSourceSettings(), {
    condaSource: "upstream",
    pipSource: "upstream",
  });
  assert.deepEqual((await readPersistedCatalog(tempRoot)).environmentSourceSettings, {
    condaSource: "upstream",
    pipSource: "upstream",
  });

  await migrated.updateEnvironmentSourceSettings({ condaSource: "tsinghua", pipSource: "huawei" });
  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.deepEqual(reopened.getEnvironmentSourceSettings(), {
    condaSource: "tsinghua",
    pipSource: "huawei",
  });
  await assert.rejects(
    reopened.updateEnvironmentSourceSettings({ pipSource: "unknown" as "upstream" }),
    /known package source/,
  );
});

async function readPersistedCatalog(tempRoot: string): Promise<PersistedCatalog> {
  const database = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string };
  database.close();
  return JSON.parse(row.json) as PersistedCatalog;
}

test("Reviewer Specialist levels are cumulative", () => {
  assert.equal(reviewerSpecialistSupportsLevel("quick", "quick"), true);
  assert.equal(reviewerSpecialistSupportsLevel("quick", "deep"), false);
  assert.equal(reviewerSpecialistSupportsLevel("deep", "quick"), true);
  assert.equal(reviewerSpecialistSupportsLevel("deep", "deep"), true);
});

test("SessionStore persists a Reviewer Specialist conversation checkpoint", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `reviewer-message-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const project = await store.createProject("Reviewer project");
  const session = await store.createSession(
    project.id,
    "Reviewer session",
    {},
    {},
    { allowUnconfiguredModel: true },
  );
  const messageId = "11111111-1111-4111-8111-111111111111";
  const toolCallId = `manual-review:${messageId}`;

  const running = await store.appendReviewerCheckpointMessage(session.id, messageId, toolCallId);
  assert.equal(running.kind, "reviewer_checkpoint");
  assert.deepEqual(running.reviewerCheckpoint, { status: "running", toolCallId });

  const feedback = "Reviewer Specialist feedback\nStatus: PASSED";
  const completed = await store.updateReviewerCheckpointMessage(session.id, messageId, {
    content: feedback,
    status: "completed",
  });
  assert.equal(completed.reviewerCheckpoint?.status, "completed");
  assert.equal(completed.content, feedback);
  assert.deepEqual((await store.readMessages(session.id))[0], completed);

  const lateUpdate = await store.updateReviewerCheckpointMessage(session.id, messageId, {
    content: "Reviewer Specialist feedback\nStatus: REVISION_REQUIRED",
    status: "failed",
  });
  assert.deepEqual(lateUpdate, completed);
  const lateProgress = await store.updateReviewerCheckpointProgress(session.id, messageId, {
    artifactLogicalName: "evidence_brief.md",
    completed: 1,
    failed: 0,
    queued: 0,
    total: 1,
  });
  assert.deepEqual(lateProgress, completed);
});

test("SessionStore persists the Reviewer Specialist switch and cumulative review level", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `reviewer-settings-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  assert.deepEqual(store.getReviewerSpecialistSettings(), { enabled: false, level: "quick" });

  await store.updateReviewerSpecialistSettings({ enabled: true, level: "deep" });
  assert.deepEqual(store.getReviewerSpecialistSettings(), { enabled: true, level: "deep" });
  assert.equal((await readPersistedCatalog(tempRoot)).reviewerSpecialistEnabled, true);
  assert.equal((await readPersistedCatalog(tempRoot)).reviewerSpecialistLevel, "deep");

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.deepEqual(reopened.getReviewerSpecialistSettings(), { enabled: true, level: "deep" });
  await reopened.updateReviewerSpecialistSettings({ enabled: false });
  assert.deepEqual(reopened.getReviewerSpecialistSettings(), { enabled: false, level: "deep" });
  await assert.rejects(
    store.updateReviewerSpecialistSettings({ enabled: "yes" }),
    /enabled must be a boolean/,
  );
  await assert.rejects(
    store.updateReviewerSpecialistSettings({ enabled: true, level: "extreme" }),
    /level must be quick or deep/,
  );
});

test("SessionStore appends run events losslessly and survives reload", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `run-events-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Run event persistence");
  const session = await store.createSession(project.id, "Replay", model.id);
  const run = await store.createSessionRun({
    prompt: "Persist the timeline",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });

  const first = await store.appendSessionRunEvent(session.id, run.id, {
    delta: "Inspect ",
    turn: 1,
    type: "assistant.thinking.delta",
  });
  const second = await store.appendSessionRunEvent(session.id, run.id, {
    delta: "the data.",
    turn: 1,
    type: "assistant.thinking.delta",
  });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual((await store.listSessionRunEvents(session.id, run.id)).map((record) => record.event), [
    { delta: "Inspect ", turn: 1, type: "assistant.thinking.delta" },
    { delta: "the data.", turn: 1, type: "assistant.thinking.delta" },
  ], "deltas persist exactly as they were emitted");
  assert.equal((await store.listSessionRunEvents(session.id, run.id, 1))[0]?.sequence, 2);

  const longText = "x".repeat(150_000);
  await store.appendSessionRunEvent(session.id, run.id, { delta: longText, type: "assistant.delta" });
  const answer = (await store.listSessionRunEvents(session.id, run.id)).at(-1)?.event;
  assert.equal(answer?.type === "assistant.delta" && answer.delta.length, longText.length, "no length cap applies");

  for (let turn = 0; turn < 1_200; turn += 1) {
    await store.appendSessionRunEvent(session.id, run.id, { phase: "thinking", turn, type: "agent.phase" });
  }
  const retained = await store.listSessionRunEvents(session.id, run.id);
  assert.equal(retained.length, 1_203, "no record cap drops history");
  assert.ok(retained.every((record) => record.event.type !== "run.history.truncated"));

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.deepEqual(
    await reopened.listSessionRunEvents(session.id, run.id),
    retained,
    "replay records survive a Store reload",
  );
});

test("SessionStore serializes concurrent model usage writes without losing records", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `model-usage-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Usage persistence");
  const session = await store.createSession(project.id, "Concurrent usage", model.id);
  const now = new Date().toISOString();
  const records = Array.from({ length: 32 }, (_, index): ModelInvocationUsage => ({
    attemptIndex: 0,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    finishedAt: now,
    id: `usage-${index}`,
    inputTokens: index,
    invocationId: `invocation-${index}`,
    invocationKind: index % 2 ? "session-naming" : "task",
    model: model.model,
    modelProfileId: model.id,
    modelProfileName: model.name,
    outputTokens: 1,
    projectId: project.id,
    sessionId: session.id,
    startedAt: now,
    totalTokens: index + 1,
    usageStatus: "reported",
  }));

  await Promise.all(records.map((record) => store.appendModelInvocationUsage(record)));
  assert.deepEqual(
    (await store.listModelInvocationUsage(session.id)).map((record) => record.id).toSorted(),
    records.map((record) => record.id).toSorted(),
  );

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.equal((await reopened.listModelInvocationUsage(session.id)).length, records.length);
});

test("SessionStore serializes concurrent Session run creation and updates", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-run-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Run queue persistence");
  const session = await store.createSession(project.id, "Concurrent runs", model.id);
  const settingsSnapshot = store.resolveRuntimeSettings(session.id).effective;

  const created = await Promise.all(Array.from({ length: 24 }, (_, index) => store.createSessionRun({
    prompt: `Run ${index}`,
    sessionId: session.id,
    settingsSnapshot,
  })));
  assert.deepEqual(
    (await store.listSessionRuns(session.id)).map((run) => run.queueOrder),
    Array.from({ length: created.length }, (_, index) => index + 1),
  );

  await Promise.all(created.map((run) => store.updateSessionRunStatus(
    session.id,
    run.id,
    "running",
    { startedAt: new Date().toISOString() },
  )));
  const updated = await store.listSessionRuns(session.id);
  assert.equal(updated.length, created.length);
  assert.equal(updated.every((run) => run.status === "running"), true);
});

test("SessionStore persists global web settings while keeping provider keys write-only", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `web-settings-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const defaults = store.getWebSettings();
  assert.deepEqual(defaults.paidSearchProviders, ["tavily", "exa", "brave"]);
  assert.deepEqual(defaults.freeSearchEngines, { bing: true, "brave-html": true, duckduckgo: true });
  assert.equal(defaults.fetchProvider, "jina");
  assert.equal(defaults.proxyPolicy, "inherit");

  const proxy = await store.createProxyServer({
    kind: "custom_url",
    name: "Corp proxy",
    url: "http://proxy-user:proxy-pass@proxy.example.test:7890",
  });
  const updated = await store.updateWebSettings({
    fetchProvider: "exa",
    providerApiKeys: { exa: "exa-secret", jina: "jina-secret" },
    freeSearchEngines: { bing: false, "brave-html": true, duckduckgo: true },
    paidSearchProviders: ["exa"],
    proxyPolicy: `proxy:${proxy.id}`,
  });
  assert.deepEqual(updated.paidSearchProviders, ["exa"]);
  assert.equal(updated.freeSearchEngines.bing, false);
  assert.equal(updated.providers.find((item) => item.provider === "exa")?.hasApiKey, true);
  assert.equal(JSON.stringify(updated).includes("exa-secret"), false);
  assert.equal(store.getWebProviderApiKey("exa"), "exa-secret");
  assert.equal(store.getWebProviderApiKey("jina"), "jina-secret");
  assert.equal(updated.proxyPolicy, `proxy:${proxy.id}`);
  assert.equal(JSON.stringify(updated).includes("proxy-pass"), false);
  assert.deepEqual(store.resolveProxy(updated.proxyPolicy), {
    mode: "url",
    url: "http://proxy-user:proxy-pass@proxy.example.test:7890/",
  });

  const database = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"), { readOnly: true });
  const secret = database.prepare("SELECT encrypted_token FROM web_provider_secrets WHERE provider = 'exa'")
    .get() as { encrypted_token: string };
  assert.notEqual(secret.encrypted_token, "exa-secret");
  assert.equal(secret.encrypted_token.includes("exa-secret"), false);

  const proxySecret = database.prepare("SELECT encrypted_url FROM proxy_server_secrets WHERE server_id = ?")
    .get(proxy.id) as { encrypted_url: string };
  database.close();
  assert.equal(proxySecret.encrypted_url.includes("proxy-pass"), false);

  await store.updateWebSettings({
    providerApiKeys: { exa: null, jina: null },
    proxyPolicy: "none",
  });
  assert.equal(store.getWebProviderApiKey("exa"), undefined);
  assert.equal(store.getWebProviderApiKey("jina"), undefined);
  assert.deepEqual(store.resolveProxy(store.getWebSettings().proxyPolicy), { mode: "direct" });
  await store.deleteProxyServer(proxy.id);
  assert.equal(store.getProxyServerUrl(proxy.id), undefined);
});

test("SessionStore manages registry defaults and independent module policies", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `proxy-registry-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const primary = await store.createProxyServer({
    kind: "custom_url",
    name: "Primary",
    url: "http://user:password@primary.example.test:7890",
  });
  const secondary = await store.createProxyServer({
    kind: "custom_url",
    name: "Secondary",
    url: "https://secondary.example.test:8443",
  });
  assert.equal(primary.url, "http://user:password@primary.example.test:7890/");
  assert.equal(secondary.url, "https://secondary.example.test:8443/");
  await store.updateProxySettings({ defaultPolicy: `proxy:${primary.id}` });
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
    proxyPolicy: `proxy:${secondary.id}`,
  });
  await store.updateWebSettings({ proxyPolicy: "none" });
  const policies = await store.updateMcpProxyPolicies({
    policies: {
      biomed: `proxy:${primary.id}`,
      uniprot: "none",
      unused: "inherit",
    },
  });

  assert.equal(model.proxyPolicy, `proxy:${secondary.id}`);
  assert.deepEqual(policies, { biomed: `proxy:${primary.id}`, uniprot: "none" });
  assert.deepEqual(store.resolveProxy("inherit"), {
    mode: "url",
    url: "http://user:password@primary.example.test:7890/",
  });
  assert.deepEqual(store.resolveProxy(store.mcpProxyPolicy("biomed")), {
    mode: "url",
    url: "http://user:password@primary.example.test:7890/",
  });
  assert.deepEqual(store.resolveProxy(store.mcpProxyPolicy("uniprot")), { mode: "direct" });
  assert.equal(store.mcpProxyPolicy("other"), "inherit");
  assert.equal(
    store.getProxySettings().servers.find((server) => server.id === primary.id)?.url,
    "http://user:password@primary.example.test:7890/",
  );

  await assert.rejects(store.deleteProxyServer(primary.id), /global default proxy/);
  await store.updateProxySettings({ defaultPolicy: "none" });
  await assert.rejects(store.deleteProxyServer(primary.id), /MCP server "biomed"/);
  await store.updateMcpProxyPolicies({ policies: { uniprot: "none" } });
  await assert.rejects(
    store.updateProxyServer(primary.id, { kind: "invalid" as "system", name: "Partial rename" }),
    /Proxy server kind/,
  );
  assert.equal(store.getProxySettings().servers.find((server) => server.id === primary.id)?.name, "Primary");
  const changed = await store.updateProxyServer(primary.id, { kind: "environment", name: "Corporate environment" });
  assert.equal(changed.kind, "environment");
  assert.equal(changed.hasUrl, false);
  assert.equal(store.getProxyServerUrl(primary.id), undefined);
  await store.deleteProxyServer(primary.id);
  await assert.rejects(
    store.updateWebSettings({ proxyPolicy: `proxy:${primary.id}` }),
    /unknown proxy server/,
  );
});

test("SessionStore migrates legacy web proxy modes into the authenticated settings projection", async (context) => {
  for (const mode of ["environment", "direct", "custom"] as const) {
    const tempRoot = resolve(process.cwd(), ".tmp", `proxy-migration-${mode}-${Date.now()}-${process.pid}`);
    await mkdir(tempRoot, { recursive: true });
    context.after(() => rm(tempRoot, { force: true, recursive: true }));

    const initial = new SessionStore(tempRoot);
    await initial.load();
    const database = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"));
    const row = database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string };
    const catalog = JSON.parse(row.json) as Record<string, unknown>;
    delete catalog.proxyServers;
    delete catalog.proxyDefaultPolicy;
    delete catalog.mcpProxyPolicies;
    const webSettings = catalog.webSettings as Record<string, unknown>;
    delete webSettings.proxyPolicy;
    webSettings.proxyMode = mode;
    database.prepare("UPDATE catalog_state SET json = ? WHERE id = 1").run(JSON.stringify(catalog));
    if (mode === "custom") {
      const key = await readFile(resolve(tempRoot, "model-secrets.key"));
      database.prepare("INSERT INTO web_proxy_secret (id, encrypted_url) VALUES (1, ?)")
        .run(encryptModelApiToken(key, "web:proxy", "http://legacy-user:legacy-pass@proxy.example.test:3128"));
    }
    database.close();

    const migrated = new SessionStore(tempRoot);
    await migrated.load();
    const web = migrated.getWebSettings();
    if (mode === "direct") {
      assert.equal(web.proxyPolicy, "none");
      assert.deepEqual(migrated.resolveProxy(web.proxyPolicy), { mode: "direct" });
    } else if (mode === "environment") {
      assert.equal(web.proxyPolicy, "inherit");
      assert.deepEqual(migrated.resolveProxy(web.proxyPolicy), { mode: "environment" });
    } else {
      assert.match(web.proxyPolicy, /^proxy:/);
      assert.deepEqual(migrated.resolveProxy(web.proxyPolicy), {
        mode: "url",
        url: "http://legacy-user:legacy-pass@proxy.example.test:3128",
      });
      assert.equal(
        migrated.getProxySettings().servers.find((server) => server.id === web.proxyPolicy.slice("proxy:".length))?.url,
        "http://legacy-user:legacy-pass@proxy.example.test:3128",
      );
    }
    const migratedDatabase = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"), { readOnly: true });
    assert.equal(migratedDatabase.prepare("SELECT 1 FROM web_proxy_secret WHERE id = 1").get(), undefined);
    migratedDatabase.close();
  }
});

test("proxy settings project supported authenticated URLs while catalog and SQLite remain secret-safe", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `proxy-plaintext-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const urls = [
    "http://plain.example.test:8080",
    "https://tls.example.test:8443",
    "socks5://research%40team:p%40ss%3Aword%2Fpart%23tag%25space%20here@proxy.example.test:1080",
  ];
  const created = [];
  for (const [index, url] of urls.entries()) {
    const server = await store.createProxyServer({ kind: "custom_url", name: `Protocol ${index}`, url });
    assert.equal(server.url, new URL(url).toString());
    created.push(server);
  }

  const settings = store.getProxySettings();
  for (const server of created) {
    assert.equal(settings.servers.find((entry) => entry.id === server.id)?.url, server.url);
  }
  const updated = await store.updateProxyServer(created[0]!.id, {
    url: "socks5://new-user:new-pass@updated.example.test:1080",
  });
  assert.equal(updated.url, "socks5://new-user:new-pass@updated.example.test:1080");
  assert.equal(
    store.getProxySettings().servers.find((server) => server.id === updated.id)?.url,
    updated.url,
  );

  const database = new DatabaseSync(resolve(tempRoot, "catalog.sqlite"), { readOnly: true });
  const catalog = database.prepare("SELECT json FROM catalog_state WHERE id = 1").get() as { json: string };
  const secrets = database.prepare("SELECT encrypted_url FROM proxy_server_secrets").all() as Array<{ encrypted_url: string }>;
  database.close();
  assert.doesNotMatch(catalog.json, /research%40team|new-user|new-pass/);
  assert.equal(secrets.some((row) => /research%40team|new-user|new-pass/.test(row.encrypted_url)), false);

  const rejected = "http://leak-user:leak-password@proxy.example.test:8080/#fragment";
  await assert.rejects(
    store.createProxyServer({ kind: "custom_url", name: "Invalid", url: rejected }),
    (error: Error) => error.message === "The proxy URL cannot contain a fragment"
      && !error.message.includes("leak-user")
      && !error.message.includes("leak-password"),
  );
});

test("run event streams repair a torn tail and keep sequences monotonic", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `run-events-torn-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Torn tail");
  const session = await store.createSession(project.id, "Replay", model.id);
  const run = await store.createSessionRun({
    prompt: "Crash mid-write",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  await store.appendSessionRunEvent(session.id, run.id, { phase: "thinking", turn: 1, type: "agent.phase" });
  const streamPath = resolve(tempRoot, "run-events", session.id, run.id, "main.jsonl");
  await writeFile(streamPath, `${await readFile(streamPath, "utf8")}{"sequence":2,"createdAt":"20`, "utf8");

  assert.equal((await store.listSessionRunEvents(session.id, run.id)).length, 1, "a torn tail is ignored on read");

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  const appended = await reopened.appendSessionRunEvent(session.id, run.id, {
    phase: "thinking",
    turn: 2,
    type: "agent.phase",
  });
  assert.equal(appended.sequence, 2, "the repaired tail frees its sequence");
  const records = await reopened.listSessionRunEvents(session.id, run.id);
  assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
});

test("legacy array run event files stay readable and later appends continue their sequences", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `run-events-legacy-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Legacy replay");
  const session = await store.createSession(project.id, "Replay", model.id);
  const run = await store.createSessionRun({
    prompt: "Recorded before the stream layout",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });
  const legacy = [
    {
      createdAt: "2026-07-01T00:00:00.000Z",
      event: { droppedEvents: 7, type: "run.history.truncated" },
      runId: run.id,
      sequence: 3,
      sessionId: session.id,
    },
    {
      createdAt: "2026-07-01T00:00:01.000Z",
      event: { content: "Persisted thought", turn: 1, type: "assistant.thinking.snapshot" },
      runId: run.id,
      sequence: 4,
      sessionId: session.id,
    },
  ];
  await mkdir(resolve(tempRoot, "run-events", session.id), { recursive: true });
  await writeFile(
    resolve(tempRoot, "run-events", session.id, `${run.id}.json`),
    JSON.stringify(legacy, null, 2),
    "utf8",
  );

  const replay = await store.listSessionRunEvents(session.id, run.id);
  assert.deepEqual(replay.map((record) => record.sequence), [3, 4], "legacy records replay untouched");

  const appended = await store.appendSessionRunEvent(session.id, run.id, {
    request: {
      action: "code",
      createdAt: "2026-07-01T00:00:02.000Z",
      decidedAt: "2026-07-01T00:00:03.000Z",
      id: "permission-legacy",
      resource: "workspace-code",
      sessionId: session.id,
      state: "cancelled",
      summary: "Recovered approval",
    },
    type: "permission.resolved",
  });
  assert.equal(appended.sequence, 5, "recovery events continue after the legacy sequence");
  const merged = await store.listSessionRunEvents(session.id, run.id);
  assert.deepEqual(merged.map((record) => record.sequence), [3, 4, 5], "legacy and stream records merge in order");
});

test("run child streams append independently of the main timeline", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `run-streams-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Child streams");
  const session = await store.createSession(project.id, "Replay", model.id);
  const run = await store.createSessionRun({
    prompt: "Parallel tools",
    sessionId: session.id,
    settingsSnapshot: store.resolveRuntimeSettings(session.id).effective,
  });

  await store.appendSessionRunEvent(session.id, run.id, { phase: "thinking", turn: 1, type: "agent.phase" });
  const toolChunk = await store.appendRunStreamEvent(session.id, run.id, "tool-call-1", {
    delta: "stdout: partial",
    type: "assistant.delta",
  });
  assert.equal(toolChunk.sequence, 1, "child streams keep their own sequence space");
  assert.equal((await store.listRunStreamEvents(session.id, run.id, "tool-call-1")).length, 1);
  assert.equal((await store.listSessionRunEvents(session.id, run.id)).length, 1, "the main timeline is unaffected");
  await assert.rejects(store.appendRunStreamEvent(session.id, run.id, "../escape", { phase: "thinking", turn: 1, type: "agent.phase" }), /Invalid run stream id/);
});

test("SessionStore serializes concurrent artifact job updates and writes complete JSON", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `artifact-job-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Concurrent artifact jobs");
  const session = await store.createSession(project.id, "Downloads", model.id);
  const timestamp = new Date().toISOString();
  const jobs: ArtifactJob[] = Array.from({ length: 12 }, (_, index) => ({
    attempts: 0,
    createdAt: timestamp,
    id: `job-${index}`,
    maxAttempts: 3,
    permissionAuthorizationId: `authorization-${index}`,
    planId: `plan-${index}`,
    progress: { bytesDownloaded: 0, filesCompleted: 0, filesTotal: 1 },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "pubmed",
    sourceRecordId: `record-${index}`,
    state: "queued",
    updatedAt: timestamp,
  }));
  for (const job of jobs) await store.appendArtifactJob(job);

  await Promise.all(jobs.map((job, index) => store.replaceArtifactJob({
    ...job,
    attempts: 1,
    progress: { ...job.progress, bytesDownloaded: index + 1 },
    state: "running",
    updatedAt: new Date(Date.now() + index + 1).toISOString(),
  })));

  const persisted = await store.listArtifactJobs(session.id);
  assert.equal(persisted.length, jobs.length);
  assert.deepEqual(
    persisted.map((job) => [job.id, job.attempts, job.progress.bytesDownloaded, job.state]),
    jobs.map((job, index) => [job.id, 1, index + 1, "running"]),
  );
  const artifactJobsDirectory = resolve(tempRoot, "artifact-jobs");
  const persistedJson = await readFile(resolve(artifactJobsDirectory, `${session.id}.json`), "utf8");
  assert.doesNotThrow(() => JSON.parse(persistedJson));
  assert.deepEqual((await readdir(artifactJobsDirectory)).filter((name) => name.endsWith(".tmp")), []);
});

test("SessionStore serializes concurrent session run mutations without losing updates", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `session-run-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Concurrent session runs");
  const session = await store.createSession(project.id, "Queue", model.id);
  const settingsSnapshot = store.resolveRuntimeSettings(session.id).effective;

  const first = await store.createSessionRun({ prompt: "first prompt", sessionId: session.id, settingsSnapshot });

  // A field update of the current run racing a follow-up creation must keep both writes.
  const [updated, second] = await Promise.all([
    store.updateSessionRun(session.id, first.id, { userMessageId: "user-message-1" }),
    store.createSessionRun({ prompt: "second prompt", sessionId: session.id, settingsSnapshot }),
  ]);
  assert.equal(updated.userMessageId, "user-message-1");
  assert.equal(second.status, "queued");
  const afterRace = await store.listSessionRuns(session.id);
  assert.deepEqual(afterRace.map((run) => run.id).toSorted(), [first.id, second.id].toSorted(), "neither writer is lost");
  assert.equal(afterRace.find((run) => run.id === first.id)?.userMessageId, "user-message-1");

  // A conditional status transition racing another creation must keep both effects.
  const [started, third] = await Promise.all([
    store.updateSessionRunStatusIfCurrent(session.id, first.id, "queued", "running", { startedAt: new Date().toISOString() }),
    store.createSessionRun({ prompt: "third prompt", sessionId: session.id, settingsSnapshot }),
  ]);
  assert.equal(started?.status, "running");
  assert.ok((await store.getSessionRun(session.id, third.id)), "the concurrently created run survives the status update");

  // The conditional update keeps its guard semantics: a stale expectation changes nothing.
  assert.equal(await store.updateSessionRunStatusIfCurrent(session.id, first.id, "queued", "cancelled"), undefined);
  assert.equal((await store.getSessionRun(session.id, first.id))?.status, "running");

  const burst = await Promise.all(Array.from({ length: 8 }, (_, index) => store.createSessionRun({
    prompt: `burst prompt ${index}`,
    sessionId: session.id,
    settingsSnapshot,
  })));
  const persisted = await store.listSessionRuns(session.id);
  assert.equal(persisted.length, 3 + burst.length, "no concurrently created run is dropped");
  const queueOrders = persisted.map((run) => run.queueOrder);
  assert.equal(new Set(queueOrders).size, queueOrders.length, "queueOrder stays unique");
  assert.deepEqual(queueOrders, queueOrders.toSorted((left, right) => left - right), "listSessionRuns returns queue order");
  const persistedJson = await readFile(resolve(tempRoot, "session-runs", `${session.id}.json`), "utf8");
  assert.doesNotThrow(() => JSON.parse(persistedJson));
});

test("SessionStore serializes concurrent execution appends without losing provenance", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `execution-run-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({ apiToken: "token", baseUrl: "https://models.example.test/v1", model: "model", name: "Model" });
  const project = await store.createProject("Concurrent execution runs");
  const session = await store.createSession(project.id, "Executions", model.id);
  const timestamp = new Date().toISOString();
  const ref = { hash: "0".repeat(64), size: 0 };
  const runs: ExecutionRun[] = Array.from({ length: 12 }, (_, index) => ({
    cgroupMode: "none", code: ref, createdFiles: [], environmentRevisionId: "system-python3-bwrap-v1",
    envSnapshot: ref, exitCode: 0, finishedAt: timestamp, id: `execution-${index}`,
    kernelId: `ephemeral:execution-${index}`, kernelMode: "ephemeral", language: "python",
    modifiedFiles: [], networkPolicy: "none", permissionEpochId: session.permissionEpochId,
    runnerVersion: "test", sandbox: "bubblewrap", sessionId: session.id, startedAt: timestamp,
    status: "succeeded", stderr: ref, stdout: ref, tool: "run_python", toolVersion: "test",
    turnId: `turn-${index}`, workingDirectory: `/workspace/subagents/${index}`,
  }));
  await Promise.all(runs.map((run) => store.appendExecutionRun(run)));
  assert.deepEqual((await store.listExecutionRuns(session.id)).map((run) => run.id), runs.map((run) => run.id));
});

test("SessionStore encrypts model API tokens and preserves them across reloads", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-model-secrets-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "stored-provider-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Science model",
  });
  assert.equal(model.hasApiToken, true);
  assert.equal(store.getModelApiToken(model.id), "stored-provider-token");
  const sqliteFiles = await Promise.all(["catalog.sqlite", "catalog.sqlite-wal"].map(async (name) => {
    try {
      return await readFile(resolve(tempRoot, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
      throw error;
    }
  }));
  assert.doesNotMatch(Buffer.concat(sqliteFiles).toString("utf8"), /stored-provider-token/);
  assert.equal((await readFile(resolve(tempRoot, "model-secrets.key"))).length, 32);
  assert.equal((await stat(resolve(tempRoot, "model-secrets.key"))).mode & 0o777, 0o600);

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.equal(reopened.getModel(model.id)?.hasApiToken, true);
  assert.equal(reopened.getModelApiToken(model.id), "stored-provider-token");

  await reopened.updateModel(model.id, {
    baseUrl: model.baseUrl,
    model: model.model,
    name: "Renamed science model",
    vision: true,
  });
  assert.equal(reopened.getModelApiToken(model.id), "stored-provider-token");

  const cleared = await reopened.updateModel(model.id, {
    apiToken: null,
    baseUrl: model.baseUrl,
    model: model.model,
    name: model.name,
    vision: false,
  });
  assert.equal(cleared.hasApiToken, false);
  assert.equal(reopened.getModelApiToken(model.id), undefined);
});

test("SessionStore removes the legacy demo profile and reassigns sessions to a configured model", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-demo-migration-${Date.now()}-${process.pid}`);
  await mkdir(resolve(tempRoot, "messages"), { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const now = new Date().toISOString();
  await writeFile(resolve(tempRoot, "catalog.json"), `${JSON.stringify({
    models: [
      {
        baseUrl: "",
        builtin: true,
        createdAt: "1970-01-01T00:00:00.000Z",
        demoMode: true,
        id: "builtin-demo",
        model: "deterministic-demo",
        name: "Deterministic demo",
        updatedAt: "1970-01-01T00:00:00.000Z",
        vision: false,
      },
      {
        baseUrl: "https://models.example.test/v1",
        builtin: false,
        createdAt: now,
        demoMode: false,
        id: "configured-model",
        model: "science-model",
        name: "Science model",
        updatedAt: now,
        vision: true,
      },
    ],
    projects: [{ createdAt: now, id: "project-1", name: "Legacy project" }],
    sessions: [{
      approvalMode: "always_allow",
      createdAt: now,
      id: "session-1",
      modelId: "builtin-demo",
      projectId: "project-1",
      reviewModelId: "builtin-demo",
      title: "Legacy task",
      updatedAt: now,
    }, {
      approvalMode: "never_ask",
      createdAt: now,
      id: "session-2",
      modelId: "configured-model",
      projectId: "project-1",
      reviewModelId: "configured-model",
      title: "Legacy never-ask task",
      updatedAt: now,
    }],
  }, null, 2)}\n`, "utf8");
  await writeFile(resolve(tempRoot, "messages", "session-1.json"), "[]\n", "utf8");

  const store = new SessionStore(tempRoot);
  await store.load();

  assert.deepEqual(store.listModels().map((model) => model.id), ["configured-model"]);
  assert.equal(store.getSession("session-1")?.modelId, "configured-model");
  assert.equal(store.getSession("session-1")?.reviewModelId, "configured-model");
  assert.equal(store.getSession("session-1")?.approvalMode, "always_allow");
  assert.equal(store.getSession("session-2")?.approvalMode, "always_allow");
  assert.ok(store.getSession("session-1")?.permissionEpochId);
  const migrated = await readPersistedCatalog(tempRoot);
  assert.equal(migrated.models.length, 1);
  assert.equal(migrated.models[0]?.id, "configured-model");
  assert.equal("builtin" in migrated.models[0]!, false);
  assert.equal("demoMode" in migrated.models[0]!, false);
  assert.equal(migrated.sessions[0]?.modelId, "configured-model");
  assert.equal(migrated.sessions[0]?.reviewModelId, "configured-model");
  assert.equal(migrated.sessions[0]?.approvalMode, "always_allow");
  const migratedNeverAsk = migrated.sessions.find((session) => session.id === "session-2");
  assert.equal(migratedNeverAsk?.approvalMode, "always_allow");
  assert.deepEqual(migrated.sessions[0]?.settingsOverrides, {
    enabledConnectorIds: [],
    modelId: "configured-model",
    reviewModelId: "configured-model",
    semanticReviewEnabled: true,
  });
  assert.deepEqual(migrated.projects[0]?.settingsOverrides, {});
});

test("SessionStore leaves legacy sessions unassigned when no configured model exists", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-empty-migration-${Date.now()}-${process.pid}`);
  await mkdir(resolve(tempRoot, "messages"), { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const now = new Date().toISOString();
  await writeFile(resolve(tempRoot, "catalog.json"), `${JSON.stringify({
    projects: [{ createdAt: now, id: "project-1", name: "Legacy project" }],
    sessions: [{ createdAt: now, id: "session-1", projectId: "project-1", title: "Legacy task", updatedAt: now }],
  }, null, 2)}\n`, "utf8");
  await writeFile(resolve(tempRoot, "messages", "session-1.json"), "[]\n", "utf8");

  const store = new SessionStore(tempRoot);
  await store.load();

  assert.deepEqual(store.listModels(), []);
  assert.equal(store.getSession("session-1")?.modelId, undefined);
  assert.equal(store.getSession("session-1")?.reviewModelId, undefined);
  assert.equal(store.getSessionPermissionEpoch("session-1")?.networkPolicy, "none");
  const migrated = await readPersistedCatalog(tempRoot);
  assert.deepEqual(migrated.models, []);
  assert.equal("modelId" in migrated.sessions[0]!, false);
  assert.equal(migrated.sessions[0]?.permissionEpochId, migrated.permissionEpochs[0]?.id);
});

test("SessionStore migrates legacy delegation tracks into subagent records", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-subagent-migration-${Date.now()}-${process.pid}`);
  await mkdir(resolve(tempRoot, "messages"), { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const now = new Date().toISOString();
  await writeFile(resolve(tempRoot, "catalog.json"), `${JSON.stringify({
    delegationTracks: [{
      brief: {
        allowedToolNames: ["read_file"],
        expectedOutputPaths: ["report.md"],
        intendedSteps: ["Read inputs", "Write report"],
        outputSchema: "Markdown report",
        role: "Analyst",
        title: "Legacy analysis",
      },
      createdAt: now,
      id: "legacy-track",
      outputPaths: ["report.md"],
      parentTurnId: "turn-1",
      sessionId: "session-1",
      status: "completed",
      transcript: [{ content: "Done", createdAt: now, id: "message-1", kind: "assistant" }],
    }],
    projects: [{ createdAt: now, id: "project-1", name: "Legacy project" }],
    sessions: [{ createdAt: now, id: "session-1", projectId: "project-1", title: "Legacy session", updatedAt: now }],
  })}\n`, "utf8");
  await writeFile(resolve(tempRoot, "messages", "session-1.json"), "[]\n", "utf8");

  const store = new SessionStore(tempRoot);
  await store.load();

  const [subagent] = store.listSubagents("session-1");
  assert.equal(subagent?.id, "legacy-track");
  assert.equal(subagent?.input.description, "Legacy analysis");
  assert.match(subagent?.input.prompt ?? "", /Intended steps/);
  assert.equal(subagent?.maxTurns, DEFAULT_SUBAGENT_MAX_TURNS);
  assert.equal(subagent?.timeoutSeconds, DEFAULT_SUBAGENT_TIMEOUT_SECONDS);
  assert.deepEqual(subagent?.steps.map((step) => step.content), ["Done"]);
  const persisted = await readPersistedCatalog(tempRoot) as PersistedCatalog & Record<string, unknown>;
  assert.equal("delegationTracks" in persisted, false);
  assert.equal(Array.isArray(persisted.subagents), true);
});

test("SessionStore migrates legacy runtime settings once and preserves effective values across reloads", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-settings-migration-${Date.now()}-${process.pid}`);
  await mkdir(resolve(tempRoot, "messages"), { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const now = new Date().toISOString();
  await writeFile(resolve(tempRoot, "catalog.json"), `${JSON.stringify({
    models: [{
      baseUrl: "https://models.example.test/v1",
      createdAt: now,
      id: "configured-model",
      model: "science-model",
      name: "Science model",
      updatedAt: now,
      vision: false,
    }],
    projects: [{ createdAt: now, id: "project-1", name: "Legacy project" }],
    sessions: [{
      createdAt: now,
      enabledConnectorIds: ["pubmed", "uniprot"],
      enabledSkillIds: [],
      id: "session-1",
      modelId: "configured-model",
      projectId: "project-1",
      semanticReviewEnabled: false,
      title: "Legacy task",
      updatedAt: now,
    }],
  }, null, 2)}\n`, "utf8");
  await writeFile(resolve(tempRoot, "messages", "session-1.json"), "[]\n", "utf8");

  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds(["life-science-evidence-brief", "managed-skill"]);
  await store.load();
  // The legacy session carried an empty skill whitelist; under the `all` default
  // it now resolves to the whole installed catalog instead of nothing.
  assert.deepEqual(store.getSessionSettings("session-1"), {
    effective: {
      enabledConnectorIds: ["pubmed", "uniprot"],
      enabledSkillIds: ["life-science-evidence-brief", "managed-skill"],
      modelId: "configured-model",
      reviewModelId: "configured-model",
      semanticReviewEnabled: false,
      skillSelectionMode: "all",
    },
    overrides: {
      enabledConnectorIds: ["pubmed", "uniprot"],
      modelId: "configured-model",
      reviewModelId: "configured-model",
      semanticReviewEnabled: false,
    },
    sources: {
      enabledConnectorIds: "session",
      enabledSkillIds: "unset",
      modelId: "session",
      reviewModelId: "session",
      semanticReviewEnabled: "session",
      skillSelectionMode: "unset",
    },
  });
  const firstPersisted = await readPersistedCatalog(tempRoot);

  const reopened = new SessionStore(tempRoot);
  reopened.setAvailableSkillIds(["life-science-evidence-brief", "managed-skill"]);
  await reopened.load();
  assert.deepEqual(reopened.getSessionSettings("session-1"), store.getSessionSettings("session-1"));
  assert.deepEqual(await readPersistedCatalog(tempRoot), firstPersisted);
});

test("SessionStore resolves and persists hierarchical runtime settings", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-settings-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds(["life-science-evidence-brief", "managed-skill"]);
  await store.load();
  const modelA = await store.createModel({
    apiToken: "token-a",
    baseUrl: "https://models.example.test/a",
    model: "model-a",
    name: "Model A",
  });
  const modelB = await store.createModel({
    apiToken: "token-b",
    baseUrl: "https://models.example.test/b",
    model: "model-b",
    name: "Model B",
  });
  await store.replaceGlobalSettings({
    enabledConnectorIds: ["pubmed"],
    modelId: modelA.id,
    reviewModelId: modelA.id,
    semanticReviewEnabled: true,
  });
  const project = await store.createProject("Hierarchical project", {
    enabledConnectorIds: [],
    enabledSkillIds: ["life-science-evidence-brief"],
    modelId: modelB.id,
    skillSelectionMode: "selected",
  });
  const session = await store.createSession(project.id, "Inherited session", {
    reviewModelId: modelB.id,
  });

  assert.deepEqual(store.getSessionSettings(session.id), {
    effective: {
      enabledConnectorIds: [],
      enabledSkillIds: ["life-science-evidence-brief"],
      modelId: modelB.id,
      reviewModelId: modelB.id,
      semanticReviewEnabled: true,
      skillSelectionMode: "selected",
    },
    overrides: { reviewModelId: modelB.id },
    sources: {
      enabledConnectorIds: "project",
      enabledSkillIds: "project",
      modelId: "project",
      reviewModelId: "session",
      semanticReviewEnabled: "global",
      skillSelectionMode: "project",
    },
  });

  await store.replaceProjectSettings(project.id, { modelId: modelA.id });
  assert.equal(store.resolveRuntimeSettings(session.id).effective.modelId, modelA.id);
  assert.equal(store.getSession(session.id)?.modelId, modelA.id);

  await store.replaceSessionSettings(session.id, {
    enabledConnectorIds: [],
    modelId: modelB.id,
  });
  await store.replaceProjectSettings(project.id, { modelId: modelA.id, semanticReviewEnabled: false });
  const overridden = store.getSessionSettings(session.id);
  assert.equal(overridden.effective.modelId, modelB.id);
  assert.equal(overridden.sources.modelId, "session");
  assert.deepEqual(overridden.effective.enabledConnectorIds, []);
  assert.equal(overridden.effective.semanticReviewEnabled, false);
  assert.equal(overridden.sources.semanticReviewEnabled, "project");

  const reopened = new SessionStore(tempRoot);
  reopened.setAvailableSkillIds(["life-science-evidence-brief", "managed-skill"]);
  await reopened.load();
  assert.deepEqual(reopened.getSessionSettings(session.id), overridden);
});

test("SessionStore seeds, validates, and persists product timeout settings", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-timeouts-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const seeded = new SessionStore(tempRoot, {
    gatewayIdleTimeoutMs: 12_000,
    gatewayTurnTimeoutMs: 0,
    kernelIdleTimeoutMs: 0,
    permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0,
  });
  await seeded.load();
  assert.deepEqual(seeded.getTimeoutSettings(), {
    gatewayIdleTimeoutMs: 12_000,
    gatewayTurnTimeoutMs: 0,
    kernelIdleTimeoutMs: 0,
    permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0,
  });
  assert.deepEqual(seeded.getQuotaSettings(), {
    runnerMaxOutputBytes: 1_073_741_824,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    uploadMaxFileBytes: 1_073_741_824,
    uploadMaxRequestBytes: 10_737_418_240,
  });

  const saved = await seeded.replaceTimeoutSettings({
    gatewayIdleTimeoutMs: 240_000,
    gatewayTurnTimeoutMs: 1_200_000,
    kernelIdleTimeoutMs: 90_000,
    permissionWaitTimeoutMs: 30_000,
    runnerExecTimeoutMs: 120_000,
  });
  await assert.rejects(
    seeded.replaceTimeoutSettings({ ...saved, runnerExecTimeoutMs: -1 }),
    /non-negative integer/,
  );
  await assert.rejects(
    seeded.replaceTimeoutSettings({
      ...saved,
      gatewayIdleTimeoutMs: 240_000,
      gatewayTurnTimeoutMs: 120_000,
    }),
    /gatewayTurnTimeoutMs must be greater than or equal to gatewayIdleTimeoutMs when both timeouts are finite/,
  );
  assert.deepEqual(seeded.getTimeoutSettings(), saved);
  const quotas = await seeded.replaceQuotaSettings({
    runnerMaxOutputBytes: 0,
    runnerMaxWorkspaceBytes: 0,
    uploadMaxFileBytes: 0,
    uploadMaxRequestBytes: 0,
  });
  assert.deepEqual(quotas, {
    runnerMaxOutputBytes: 0,
    runnerMaxWorkspaceBytes: 0,
    uploadMaxFileBytes: 0,
    uploadMaxRequestBytes: 0,
  });
  await assert.rejects(
    seeded.replaceQuotaSettings({
      runnerMaxOutputBytes: -1,
      runnerMaxWorkspaceBytes: 0,
      uploadMaxFileBytes: 0,
      uploadMaxRequestBytes: 0,
    }),
    /non-negative integer number of bytes/,
  );

  const reopened = new SessionStore(tempRoot, {
    gatewayIdleTimeoutMs: 1,
    gatewayTurnTimeoutMs: 1,
    kernelIdleTimeoutMs: 1,
    permissionWaitTimeoutMs: 1,
    runnerExecTimeoutMs: 1,
  });
  await reopened.load();
  assert.deepEqual(reopened.getTimeoutSettings(), saved);
  assert.deepEqual(reopened.getQuotaSettings(), quotas);
});

test("SessionStore seeds, validates, and persists memory-graph settings + password", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-memory-graph-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  // Default state: disabled, no password, defaults for Bolt/User.
  const store = new SessionStore(tempRoot);
  await store.load();
  assert.deepEqual(store.getMemoryGraphSettings(), {
    enabled: false,
    neo4jHttp: "http://127.0.0.1:7474",
    neo4jUser: "neo4j",
    hasNeo4jPassword: false,
  });
  assert.equal(store.getMemoryGraphNeo4jPassword(), undefined);

  // 2B: saving the password alone does NOT flip enabled.
  const initialPassword = `pw-${randomUUID()}`;
  await store.updateMemoryGraphSettings({ neo4jPassword: initialPassword });
  assert.equal(store.getMemoryGraphSettings().enabled, false);
  assert.equal(store.getMemoryGraphSettings().hasNeo4jPassword, true);
  assert.equal(store.getMemoryGraphNeo4jPassword(), initialPassword);

  // Toggling enabled + changing HTTP/User in the same PUT.
  const updated = await store.updateMemoryGraphSettings({
    enabled: true,
    neo4jHttp: "http://neo4j.local:7474",
    neo4jUser: "graph",
  });
  assert.deepEqual(updated, {
    enabled: true,
    neo4jHttp: "http://neo4j.local:7474",
    neo4jUser: "graph",
    hasNeo4jPassword: true,
  });

  // Replacing the password (non-null overwrites).
  const replacementPassword = `pw-${randomUUID()}`;
  await store.updateMemoryGraphSettings({ neo4jPassword: replacementPassword });
  assert.equal(store.getMemoryGraphNeo4jPassword(), replacementPassword);

  // Removing the password (null clears it; hasNeo4jPassword flips back).
  const cleared = await store.updateMemoryGraphSettings({ neo4jPassword: null });
  assert.equal(cleared.hasNeo4jPassword, false);
  assert.equal(store.getMemoryGraphNeo4jPassword(), undefined);

  // Validation: unknown keys are dropped silently (a leftover pre-HTTP
  // `neo4jBolt` key in an old catalog row must not wedge boot). Keep enabled
  // at its current value (true) so the reopen assertion below still holds.
  const withUnknown = await store.updateMemoryGraphSettings({ bogus: true, enabled: true } as never);
  assert.equal(withUnknown.enabled, true);
  assert.equal("bogus" in withUnknown, false);
  // Validation: empty password rejected.
  await assert.rejects(store.updateMemoryGraphSettings({ neo4jPassword: "   " }), /cannot be empty/);

  // Persistence across reopen (settings survive; password survives encryption).
  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.deepEqual(reopened.getMemoryGraphSettings(), {
    enabled: true,
    neo4jHttp: "http://neo4j.local:7474",
    neo4jUser: "graph",
    hasNeo4jPassword: false,
  });
});

test("SessionStore tolerates a legacy neo4jBolt key without wedging boot", () => {
  // Regression: a catalog row written before the Bolt→HTTP rename carries a
  // `neo4jBolt` key (and no `neo4jHttp`). normalizeMemoryGraphSettings must
  // drop the unknown key silently (not throw "Unknown memory-graph setting")
  // so the API still boots; the current `neo4jHttp` field falls back to its
  // default until re-configured in the UI. The stale bolt value is NOT used.
  const settings = normalizeMemoryGraphSettings({
    enabled: true,
    neo4jBolt: "bolt://127.0.0.1:7687",  // legacy key — must be ignored
    neo4jUser: "graph",
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.neo4jHttp, "http://127.0.0.1:7474"); // default fallback
  assert.equal(settings.neo4jUser, "graph");
});

test("SessionStore seeds the memory-graph password from env on first load only", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-memory-graph-seed-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  // First load with an env password seed → store picks it up.
  const seeded = new SessionStore(tempRoot, undefined, undefined, "env-seed-password");
  await seeded.load();
  assert.equal(seeded.getMemoryGraphSettings().hasNeo4jPassword, true);
  assert.equal(seeded.getMemoryGraphNeo4jPassword(), "env-seed-password");

  // Second load, env seed removed (simulating the user migrating to the UI):
  // the store retains the previously-seeded password — env is one-time only.
  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.equal(reopened.getMemoryGraphSettings().hasNeo4jPassword, true);
  assert.equal(reopened.getMemoryGraphNeo4jPassword(), "env-seed-password");
});

test("SessionStore preserves managed skill selections when the catalog is restored before settings migration", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-managed-skills-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const availableSkills = ["life-science-evidence-brief", "managed-skill"];

  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds(availableSkills);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  await store.replaceGlobalSettings({ modelId: model.id });
  const project = await store.createProject("Managed skill project", {
    enabledSkillIds: ["managed-skill"],
    skillSelectionMode: "selected",
  });
  const session = await store.createSession(project.id, "Managed skill session");
  assert.deepEqual(store.resolveRuntimeSettings(session.id).effective.enabledSkillIds, ["managed-skill"]);
  assert.deepEqual(store.getSkillDeletionImpact("managed-skill").references, [{
    id: project.id,
    label: "Managed skill project",
    scope: "project",
  }]);

  const reopened = new SessionStore(tempRoot);
  reopened.setAvailableSkillIds(availableSkills);
  await reopened.load();
  assert.deepEqual(reopened.resolveRuntimeSettings(session.id).effective.enabledSkillIds, ["managed-skill"]);
});

test("skill selection defaults to all, is configured from Project down, and ignores Global", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-skill-modes-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const availableSkills = ["docking", "evidence-brief", "report-writer"];

  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds(availableSkills);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });

  // Global accepts the write but never contributes to skill resolution.
  await store.replaceGlobalSettings({ enabledSkillIds: ["docking"], modelId: model.id, skillSelectionMode: "selected" });
  assert.deepEqual(store.getGlobalSettings().overrides, { modelId: model.id });

  const project = await store.createProject("Skill mode project");
  const session = await store.createSession(project.id, "Skill mode session");
  const effective = store.resolveRuntimeSettings(session.id).effective;
  assert.equal(effective.skillSelectionMode, "all");
  assert.deepEqual(effective.enabledSkillIds, availableSkills);
  assert.deepEqual(store.getSession(session.id)?.enabledSkillIds, availableSkills);

  // Project narrows the set; the Session inherits mode and whitelist.
  await store.replaceProjectSettings(project.id, {
    enabledSkillIds: ["docking", "report-writer"],
    skillSelectionMode: "selected",
  });
  assert.deepEqual(store.resolveRuntimeSettings(session.id).effective.enabledSkillIds, ["docking", "report-writer"]);
  assert.deepEqual(store.getSession(session.id)?.enabledSkillIds, ["docking", "report-writer"]);

  // A Session may override back to all, or to its own narrower whitelist.
  await store.replaceSessionSettings(session.id, { skillSelectionMode: "all" });
  assert.deepEqual(store.resolveRuntimeSettings(session.id).effective.enabledSkillIds, availableSkills);
  await store.replaceSessionSettings(session.id, {
    enabledSkillIds: ["evidence-brief"],
    skillSelectionMode: "selected",
  });
  const overridden = store.getSessionSettings(session.id);
  assert.deepEqual(overridden.effective.enabledSkillIds, ["evidence-brief"]);
  assert.equal(overridden.sources.skillSelectionMode, "session");

  // Installing a skill immediately widens every `all`-mode Session.
  await store.replaceSessionSettings(session.id, {});
  store.setAvailableSkillIds([...availableSkills, "late-skill"]);
  assert.deepEqual(store.getSession(session.id)?.enabledSkillIds, ["docking", "report-writer"]);
  await store.replaceProjectSettings(project.id, {});
  assert.deepEqual(store.getSession(session.id)?.enabledSkillIds, [...availableSkills, "late-skill"]);
});

test("SessionStore rejects invalid settings atomically and protects referenced models", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-settings-validation-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const projectCount = store.listProjects().length;
  await assert.rejects(store.createProject("Invalid project", { modelId: "missing" }), /existing model profile/);
  assert.equal(store.listProjects().length, projectCount);
  await store.replaceGlobalSettings({ modelId: model.id });
  const project = await store.createProject("Validation project");
  const before = store.getGlobalSettings();

  await assert.rejects(store.replaceGlobalSettings({ unknown: true }), /Unknown runtime setting/);
  await assert.rejects(store.replaceGlobalSettings({ enabledConnectorIds: ["unknown"] }), /unknown value/);
  await assert.rejects(store.replaceGlobalSettings({ enabledSkillIds: ["unknown"] }), /unknown value/);
  await assert.rejects(store.replaceGlobalSettings({ modelId: "missing" }), /existing model profile/);
  await assert.rejects(store.replaceGlobalSettings({ semanticReviewEnabled: "yes" }), /must be a boolean/);
  assert.deepEqual(store.getGlobalSettings(), before);

  await assert.rejects(store.deleteModel(model.id), /referenced by runtime settings/);
  await store.replaceGlobalSettings({});
  await store.replaceProjectSettings(project.id, { reviewModelId: model.id });
  await assert.rejects(store.deleteModel(model.id), /referenced by runtime settings/);
  await store.replaceProjectSettings(project.id, {});
  const session = await store.createSession(project.id, "Explicit model", { modelId: model.id });
  await assert.rejects(store.deleteModel(model.id), /referenced by runtime settings/);
  await store.replaceSessionSettings(session.id, {});
  await store.deleteModel(model.id);
  assert.equal(store.getModel(model.id), undefined);
});

test("SessionStore validates the effective task model before creating Session data", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-session-validation-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const project = await store.createProject("No model project");
  await assert.rejects(store.createSession(project.id, "Missing model"), /task model is required/);
  assert.deepEqual(store.listSessions(project.id), []);

  const model = await store.createModel({
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Tokenless model",
  });
  await assert.rejects(
    store.createSession(project.id, "Tokenless model", { modelId: model.id }),
    /must have a saved API token/,
  );
  assert.deepEqual(store.listSessions(project.id), []);
});

test("SessionStore defaults the global task model to the first configured model", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-model-default-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();

  // The first model claims the unset global slot, so adding a model is enough
  // to create sessions without a separate selection step.
  const first = await store.createModel({
    apiToken: "token-1",
    baseUrl: "https://models.example.test/v1",
    model: "model-1",
    name: "First model",
  });
  assert.equal(store.getGlobalSettings().overrides.modelId, first.id);
  const project = await store.createProject("Defaulted model project");
  const session = await store.createSession(project.id, "Works with defaults");
  assert.equal(session.modelId, first.id);

  // A later model never overrides the earlier choice.
  const second = await store.createModel({
    apiToken: "token-2",
    baseUrl: "https://models.example.test/v1",
    model: "model-2",
    name: "Second model",
  });
  assert.equal(store.getGlobalSettings().overrides.modelId, first.id);

  // Legacy catalogs (models configured before auto-defaulting) heal when a
  // usable model is re-saved.
  await store.replaceGlobalSettings({});
  assert.equal(store.getGlobalSettings().overrides.modelId, undefined);
  await store.updateModel(second.id, {
    apiToken: "token-2-rotated",
    baseUrl: "https://models.example.test/v1",
    model: "model-2",
    name: "Second model",
  });
  assert.equal(store.getGlobalSettings().overrides.modelId, second.id);
});

test("SessionStore persists validated Project and Session renames", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-rename-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  await store.replaceGlobalSettings({ modelId: model.id });
  const project = await store.createProject("Original project");
  const session = await store.createSession(project.id, "Original session");

  assert.equal((await store.updateProject(project.id, { name: "  Renamed   project  " })).name, "Renamed project");
  assert.equal((await store.updateSession(session.id, { title: "  Renamed   session  " })).title, "Renamed session");
  await assert.rejects(store.updateProject(project.id, { name: "   " }), /Project name is required/);
  await assert.rejects(store.updateSession(session.id, { title: "   " }), /Session title is required/);
  assert.equal(store.getProject(project.id)?.name, "Renamed project");
  assert.equal(store.getSession(session.id)?.title, "Renamed session");

  const generatedTitle = "Detailed cross-cohort single-cell expression and treatment response analysis ".repeat(3).trim();
  assert.ok(generatedTitle.length > 120);
  assert.equal(
    (await store.compareAndSetSessionTitle(session.id, "Renamed session", generatedTitle))?.title,
    generatedTitle,
  );

  const persisted = await readPersistedCatalog(tempRoot);
  assert.equal(persisted.projects.find((item) => item.id === project.id)?.name, "Renamed project");
  assert.equal(persisted.sessions.find((item) => item.id === session.id)?.title, generatedTitle);

  await store.archiveSession(session.id);
  await assert.rejects(store.updateSession(session.id, { title: "Blocked rename" }), /archived and read-only/);
});

test("SessionStore archives Sessions as read-only and restores all historical data", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-archive-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Archive project");
  const session = await store.createSession(project.id, "Archive session", model.id);
  await store.appendMessage(session.id, "user", "Historical message");
  await writeFile(resolve(store.workspacePath(session.id), "historical.txt"), "preserved", "utf8");

  const archived = await store.archiveSession(session.id);
  assert.ok(archived.archivedAt);
  assert.deepEqual(store.listSessions(project.id), []);
  assert.deepEqual(store.listSessions(project.id, "archived").map((item) => item.id), [session.id]);
  assert.deepEqual(store.listSessions(project.id, "all").map((item) => item.id), [session.id]);
  assert.equal((await store.readMessages(session.id))[0]?.content, "Historical message");
  assert.equal(await readFile(resolve(store.workspacePath(session.id), "historical.txt"), "utf8"), "preserved");
  await assert.rejects(store.replaceSessionSettings(session.id, {}), /archived and read-only/);
  await assert.rejects(store.rotatePermissionEpoch(session.id, "blocked"), /archived and read-only/);
  await assert.rejects(store.appendMessage(session.id, "user", "blocked"), /archived and read-only/);

  const restored = await store.restoreSession(session.id);
  assert.equal(restored.archivedAt, undefined);
  assert.deepEqual(store.listSessions(project.id).map((item) => item.id), [session.id]);
  await store.appendMessage(session.id, "user", "After restore");
  assert.equal((await store.readMessages(session.id)).length, 2);
});

test("SessionStore permanently deletes Session and Project cascades from catalog and disk", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-delete-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Delete project");
  const first = await store.createSession(project.id, "First", model.id);
  const second = await store.createSession(project.id, "Second", model.id);
  await store.archiveSession(second.id);
  const firstEpochId = first.permissionEpochId;

  const populatePaths = async (sessionId: string) => {
    for (const path of store.sessionDataPaths(sessionId)) {
      if (path.endsWith(".json")) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "[]\n", "utf8");
      } else {
        await mkdir(path, { recursive: true });
        await writeFile(resolve(path, "marker.txt"), "data", "utf8");
      }
    }
  };
  await populatePaths(first.id);
  await populatePaths(second.id);
  const firstPaths = store.sessionDataPaths(first.id);
  const secondPaths = store.sessionDataPaths(second.id);
  const artifact = await store.createArtifactVersion({
    content: { hash: "a".repeat(64), size: 1 },
    kind: "other",
    logicalName: "extensionless-result",
    mediaType: "application/octet-stream",
    origin: "llm_declared",
    sessionId: first.id,
    sourcePath: "extensionless-result",
  });

  assert.equal(store.getProjectDeletionImpact(project.id).totalSessionCount, 2);
  assert.equal(store.getProjectDeletionImpact(project.id).archivedSessionCount, 1);
  await assert.rejects(store.deleteSession(first.id, "wrong"), /confirmation does not match/);
  assert.ok(store.getSession(first.id));
  await store.deleteSession(first.id, first.id);
  assert.equal(store.getSession(first.id), undefined);
  assert.equal(store.getPermissionEpoch(firstEpochId), undefined);
  assert.equal(store.listProjectArtifacts(project.id)[0]?.id, artifact.artifact.id);
  assert.equal(store.listProjectArtifactVersions(project.id, artifact.artifact.id)[0]?.id, artifact.version.id);
  for (const path of firstPaths) await assert.rejects(stat(path), { code: "ENOENT" });

  await assert.rejects(store.deleteProject(project.id, "wrong"), /confirmation does not match/);
  assert.ok(store.getProject(project.id));
  await store.deleteProject(project.id, project.id);
  assert.equal(store.getProject(project.id), undefined);
  assert.equal(store.getSession(second.id), undefined);
  for (const path of secondPaths) await assert.rejects(stat(path), { code: "ENOENT" });
});

test("SessionStore preserves data when deletion staging cannot start", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-delete-rollback-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Rollback project");
  const session = await store.createSession(project.id, "Rollback session", model.id);
  const messagePath = store.sessionDataPaths(session.id)[0]!;
  await writeFile(resolve(tempRoot, ".trash"), "not a directory", "utf8");

  await assert.rejects(store.deleteSession(session.id, session.id));
  assert.ok(store.getSession(session.id));
  assert.equal(await readFile(messagePath, "utf8"), "[]\n");
});

test("SessionStore recovers uncommitted trash and removes committed orphan trash on startup", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-trash-recovery-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
  });
  const project = await store.createProject("Recovery project");
  const session = await store.createSession(project.id, "Recovery session", model.id);
  await store.appendMessage(session.id, "user", "Recover me");
  const messagePath = store.sessionDataPaths(session.id)[0]!;

  const activeRoot = resolve(tempRoot, ".trash", "active-operation");
  const activeStaged = resolve(activeRoot, "data", "messages", `${session.id}.json`);
  await mkdir(dirname(activeStaged), { recursive: true });
  await rename(messagePath, activeStaged);
  await writeFile(resolve(activeRoot, "operation.json"), `${JSON.stringify({
    entries: [{ source: messagePath, staged: activeStaged }],
    root: activeRoot,
    sessionIds: [session.id],
  })}\n`, "utf8");

  const orphanRoot = resolve(tempRoot, ".trash", "orphan-operation");
  const orphanStaged = resolve(orphanRoot, "data", "messages", "missing.json");
  await mkdir(dirname(orphanStaged), { recursive: true });
  await writeFile(orphanStaged, "[]\n", "utf8");
  await writeFile(resolve(orphanRoot, "operation.json"), `${JSON.stringify({
    entries: [{ source: resolve(tempRoot, "messages", "missing.json"), staged: orphanStaged }],
    root: orphanRoot,
    sessionIds: ["missing-session"],
  })}\n`, "utf8");

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.equal((await reopened.readMessages(session.id))[0]?.content, "Recover me");
  await assert.rejects(stat(activeRoot), { code: "ENOENT" });
  await assert.rejects(stat(orphanRoot), { code: "ENOENT" });
  assert.equal(reopened.getSession("missing-session"), undefined);
});

test("SessionStore records plans without coupling them to approval policy", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-plans-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "plan-test-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Plan test model",
  });
  const project = await store.createProject("Planning", { modelId: model.id, reviewModelId: model.id });
  const manual = await store.createSession(project.id, "Manual planning", {}, { approvalMode: "ask_for_dangerous" });
  const proposed = await store.proposeSessionPlan(manual.id, {
    caveats: ["Dataset coverage must be checked"],
    feasibilityConfidence: "medium",
    scope: "Analyze the study in two phases",
    steps: ["Inspect inputs", "Run analysis"],
  });
  assert.equal(proposed.state, "recorded");
  assert.doesNotThrow(() => store.assertSessionWritable(manual.id));

  const revised = await store.reviseSessionPlan(manual.id, proposed.id, {
    caveats: [],
    expectedVersion: proposed.version,
    feasibilityConfidence: "high",
    scope: "Analyze the study with an explicit validation phase",
    steps: ["Inspect inputs", "Run analysis", "Validate findings"],
  });
  assert.equal(revised.version, 2);
  const automatic = await store.createSession(project.id, "Automatic planning", {}, { approvalMode: "always_allow" });
  const autoPlan = await store.proposeSessionPlan(automatic.id, {
    feasibilityConfidence: "high",
    scope: "Run a bounded descriptive analysis",
    steps: ["Summarize inputs", "Write results"],
  });
  assert.equal(autoPlan.state, "recorded");
  assert.doesNotThrow(() => store.assertSessionWritable(automatic.id));
});

test("SessionStore persists specialists and isolated subagents", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-specialists-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "specialist-test-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Specialist test model",
  });
  const specialist = await store.createSpecialist({
    connectorIds: ["arxiv"],
    description: "Reviews statistical claims, assumptions, and limitations.",
    enabledSkillIds: [],
    instructions: "Review statistical claims and report limitations.",
    name: "Statistical reviewer",
  });
  const project = await store.createProject("Subagents", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Subagent session", {}, {
    approvalMode: "always_allow",
    specialistId: specialist.id,
  });
  const subagent = await store.createSubagent(session.id, "turn-1", {
    brief: {
      collaborationRules: ["Work independently", "Return one final JSON object"],
      constraints: ["Use only provided inputs"],
      goal: "Review statistical claims and identify limitations",
      outputJsonSchema: {
        properties: { findings: { type: "array" }, limitations: { type: "array" } },
        required: ["findings"],
        type: "object",
      },
      outputRequirements: ["Return findings and limitations"],
      version: 1,
    },
    description: "Statistical review",
    prompt: "Read the results, check estimates, and report findings and limitations.",
    specialistId: specialist.id,
    subagentType: "general-purpose",
  });
  assert.equal(subagent.input.brief?.goal, "Review statistical claims and identify limitations");
  assert.equal(subagent.input.brief?.version, 1);
  subagent.handoff = {
    inputPaths: ["inputs/results.csv"],
    manifestPath: `subagents/${subagent.id}/handoff.json`,
    privateWorkspacePath: `subagents/${subagent.id}`,
    skippedInputPaths: [{ path: "large.csv", reason: "handoff single file size limit exceeded", size: 10_000_001 }],
  };
  subagent.status = "completed";
  subagent.rawStructuredResult = "{\"findings\":[],\"limitations\":[\"No raw sample sheet\"]}";
  subagent.structuredResult = { findings: [], limitations: ["No raw sample sheet"] };
  subagent.resultValidation = {
    errors: [],
    schema: subagent.input.brief.outputJsonSchema,
    status: "passed",
    validatedAt: new Date().toISOString(),
  };
  subagent.steps.push({
    content: "Completed independent review",
    createdAt: new Date().toISOString(),
    id: "subagent-message",
    kind: "assistant",
  });
  await store.updateSubagent(subagent);
  await assert.rejects(store.deleteSpecialist(specialist.id), /referenced by a Session or subagent/);
  await assert.rejects(
    store.createSubagent(session.id, "turn-2", {
      description: "Invalid subagent",
      prompt: "",
    }),
    /prompt is required/,
  );

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  assert.equal(reopened.getSession(session.id)?.specialistId, specialist.id);
  assert.equal(reopened.getSpecialist(specialist.id)?.description, "Reviews statistical claims, assumptions, and limitations.");
  assert.equal(reopened.getSpecialist(specialist.id)?.instructions, "Review statistical claims and report limitations.");
  assert.deepEqual(reopened.listSubagents(session.id).map((item) => ({
    briefGoal: item.input.brief?.goal,
    description: item.input.description,
    handoff: item.handoff?.manifestPath,
    skippedInputPaths: item.handoff?.skippedInputPaths,
    rawStructuredResult: item.rawStructuredResult,
    resultValidation: item.resultValidation?.status,
    status: item.status,
    structuredResult: item.structuredResult,
    stepKinds: item.steps.map((entry) => entry.kind),
  })), [{
    briefGoal: "Review statistical claims and identify limitations",
    description: "Statistical review",
    handoff: `subagents/${subagent.id}/handoff.json`,
    skippedInputPaths: [{ path: "large.csv", reason: "handoff single file size limit exceeded", size: 10_000_001 }],
    rawStructuredResult: "{\"findings\":[],\"limitations\":[\"No raw sample sheet\"]}",
    resultValidation: "passed",
    status: "completed",
    structuredResult: { findings: [], limitations: ["No raw sample sheet"] },
    stepKinds: ["system", "assistant"],
  }]);
});

test("SessionStore falls back to an ordinary subagent when a specialist id is missing", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-missing-specialist-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "missing-specialist-test-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Missing specialist test model",
  });
  const project = await store.createProject("Missing specialist fallback", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Missing specialist session", {}, { approvalMode: "always_allow" });

  const subagent = await store.createSubagent(session.id, "turn-1", {
    description: "Fallback subagent",
    prompt: "Run without specialist.",
    specialistId: "missing-specialist",
  });
  assert.equal(subagent.specialistId, undefined);
  assert.equal(subagent.input.specialistId, undefined);

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  const [persisted] = reopened.listSubagents(session.id);
  assert.equal(persisted?.specialistId, undefined);
  assert.equal(persisted?.input.specialistId, undefined);
});

test("SessionStore updates a non-running subagent brief with auto-incrementing version", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-brief-update-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "brief-update-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Brief update model",
  });
  const project = await store.createProject("Brief updates", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Brief update session", {}, { approvalMode: "always_allow" });
  const subagent = await store.createSubagent(session.id, "turn-1", {
    brief: {
      collaborationRules: ["Work independently"],
      constraints: ["Use only provided inputs"],
      goal: "Initial statistical review",
      outputRequirements: ["Return findings"],
      version: 1,
    },
    description: "Statistical review",
    prompt: "Read the results and report findings.",
    subagentType: "general-purpose",
  });
  assert.equal(subagent.input.brief?.version, 1);
  assert.equal(subagent.status, "running");

  // running subagent rejects brief updates
  await assert.rejects(
    store.updateSubagentBrief(session.id, subagent.id, {
      brief: {
        collaborationRules: ["Work independently"],
        constraints: ["Use only provided inputs"],
        goal: "Revised review",
        outputRequirements: ["Return findings"],
      },
    }),
    /is running/,
  );

  // mark completed, then update succeeds and auto-increments version
  subagent.status = "completed";
  await store.updateSubagent(subagent);
  const updated = await store.updateSubagentBrief(session.id, subagent.id, {
    brief: {
      collaborationRules: ["Work independently", "Surface limitations"],
      constraints: ["Use only provided inputs", "Cite file paths"],
      goal: "Revised statistical review",
      outputJsonSchema: {
        properties: { findings: { type: "array" } },
        required: ["findings"],
        type: "object",
      },
      outputRequirements: ["Return findings and limitations"],
      version: 99, // ignored; server forces auto-increment
    },
  });
  assert.equal(updated.input.brief?.version, 2);
  assert.equal(updated.input.brief?.goal, "Revised statistical review");
  assert.deepEqual(updated.input.brief?.constraints, ["Use only provided inputs", "Cite file paths"]);
  assert.ok(updated.steps.some((step) => step.kind === "system" && /Brief updated to v2/.test(step.content)));

  // invalid brief (empty goal) is rejected
  await assert.rejects(
    store.updateSubagentBrief(session.id, subagent.id, {
      brief: {
        collaborationRules: ["x"],
        constraints: ["x"],
        goal: "   ",
        outputRequirements: ["x"],
      },
    }),
    /goal/,
  );

  // unknown subagent id is rejected
  await assert.rejects(
    store.updateSubagentBrief(session.id, "missing-id", {
      brief: {
        collaborationRules: ["x"],
        constraints: ["x"],
        goal: "Revised review",
        outputRequirements: ["x"],
      },
    }),
    /not found/,
  );

  // version persists across reload
  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  const restored = reopened.listSubagents(session.id).find((item) => item.id === subagent.id);
  assert.equal(restored?.input.brief?.version, 2);
  assert.equal(restored?.input.brief?.goal, "Revised statistical review");
});

test("SessionStore owns subagent brief versions and serializes concurrent PATCH responses", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-brief-concurrency-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "brief-concurrency-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Brief concurrency model",
  });
  const project = await store.createProject("Brief concurrency", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Brief concurrency session", {}, { approvalMode: "always_allow" });
  const subagent = await store.createSubagent(session.id, "turn-1", {
    brief: {
      collaborationRules: ["Work independently"],
      constraints: ["Use only provided inputs"],
      goal: "Initial review without trusted client version",
      outputRequirements: ["Return findings"],
    },
    description: "Statistical review",
    prompt: "Read the results and report findings.",
    subagentType: "general-purpose",
  });
  assert.equal(subagent.input.brief?.version, 1);
  subagent.status = "completed";
  await store.updateSubagent(subagent);

  const updates = await Promise.all([
    store.updateSubagentBrief(session.id, subagent.id, {
      brief: {
        collaborationRules: ["Work independently"],
        constraints: ["Use only provided inputs"],
        goal: "First concurrent update",
        outputRequirements: ["Return findings"],
        version: 1001,
      },
    }),
    store.updateSubagentBrief(session.id, subagent.id, {
      brief: {
        collaborationRules: ["Work independently"],
        constraints: ["Use only provided inputs"],
        goal: "Second concurrent update",
        outputRequirements: ["Return findings"],
      },
    }),
  ]);

  assert.deepEqual(updates.map((item) => item.input.brief?.version), [2, 3]);
  assert.deepEqual(updates.map((item) => item.input.brief?.goal), ["First concurrent update", "Second concurrent update"]);
  const persisted = store.listSubagents(session.id).find((item): item is Subagent => item.id === subagent.id);
  assert.equal(persisted?.input.brief?.version, 3);
  assert.equal(persisted?.input.brief?.goal, "Second concurrent update");
});

test("SessionStore recovers flushed running subagents as failed after restart", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-running-subagent-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));

  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "running-subagent-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Running subagent model",
  });
  const project = await store.createProject("Interrupted subagent", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Interrupted subagent session", {}, { approvalMode: "always_allow" });
  const running = await store.createSubagent(session.id, "turn-1", {
    description: "Long analysis",
    prompt: "Analyze the workspace and report progress.",
  });
  running.turnCount = 2;
  running.steps.push({
    content: "Partial analysis survived the last progress flush.",
    createdAt: new Date().toISOString(),
    id: "partial-progress",
    kind: "assistant",
    status: "completed",
  });
  await store.updateSubagent(running);

  const reopened = new SessionStore(tempRoot);
  await reopened.load();
  const [recovered] = reopened.listSubagents(session.id);
  assert.equal(recovered?.status, "failed");
  assert.match(recovered?.error ?? "", /interrupted by API restart/i);
  assert.ok(recovered?.finishedAt);
  assert.equal(recovered?.turnCount, 2);
  assert.ok(recovered?.steps.some((step) => step.content.includes("Partial analysis survived")));

  const persisted = await readPersistedCatalog(tempRoot) as PersistedCatalog & {
    subagents: Array<{ status: string }>;
  };
  assert.equal(persisted.subagents[0]?.status, "failed");
});

test("SessionStore gates privileged actions with Session-scoped matching grants and per-action authorizations", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-permissions-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "permission-test-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Permission test model",
  });
  const project = await store.createProject("Permission project", { modelId: model.id, reviewModelId: model.id });
  const first = await store.createSession(project.id, "First Session");
  const second = await store.createSession(project.id, "Second Session");

  const pending = await store.requestPermission(first.id, "code", "workspace-code", "Run Python code");
  assert.equal(pending.allowed, false);
  if (pending.allowed) throw new Error("Expected a permission request");
  const sameKeyPending = await store.requestPermission(first.id, "code", "workspace-code", "Run shell code");
  assert.equal(sameKeyPending.allowed, false);
  if (sameKeyPending.allowed) throw new Error("Expected an independent pending request");
  assert.notEqual(sameKeyPending.request.id, pending.request.id, "concurrent actions are reviewed independently");
  const differentKeyPending = await store.requestPermission(first.id, "connector", "pubmed", "Query PubMed");
  assert.equal(differentKeyPending.allowed, false);
  if (differentKeyPending.allowed) throw new Error("Expected an independent connector request");
  assert.notEqual(differentKeyPending.request.id, pending.request.id);
  const decision = await store.decidePermissionRequest(pending.request.id, "allow_matching");
  assert.equal(decision.grant?.scope, "session");
  assert.equal(decision.authorization.source, "user_grant");
  assert.equal(decision.resolvedRequests.length, 2);
  assert.equal(decision.authorizations.length, 2);
  assert.equal(
    decision.resolvedRequests.find((request) => request.id === sameKeyPending.request.id)?.state,
    "allowed",
    "a matching pending action is covered immediately by the new grant",
  );
  assert.notEqual(
    decision.resolvedRequests[0]?.permissionAuthorizationId,
    decision.resolvedRequests[1]?.permissionAuthorizationId,
    "every covered action has an independent authorization record",
  );
  assert.equal((await store.requestPermission(second.id, "code", "workspace-code", "Run R code")).allowed, false);
  const covered = await store.requestPermission(first.id, "code", "workspace-code", "Run R code");
  assert.equal(covered.allowed, true);
  if (!covered.allowed) throw new Error("Expected a standing grant authorization");
  assert.equal(covered.authorization.source, "existing_grant");
  const connectorDecision = await store.decidePermissionRequest(differentKeyPending.request.id, "allow_once");
  assert.equal(connectorDecision.authorization.source, "user_once");
  assert.equal(connectorDecision.grant, undefined);
  assert.equal(store.listPermissionGrants().length, 1);
  assert.equal(store.listPermissionAuthorizations(first.id).length, 4);
  await store.revokePermissionGrant(decision.grant!.id);
  assert.equal((await store.requestPermission(first.id, "code", "workspace-code", "Run shell code")).allowed, false);
  assert.equal(store.listPermissionGrants().length, 0);
  const lookup = await store.requestPermission(first.id, "connector", "uniprot:lookup:P04637", "Look up TP53");
  if (lookup.allowed) throw new Error("Expected a lookup permission request");
  await store.decidePermissionRequest(lookup.request.id, "allow_matching");
  const relatedLookup = await store.requestPermission(
    first.id,
    "connector",
    "uniprot:lookup:Q9Y6K9",
    "Look up another accession",
  );
  assert.equal(relatedLookup.allowed, true, "matching grants use connector and tool identity, not one accession");
});

test("SessionStore allow-once leaves matching pending siblings independently decidable", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-once-siblings-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const project = await store.createProject("Once sibling project");
  const session = await store.createSession(
    project.id,
    "Once sibling Session",
    {},
    {},
    { allowUnconfiguredModel: true },
  );
  const otherSession = await store.createSession(
    project.id,
    "Other Session",
    {},
    {},
    { allowUnconfiguredModel: true },
  );
  const selected = await store.requestPermission(
    session.id,
    "connector",
    "uniprot:lookup:P04637",
    "Look up TP53",
  );
  const sibling = await store.requestPermission(
    session.id,
    "connector",
    "uniprot:lookup:Q9Y6K9",
    "Look up another accession",
  );
  const differentKey = await store.requestPermission(
    session.id,
    "connector",
    "pubmed:search:cancer",
    "Search PubMed",
  );
  const differentSession = await store.requestPermission(
    otherSession.id,
    "connector",
    "uniprot:lookup:P04637",
    "Look up TP53 elsewhere",
  );
  if (selected.allowed || sibling.allowed || differentKey.allowed || differentSession.allowed) {
    throw new Error("Expected independent pending permission requests");
  }

  const decision = await store.decidePermissionRequest(selected.request.id, "allow_once");
  assert.equal(decision.authorization.source, "user_once");
  assert.equal(decision.grant, undefined);
  assert.equal(decision.authorizations.length, 1, "only the selected request receives an authorization");
  assert.equal(decision.resolvedRequests.length, 1);
  assert.equal(decision.request.state, "allowed");
  const stillPending = store.getPermissionRequest(sibling.request.id);
  assert.equal(stillPending?.state, "pending", "Once must not change a live sibling request");
  assert.equal(stillPending?.decidedAt, undefined);
  assert.equal(stillPending?.permissionAuthorizationId, undefined);
  const siblingDecision = await store.decidePermissionRequest(sibling.request.id, "allow_once");
  assert.equal(siblingDecision.request.state, "allowed");
  assert.equal(siblingDecision.authorizations.length, 1);
  assert.notEqual(siblingDecision.authorization.id, decision.authorization.id);
  assert.equal(store.listPermissionGrants().length, 0);
  assert.equal(store.getPermissionRequest(differentKey.request.id)?.state, "pending");
  assert.equal(store.getPermissionRequest(differentSession.request.id)?.state, "pending");
});

test("SessionStore always-allow bypasses permission cards without leaving reusable grants", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-auto-permissions-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "auto-permission-test-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Auto permission test model",
  });
  const project = await store.createProject("Automatic permissions", {
    modelId: model.id,
    reviewModelId: model.id,
  });
  const session = await store.createSession(project.id, "Automatic Session", {}, { approvalMode: "always_allow" });
  const catalogBeforeAuthorizations = await readPersistedCatalog(tempRoot);

  for (let index = 0; index < 100; index += 1) {
    const permission = await store.requestPermission(
      session.id,
      index % 2 ? "connector" : "code",
      index % 2 ? `arxiv:search:${index}` : "workspace-code",
      `Automatic action ${index}`,
      { executionId: `execution-${index}`, toolCallId: `tool-${index}` },
    );
    assert.equal(permission.allowed, true);
  }
  assert.deepEqual(store.listPermissionRequests(session.id), []);
  assert.equal(store.listPermissionGrants().length, 0);
  const authorizations = store.listPermissionAuthorizations(session.id);
  assert.equal(authorizations.length, 100);
  assert.ok(authorizations.every((authorization) => authorization.source === "always_allow"));
  assert.deepEqual(
    await readPersistedCatalog(tempRoot),
    catalogBeforeAuthorizations,
    "pure authorization appends must not rewrite the catalog blob",
  );

  await store.setApprovalMode(session.id, "ask_for_dangerous");
  const manual = await store.requestPermission(session.id, "connector", "arxiv:search", "Search arXiv again");
  assert.equal(manual.allowed, false, "always-allow authorizations must not leak into ask mode");
});

test("SessionStore resolves every pending action when always-allow is enabled and cancels orphaned executions", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-mode-switch-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "mode-switch-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Mode switch model",
  });
  const project = await store.createProject("Mode switch", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Mode switch Session");
  const code = await store.requestPermission(
    session.id,
    "code",
    "workspace-code",
    "Run code",
    { executionId: "execution-code", toolCallId: "tool-code" },
  );
  const connector = await store.requestPermission(
    session.id,
    "connector",
    "uniprot:lookup:P04637",
    "Look up UniProt",
    { executionId: "execution-connector", toolCallId: "tool-connector" },
  );
  if (code.allowed || connector.allowed) throw new Error("Expected pending permission requests");

  const changed = await store.setApprovalMode(session.id, "always_allow");
  assert.equal(changed.resolvedPendingRequests.length, 2);
  assert.equal(changed.authorizations.length, 2);
  assert.ok(changed.resolvedPendingRequests.every((request) =>
    request.state === "allowed"
    && request.decisionEpochId === changed.permissionEpoch.id
    && Boolean(request.permissionAuthorizationId)));
  assert.equal(store.listPermissionGrants().length, 0);

  await store.setApprovalMode(session.id, "ask_for_dangerous");
  const orphan = await store.requestPermission(
    session.id,
    "code",
    "workspace-code",
    "Run orphaned code",
    { executionId: "execution-orphan" },
  );
  if (orphan.allowed) throw new Error("Expected a pending orphan request");
  const cancelled = await store.cancelPendingPermissionRequests("execution-orphan");
  assert.equal(cancelled[0]?.state, "cancelled");
});

test("one-time preflight authorizations are consumed once without creating a grant", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-preflight-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "preflight-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Preflight model",
  });
  const project = await store.createProject("Preflight", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Preflight Session");
  const pending = await store.requestPermission(session.id, "host", "cluster", "Probe cluster");
  if (pending.allowed) throw new Error("Expected a pending preflight request");
  const decision = await store.decidePermissionRequest(pending.request.id, "allow_once");
  const consumed = await store.requestPermission(session.id, "host", "cluster", "Probe cluster");
  assert.equal(consumed.allowed, true);
  if (!consumed.allowed) throw new Error("Expected the approved preflight to be consumed");
  assert.equal(consumed.authorization.id, decision.authorization.id);
  assert.equal((await store.requestPermission(session.id, "host", "cluster", "Probe cluster")).allowed, false);
  assert.equal(store.listPermissionGrants().length, 0);
});

test("SessionStore auto-submits remote jobs and keeps manual jobs independently approval-gated", async (context) => {
  const tempRoot = resolve(process.cwd(), ".tmp", `catalog-remote-jobs-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const store = new SessionStore(tempRoot);
  await store.load();
  const model = await store.createModel({
    apiToken: "remote-test-token",
    baseUrl: "https://models.example.test/v1",
    model: "science-model",
    name: "Remote test model",
  });
  const host = await store.registerRemoteHost("cluster", {
    conda: true,
    containerRuntimes: ["apptainer"],
    cpuCores: 64,
    cuda: null,
    gpu: null,
    memoryBytes: 512 * 1024 ** 3,
    modules: true,
    probedAt: new Date().toISOString(),
    scratchPaths: ["/scratch"],
    slurm: true,
  });
  const project = await store.createProject("Remote work", { modelId: model.id, reviewModelId: model.id });
  const session = await store.createSession(project.id, "Remote analysis", {}, { approvalMode: "always_allow" });
  const job = await store.createRemoteJob(session.id, {
    command: "python analysis.py --input /scratch/data.parquet",
    hostId: host.id,
    inputPaths: ["/scratch/data.parquet"],
    mode: "slurm",
    outputs: [{ disposition: "remote", path: "/scratch/model.bin" }],
    remoteWorkingDirectory: "/scratch/project",
    resources: { cpus: 8, gpus: 0, memoryMb: 16_384, walltimeMinutes: 60 },
  });
  assert.equal(job.state, "approved");
  assert.ok(job.approvedAt);
  assert.equal(job.card.inputPaths[0], "/scratch/data.parquet");
  await assert.rejects(
    store.decideRemoteJob(session.id, job.id, { decision: "allow_once", expectedVersion: job.version }),
    /not awaiting approval/,
  );
  const changedCard = { ...job, card: { ...job.card, command: "different command" } };
  await assert.rejects(store.updateRemoteJob(changedCard), /approval card is immutable/);

  await store.setApprovalMode(session.id, "ask_for_dangerous");
  const pendingPlan = await store.proposeSessionPlan(session.id, {
    feasibilityConfidence: "medium",
    scope: "Switch to manual governance before another remote run",
    steps: ["Inspect remote data", "Run batch job"],
  });
  const blocked = await store.createRemoteJob(session.id, {
    command: "hostname",
    hostId: host.id,
    mode: "ssh",
    remoteWorkingDirectory: "/scratch/project",
    resources: { cpus: 1, gpus: 0, memoryMb: 256, walltimeMinutes: 5 },
  });
  const approved = await store.decideRemoteJob(
    session.id,
    blocked.id,
    { decision: "allow_once", expectedVersion: blocked.version },
  );
  assert.equal(approved.state, "approved");
  assert.ok(approved.permissionAuthorizationId);
  assert.equal(pendingPlan.state, "recorded");
});

// Regression coverage: [evidence1]/[artifact1] alias tokens in a final assistant
// report must not render as plain text in the conversation transcript. The
// report Artifact version already carries the chip references (drained from
// declare_claim), but the assistant message did not — so the message-render
// path (used when a run has no replayable timeline) had no alias→node map and
// left tokens as text. These tests pin the store helpers the run calls to
// mirror the report's references onto the message.
async function seedReportSession() {
  const tempRoot = resolve(process.cwd(), ".tmp", `message-refs-${Date.now()}-${process.pid}`);
  await mkdir(tempRoot, { recursive: true });
  const store = new SessionStore(tempRoot);
  store.setAvailableSkillIds([]);
  await store.load();
  const model = await store.createModel({ apiToken: "test", baseUrl: "https://models.example.test/v1", model: "test", name: "Test" });
  const project = await store.createProject("Message refs");
  const session = await store.createSession(project.id, "Brief", { modelId: model.id });
  return { tempRoot, store, session, model };
}

const reportRefs: ComposerReference[] = [
  { id: "ev-id-1", kind: "evidence", label: "evidence1" },
  { id: "ev-id-2", kind: "evidence", label: "evidence2" },
  { id: "fig-art", kind: "artifact", label: "artifact1", version: 1 },
  { id: "data-art", kind: "artifact", label: "artifact2", version: 1 },
];

test("latestReportReferences returns the chip references on the newest report version without draining", async (context) => {
  const { tempRoot, store, session } = await seedReportSession();
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const content = { hash: "a".repeat(64), size: 8 };
  // A report version carries the chip references; a data version does not.
  await store.createArtifactVersion({
    content, kind: "markdown", logicalName: "evidence_brief.md",
    mediaType: "text/markdown", references: reportRefs, sessionId: session.id,
  });
  await store.createArtifactVersion({
    content, kind: "dataset", logicalName: "counts.csv",
    mediaType: "text/csv", sessionId: session.id,
  });
  assert.deepEqual(
    store.latestReportReferences(session.id).map((reference) => reference.label),
    ["evidence1", "evidence2", "artifact1", "artifact2"],
    "the report version's references are mirrored verbatim",
  );
  // Non-destructive: a second read still returns the full list.
  assert.equal(store.latestReportReferences(session.id).length, reportRefs.length);
  // No report version → empty, never undefined.
  const bareStore = new SessionStore(resolve(tempRoot, "bare"));
  bareStore.setAvailableSkillIds([]);
  await bareStore.load();
  const bareModel = await bareStore.createModel({ apiToken: "t", baseUrl: "https://m.test/v1", model: "t", name: "T" });
  const bareProject = await bareStore.createProject("Bare");
  const bareSession = await bareStore.createSession(bareProject.id, "Bare", { modelId: bareModel.id });
  assert.deepEqual(bareStore.latestReportReferences(bareSession.id), []);
});

test("updateMessageReferences back-fills chip references onto an assistant message and survives reload", async (context) => {
  const { tempRoot, store, session, model } = await seedReportSession();
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const content = { hash: "a".repeat(64), size: 8 };
  await store.createArtifactVersion({
    content, kind: "markdown", logicalName: "evidence_brief.md",
    mediaType: "text/markdown", references: reportRefs, sessionId: session.id,
  });
  const message = await store.appendMessage(
    session.id, "assistant", "Pathway enrichment [artifact1] and counts [artifact2] draw on [evidence1].",
    model,
  );
  assert.ok(!message.references, "appendMessage starts with no references when none are passed");
  await store.updateMessageReferences(session.id, message.id, store.latestReportReferences(session.id));
  const reloaded = await store.readMessages(session.id);
  const stored = reloaded.find((entry) => entry.id === message.id);
  assert.deepEqual(
    stored?.references?.map((reference) => [reference.kind, reference.label]),
    [["evidence", "evidence1"], ["evidence", "evidence2"], ["artifact", "artifact1"], ["artifact", "artifact2"]],
    "the message now carries the same chip references as the report version",
  );
  // Idempotent: a second back-fill does not duplicate or clear.
  await store.updateMessageReferences(session.id, message.id, store.latestReportReferences(session.id));
  assert.equal((await store.readMessages(session.id)).find((entry) => entry.id === message.id)?.references?.length, reportRefs.length);
  // Empty references are a no-op (never clears an existing map).
  await store.updateMessageReferences(session.id, message.id, []);
  assert.equal((await store.readMessages(session.id)).find((entry) => entry.id === message.id)?.references?.length, reportRefs.length);
});

test("updateMessageReferences leaves a failed run's assistant message with chips once a report version lands", async (context) => {
  // The bug scenario: a run ends `failed` with an empty assistantMessageId, so
  // its assistant answer renders via the bare message path. The report version
  // still carries the chip map; the message must mirror it so chips render.
  const { tempRoot, store, session, model } = await seedReportSession();
  context.after(() => rm(tempRoot, { force: true, recursive: true }));
  const content = { hash: "a".repeat(64), size: 8 };
  await store.createArtifactVersion({
    content, kind: "markdown", logicalName: "evidence_brief.md",
    mediaType: "text/markdown", references: reportRefs, sessionId: session.id,
  });
  // The run failed; the assistant message was still appended (mirrors the run
  // flow which appends before checking run status).
  const message = await store.appendMessage(session.id, "assistant", "Conclusions [evidence1] [evidence2].", model);
  await store.updateMessageReferences(session.id, message.id, store.latestReportReferences(session.id));
  const stored = (await store.readMessages(session.id)).find((entry) => entry.id === message.id);
  assert.ok(stored?.references?.length, "the failed run's assistant message carries chip references");
  assert.equal(stored!.references![0]!.label, "evidence1");
});
