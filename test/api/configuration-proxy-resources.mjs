// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: Create, edit, securely replace and delete a shared proxy through the user configuration API.
 * Steps: owned startup; secure creation; repeat/rename; invalid URL correction; stale/ref-protected delete; refusal.
 * Environment: committed isolated Native product, node services/api/dist/server.js or documented start-stack equivalent.
 * Type: credential/URL fixture only. No real LLM, Runner, Web, Paper or other external calls; no connectivity claim.
 * Credentials: only synthetic proxy URLs and the isolated E2E_API_TOKEN; never included in evidence.
 * CostSideEffects: changes shared proxy resources/default only inside the owned instance; restores owned resources in finally.
 * Run: E2E_BASE_URL=http://127.0.0.1:<owned-port> E2E_API_TOKEN=<owned-token>
 * E2E_PROXY_RESOURCES_ISOLATED=1 E2E_STARTUP_COMMAND='<actual startup>' node test/api/configuration-proxy-resources.mjs
 * Public API journey; does not certify browser interactions, Linux, real models or real proxy enforcement.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const marker = `proxy-resources-${randomUUID()}`, directory = `.tmp/${marker}`;
await mkdir(directory, { recursive: true });
const token = process.env.E2E_API_TOKEN, origin = process.env.E2E_BASE_URL;
const steps = [], requests = [], owned = [];
let outcome = "BLOCKED", sha, project, session, proxy, baselineDefault, lastDefault;
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
  catch (e) { steps.push({ name, status: e instanceof Blocked ? "BLOCKED" : "FAIL", error: e instanceof Blocked ? e.message : "Assertion or request failed; inspect the driver step without credential values" }); throw e; }
}
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "proxy.resources", values });
const plan = (card, values, handle, option = "persist") => api(path(card, "preview"), { expectedRevision: card.revision, values, selectedOptionId: option,
  ...(handle ? { credentialHandle: handle } : {}) }, "POST", 200);
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest,
  selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
const secure = async (card, values, secret) => {
  const draft = await api(path(card, "credentials"), { expectedRevision: card.revision, fieldId: "proxyUrl", secret }, "POST", 200);
  return plan(card, values, draft.handle);
};
const formal = () => api("/api/proxy/settings");
try {
  await step("1. Open a committed, owned Native instance and a temporary Project/Session", async () => {
    if (!token || !origin || !process.env.E2E_STARTUP_COMMAND || process.env.E2E_PROXY_RESOURCES_ISOLATED !== "1") throw new Blocked("Owned isolated startup metadata is required");
    const url = new URL(origin);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || ["4310", "4420", "4421"].includes(url.port)) throw new Blocked("Use a new owned loopback instance");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before running");
    await api("/health"); baselineDefault = lastDefault = (await formal()).defaultPolicy;
    project = await api("/api/projects", { name: marker }); session = await api(`/api/projects/${project.id}/sessions`, { title: marker });
    const caps = await api(`/api/sessions/${session.id}/configuration/capabilities`);
    assert.equal(caps.executor, "native"); assert.ok(caps.items.some(item => item.id === "proxy.resources" && !item.autoApplyEligible));
  });
  outcome = "FAIL";
  await step("2. Create through the secure URL channel and confirm without selecting a route", async () => {
    const values = { operation: "create", name: marker, kind: "custom_url" };
    let card = await propose(values); assert.equal(card.state, "collecting_input"); assert.equal(card.scope.kind, "global");
    assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0);
    const secret = "https://fixture-user:fixture-password@proxy.invalid:8443/";
    card = await secure(card, values, secret); assert.equal(card.state, "awaiting_confirmation");
    assert.doesNotMatch(JSON.stringify(card), /fixture-password|fixture-user|proxy\.invalid/);
    assert.equal((await formal()).servers.some(item => item.name === marker), false);
    assert.equal((await decide(card)).state, "applied");
    let saved = await formal(); proxy = saved.servers.find(item => item.name === marker); assert.ok(proxy); owned.push(proxy.id);
    assert.equal(proxy.url, secret); assert.equal(saved.defaultPolicy, baselineDefault);
    assert.equal((await decide(card)).state, "applied"); saved = await formal();
    assert.equal(saved.servers.filter(item => item.name === marker).length, 1);
  });
  await step("3. Rename without replacing the stored URL or claiming a verified connection", async () => {
    const values = { operation: "update", proxyId: proxy.id, name: `${marker}-renamed` };
    const card = await propose(values); assert.ok(card.fields.every(field => field.kind !== "credential"));
    const result = await decide(card); assert.equal(result.state, "applied"); assert.equal(result.activation.mode, "next_connection");
    assert.notEqual(result.activation.state, "active");
    const saved = (await formal()).servers.find(item => item.id === proxy.id);
    assert.equal(saved.url, proxy.url); assert.equal(saved.name, values.name);
  });
  await step("4. Reject an invalid replacement without echoing it, then review a corrected secure URL", async () => {
    const values = { operation: "update", proxyId: proxy.id, replaceUrl: true };
    let card = await secure(await propose(values), values, "ftp://fixture:wrong-secret@bad.invalid/#private");
    card = await decide(card); assert.equal(card.state, "needs_fix"); assert.equal(card.error.code, "INVALID_PROXY_URL");
    assert.doesNotMatch(JSON.stringify(card), /wrong-secret|bad\.invalid/);
    assert.equal((await formal()).servers.find(item => item.id === proxy.id).url, proxy.url);
    card = await secure(card, values, "socks5://fixture:replacement@proxy.invalid:1080");
    assert.equal((await decide(card)).state, "applied");
    assert.equal((await formal()).servers.find(item => item.id === proxy.id).url, "socks5://fixture:replacement@proxy.invalid:1080");
  });
  await step("5. Fence a stale delete, protect a referenced proxy, then delete once after removing its reference", async () => {
    const values = { operation: "delete", proxyId: proxy.id }; let card = await propose(values);
    lastDefault = `proxy:${proxy.id}`; await api("/api/proxy/settings", { defaultPolicy: lastDefault }, "PUT", 200);
    const stale = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, decision: "apply", selectedOptionId: card.selectedOptionId }, "POST", 409);
    assert.equal(stale.code, "RESOURCE_VERSION_CONFLICT");
    card = await plan(card, values); assert.equal((await decide(card)).state, "failed");
    assert.ok((await formal()).servers.some(item => item.id === proxy.id));
    lastDefault = baselineDefault; await api("/api/proxy/settings", { defaultPolicy: lastDefault }, "PUT", 200);
    card = await plan(card, values); assert.equal((await decide(card)).state, "applied");
    assert.equal((await decide(card)).state, "applied"); assert.equal((await formal()).servers.some(item => item.id === proxy.id), false);
  });
  await step("6. Refuse a separate creation and retain the exact formal resource set", async () => {
    const before = await formal(); let card = await propose({ operation: "create", name: `${marker}-refused`, kind: "system" });
    card = await plan(card, {}, undefined, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
    assert.deepEqual(await formal(), before);
  });
  outcome = "PASS";
} catch (e) { outcome = e instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try {
    if (baselineDefault !== undefined) {
      let state = await formal(); assert.equal(state.defaultPolicy, lastDefault);
      await api("/api/proxy/settings", { defaultPolicy: baselineDefault }, "PUT", 200);
      for (const id of owned) if (state.servers.some(item => item.id === id)) await api(`/api/proxy/servers/${id}`, undefined, "DELETE", 200);
    }
    if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned state", status: "FAIL" }); }
  await writeFile(`${directory}/report.json`, JSON.stringify({ sha, outcome, startup: process.env.E2E_STARTUP_COMMAND ?? "missing", steps, requests, browser: "not exercised", realLLM: false, proxyConnection: "not tested" }, null, 2));
  await writeFile(`${directory}/report.md`, `# Proxy resource configuration: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: `${directory}/report.md` }));
}
