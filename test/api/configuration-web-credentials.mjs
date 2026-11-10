// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: replace and clear one Web provider key through its secure user configuration card.
 * Steps: own committed startup; inspect blank card; secure replacement/replay; stale formal update; refusal; clear.
 * Environment: actual Native node services/api/dist/server.js with fresh data and an ephemeral loopback port.
 * Type: synthetic credentials only; no Web fetch/search, external auth probe, real LLM, Runner or paid requests.
 * Credentials: synthetic provider keys and E2E_API_TOKEN, excluded from reports.
 * CostSideEffects: only the owned isolated Web key store; restore exact fixture baseline and delete owned Project.
 * Run: E2E_BASE_URL=http://127.0.0.1:<owned-port> E2E_API_TOKEN=<owned-token>
 * E2E_WEB_CREDENTIALS_ISOLATED=1 E2E_STARTUP_COMMAND='<actual startup>' node test/api/configuration-web-credentials.mjs
 * Public API journey; browser, Linux and real provider credential validity are separate verification gaps.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const marker = `web-credentials-${randomUUID()}`, directory = `.tmp/${marker}`;
await mkdir(directory, { recursive: true });
const token = process.env.E2E_API_TOKEN, origin = process.env.E2E_BASE_URL;
let sha, outcome = "BLOCKED", project, session, baseline;
const steps = [], requests = [];
class Blocked extends Error {}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code });
  assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (e) { steps.push({ name, status: e instanceof Blocked ? "BLOCKED" : "FAIL", error: e instanceof Blocked ? e.message : "Request or assertion failed; inspect this driver step without credential values" }); throw e; }
}
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "web.credential", values });
const preview = (card, values, handle, option = "persist") => api(path(card, "preview"), { expectedRevision: card.revision, values, selectedOptionId: option,
  ...(handle ? { credentialHandle: handle } : {}) }, "POST", 200);
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest,
  selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
const formal = () => api("/api/web/settings");
const flag = (settings, provider) => settings.providers.find(item => item.provider === provider).hasApiKey;
const selections = ({ providers, ...settings }) => settings;
try {
  await step("1. Verify the immutable isolated product and create an owned Project/Session", async () => {
    if (!origin || !token || !process.env.E2E_STARTUP_COMMAND || process.env.E2E_WEB_CREDENTIALS_ISOLATED !== "1") throw new Blocked("Owned startup metadata is required");
    const url = new URL(origin);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || ["4310", "4420", "4421"].includes(url.port)) throw new Blocked("Use a new owned loopback instance");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before testing");
    await api("/health"); baseline = await formal();
    if (baseline.providers.some(item => item.hasApiKey)) throw new Blocked("Use fresh isolated data without real credentials");
    project = await api("/api/projects", { name: marker }); session = await api(`/api/projects/${project.id}/sessions`, { title: marker });
    const caps = await api(`/api/sessions/${session.id}/configuration/capabilities`);
    assert.equal(caps.executor, "native"); assert.ok(caps.items.some(item => item.id === "web.credential" && !item.autoApplyEligible));
  });
  outcome = "FAIL";
  await step("2. Open a blank credential card, reject ordinary key values, and close without writing", async () => {
    const rejected = await api(path(), { protocolVersion: 3, capabilityId: "web.credential", values: { webProvider: "jina", apiToken: "synthetic-must-not-echo" } }, "POST", 400);
    assert.doesNotMatch(JSON.stringify(rejected), /synthetic-must-not-echo/);
    let card = await propose({}); assert.equal(card.state, "collecting_input");
    assert.deepEqual(await formal(), baseline);
    card = await preview(card, {}, undefined, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
  });
  await step("3. Supply a dedicated key, review and apply once, then replay without changing selections", async () => {
    const values = { webProvider: "jina", operation: "replace" }; let card = await propose(values);
    assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.state, "collecting_input");
    const draft = await api(path(card, "credentials"), { expectedRevision: card.revision, fieldId: "apiToken", secret: "synthetic-jina-fixture" }, "POST", 200);
    card = await preview(card, values, draft.handle); assert.equal(card.state, "awaiting_confirmation");
    assert.equal(card.verificationPlan.maxRequests, 0); assert.doesNotMatch(JSON.stringify(card), /synthetic-jina-fixture/);
    assert.equal((await decide(card)).state, "applied"); assert.equal((await decide(card)).state, "applied");
    const saved = await formal(); assert.equal(flag(saved, "jina"), true); assert.deepEqual(selections(saved), selections(baseline));
  });
  await step("4. Concurrent formal key rotation fences the exact previous approval", async () => {
    let card = await propose({ webProvider: "jina", operation: "clear" });
    await api("/api/web/settings", { providerApiKeys: { jina: "synthetic-concurrent-fixture" } }, "PUT", 200);
    const result = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision: "apply" }, "POST", 409);
    assert.equal(result.code, "RESOURCE_VERSION_CONFLICT"); assert.equal(flag(await formal(), "jina"), true);
    card = await preview(card, {}, undefined, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
  });
  await step("5. Refuse a separate removal and preserve the saved credential presence", async () => {
    const before = await formal(); let card = await propose({ webProvider: "jina", operation: "clear" });
    card = await preview(card, {}, undefined, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
    assert.deepEqual(await formal(), before);
  });
  await step("6. Clear without an old key, reread formal settings and keep provider authentication unverified", async () => {
    const card = await propose({ webProvider: "jina", operation: "clear" }); assert.ok(card.fields.every(field => field.kind !== "credential"));
    const result = await decide(card); assert.equal(result.state, "applied"); assert.equal(result.activation.mode, "next_request");
    assert.notEqual(result.activation.state, "active"); assert.equal((await decide(card)).state, "applied");
    assert.deepEqual(await formal(), baseline);
  });
  outcome = "PASS";
} catch (e) { outcome = e instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try {
    if (baseline && baseline.providers.every(item => !item.hasApiKey)) await api("/api/web/settings", { providerApiKeys: { jina: null } }, "PUT", 200);
    if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned state", status: "FAIL" }); }
  await writeFile(`${directory}/report.json`, JSON.stringify({ sha, outcome, startup: process.env.E2E_STARTUP_COMMAND ?? "missing", steps, requests, browser: "not exercised", realLLM: false, providerAuthentication: "not tested" }, null, 2));
  await writeFile(`${directory}/report.md`, `# Web credential configuration: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: `${directory}/report.md` }));
}
