// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { SessionStore } from "../store.js";
import { createConfigurationAgentTools } from "./agent-tools.js";
import { configurationFramework } from "./framework.js";
import { CONFIGURATION_CONTEXT_LIMITS } from "./context-budget.js";
import { configurationPage } from "./discovery.js";
import { recordNativeRunChoiceContext } from "./native-choices.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = resolve(process.cwd(), ".tmp"); const root = resolve(parent, `configuration-discovery-${randomUUID()}`);
  const store = new SessionStore(root); await store.load();
  context.after(async () => { store.close(); assert.ok(root.startsWith(parent + sep)); await rm(root, { recursive: true, force: true }); });
  const project = await store.createProject("Bounded discovery");
  const model = await store.createModel({ name: "Private fixture model", model: "fixture", baseUrl: "http://127.0.0.1:9/v1", apiToken: "do-not-project-secret", apiProtocol: "openai-chat-completions", apiVariant: "deepseek" });
  const session = await store.createSession(project.id, "Discovery", {}, {}, { allowUnconfiguredModel: true });
  const framework = configurationFramework(store, { nativeExecutor: true, connector: () => ({ name: "PubMed", ready: true }), connectors: () => [
    { id: "pubmed", name: "PubMed", ready: true, readiness: "ready", sameRunSupported: true },
    { id: "arxiv", name: "arXiv", ready: false, readiness: "unavailable", sameRunSupported: true },
  ] });
  const run = await store.createSessionRun({ sessionId: session.id, prompt: "Find PubMed papers", settingsSnapshot: store.resolveRuntimeSettings(session.id).effective });
  recordNativeRunChoiceContext({ store, sessionId: session.id, runId: run.id, enabledConnectorIds: ["web"], webSearchAvailable: true, toolCatalogFingerprint: "fixture-mounted-web" });
  const tools = createConfigurationAgentTools({ store, sessionId: session.id, runId: run.id });
  const query = async (args: unknown) => {
    const result = await tools[0]!.execute(randomUUID(), args);
    return { ...JSON.parse(result.content[0]!.text), raw: result.content[0]!.text, details: result.details };
  };
  return { store, session, model, framework, tools, query, run };
}
test("CFG-Q01: only one small stable tool is exposed with 1000 installed resources", async context => {
  const h = await fixture(context);
  const spec = JSON.stringify(h.tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
  assert.deepEqual(h.tools.map(tool => tool.name), ["configuration"]);
  assert.ok(Buffer.byteLength(spec) <= CONFIGURATION_CONTEXT_LIMITS.tool);
  assert.doesNotMatch(spec, /connector\.enable|thinkingMode|enabledSkillIds|pubmed|settingsInventory/);
  h.store.setAvailableSkillIds(Array.from({ length: 1000 }, (_, index) => `large-skill-${index}`));
  const grown = createConfigurationAgentTools({ store: h.store, sessionId: h.session.id, runId: h.run.id });
  assert.equal(JSON.stringify(grown.map(({ name, description, parameters }) => ({ name, description, parameters }))), spec);
});
test("CFG-Q02: exact PubMed search returns relevant actual readiness without global inventory or mutation", async context => {
  const h = await fixture(context); const before = h.store.getSessionSettings(h.session.id).overrides;
  const found = await h.query({ action: "search", query: "请启用 PubMed" });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].capabilityId, "connector.enable");
  assert.equal(found.items[0].resource.id, "pubmed"); assert.equal(found.items[0].resource.canPropose, true);
  assert.ok(Buffer.byteLength(found.raw) <= 4096);
  assert.doesNotMatch(found.raw, /do-not-project-secret|127\.0\.0\.1|arxiv|enabledSkillIds|settingsInventory|providerApiKeys/);
  assert.deepEqual(h.store.getSessionSettings(h.session.id).overrides, before);
  assert.equal(h.framework.service.list(h.session.id).length, 0);
  const unsupported = await h.query({ action: "search", query: "proxy" });
  assert.ok(unsupported.items.some((item: { domain: string; available: boolean }) => item.domain === "proxy" && !item.available));
});
test("CFG-Q02: task words match literature and ignore ASCII substrings", async context => {
  const h = await fixture(context);
  const papers = await h.query({ action: "search", query: "找几篇论文" });
  assert.deepEqual(papers.items.map((item: { capabilityId?: string }) => item.capabilityId), ["connector.enable"]);
  const joined = await h.query({ action: "search", query: "启用pubmed" });
  assert.equal(joined.items.length, 1);
  assert.equal(joined.items[0].resource.id, "pubmed");
  const noise = await h.query({ action: "search", query: "validate the rapid citation" });
  assert.ok(noise.items.every((item: { capabilityId?: string; resource?: { id?: string } }) => item.capabilityId === "skill.select" && item.resource?.id?.includes("citation")));
  assert.doesNotMatch(noise.raw, /model\.connect|runner_registration|connector\.enable|timeouts\.configure|quotas\.configure/);
});
test("CFG-Q03: one-domain detail does not load unrelated resource catalogs or expose keys/URLs", async context => {
  const h = await fixture(context);
  h.store.configurationSkillResources = () => { throw new Error("Unrelated Skill catalog was loaded"); };
  h.store.listModels = () => { throw new Error("Unrelated model listing was loaded"); };
  const value = await h.query({ action: "describe", capabilityId: "thinking.configure" });
  assert.equal(value.capabilityId, "thinking.configure"); assert.ok(value.fields.thinkingMode); assert.ok(value.current.supported);
  assert.ok(!value.fields.enabledSkillIds); assert.ok(!value.error);
  assert.doesNotMatch(value.raw, /do-not-project-secret|127\.0\.0\.1|settingsInventory|providerApiKeys/);
});
test("CFG-Q02/03: large selected collections are previewed and installed resources remain pageable", async context => {
  const h = await fixture(context);
  h.store.setAvailableSkillIds(Array.from({ length: 1000 }, (_, i) => `skill-${i.toString().padStart(4, "0")}`));
  await h.store.replaceSessionSettings(h.session.id, { skillSelectionMode: "all" });
  const first = await h.query({ action: "describe", capabilityId: "skill.select", limit: 3 });
  assert.equal(first.total, 1000); assert.equal(first.items.length, 3); assert.equal(first.current.enabledSkills.count, 1000);
  assert.equal(first.current.enabledSkills.ids.length, 5); assert.equal(first.current.enabledSkills.hasMore, true);
  const next = await h.query({ action: "describe", capabilityId: "skill.select", limit: 3, cursor: first.nextCursor });
  assert.equal(next.items.length, 3); assert.ok(!first.items.some((a: { id: string }) => next.items.some((b: { id: string }) => a.id === b.id)));
  assert.ok(Buffer.byteLength(first.raw) <= 8192); assert.ok(Buffer.byteLength(next.raw) <= 8192);
});
test("CFG-Q02: UTF-8 byte paging preserves valid complete identifiers and retrieves every row", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `资源-${i}`, name: "科研方法".repeat(60) }));
  const received: string[] = []; let cursor: string | undefined;
  do {
    const page = configurationPage({ action: "search" }, rows, { limit: 10, cursor }, ["query"], 4096);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    const parsed = JSON.parse(JSON.stringify(page)); received.push(...parsed.items.map((row: { id: string }) => row.id)); cursor = parsed.nextCursor;
  } while (cursor);
  assert.deepEqual(received, rows.map(row => row.id));
  const first = configurationPage({}, rows, {}, ["query"], 4096);
  assert.throws(() => configurationPage({}, rows, { cursor: first.nextCursor as string }, ["other"], 4096));
  assert.throws(() => configurationPage({}, rows, { limit: 11 }, ["query"], 4096));
});
test("CFG-Q04: action-specific fields, malformed pages, secrets and unsupported scopes cannot create cards", async context => {
  const h = await fixture(context);
  for (const args of [
    { action: "search", query: " " }, { action: "search", query: "PubMed", values: { connectorId: "pubmed" } },
    { action: "describe", capabilityId: "unknown" }, { action: "search", query: "PubMed", cursor: "invalid" },
    { action: "propose", capabilityId: "model.select", values: { modelId: h.model.id, apiToken: "rejected-secret" } },
    { action: "propose", capabilityId: "review.configure", values: { command: "install" } },
    { action: "propose", capabilityId: "review.configure", values: { level: "deep" }, scope: "global" },
  ]) { const output = await h.query(args); assert.ok(output.error, JSON.stringify(args)); assert.doesNotMatch(output.raw, /rejected-secret/); }
  assert.equal(h.framework.service.list(h.session.id).length, 0);
  for (const code of ["NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "NO_RESULTS"]) {
    const result = await h.query({ action: "search", diagnosticCode: code }); assert.equal(result.items.length, 0);
  }
});

test("CFG-Q03: Idea Tree current values expose only supported runtime controls", async context => {
  const h = await fixture(context);
  const value = await h.query({ action: "describe", capabilityId: "idea_tree.configure" });
  assert.ok(!value.error);
  assert.deepEqual(Object.keys(value.current).sort(), ["explorationIntensity", "maxDepth", "maxNodes", "maxTokensPerCall", "scoreDirection"]);
  const saved = h.store.getIdeaTreeSettings();
  assert.equal(value.current.maxTokensPerCall, saved.maxTokensPerCall);
  assert.equal(value.current.maxDepth, saved.maxDepth);
  assert.equal(value.current.maxNodes, saved.maxNodes);
});
