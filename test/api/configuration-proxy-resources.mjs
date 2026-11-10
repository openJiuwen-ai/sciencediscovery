// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: Rename existing proxies through the conversation API and reject removed operations.
 * Steps: owned startup; existing API fixture; rename/repeat; reject CRUD/URL/default proposals; refusal.
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
  await step("2. Create an isolated fixture using the unchanged settings API", async () => {
    const created = await api("/api/proxy/servers", { name: marker, kind: "custom_url", url: "https://fixture-user:fixture-password@proxy.invalid:8443/" });
    proxy = created; owned.push(proxy.id);
    assert.ok(proxy.id);
  });
  await step("3. Rename without replacing URL, type or routing; repeated approval is idempotent", async () => {
    const card = await propose({ proxyId: proxy.id, name: `${marker}-renamed` });
    assert.equal(card.state, "awaiting_confirmation");
    assert.ok(card.fields.every(field => field.kind !== "credential"));
    assert.equal((await decide(card)).state, "applied");
    assert.equal((await decide(card)).state, "applied");
    const state = await formal(), saved = state.servers.find(item => item.id === proxy.id);
    assert.equal(saved.name, `${marker}-renamed`); assert.equal(saved.kind, proxy.kind);
    assert.equal(saved.url, proxy.url); assert.equal(state.defaultPolicy, baselineDefault);
  });
  await step("4. Removed operations reject without changing settings", async () => {
    const before = await formal();
    for (const values of [{ operation: "create", name: marker, kind: "system" }, { operation: "delete", proxyId: proxy.id },
      { proxyId: proxy.id, kind: "system" }, { proxyId: proxy.id, replaceUrl: true }]) {
      const rejected = await api(path(), { protocolVersion: 3, capabilityId: "proxy.resources", values }, "POST", 400);
      assert.equal(rejected.code, "INVALID_CONFIGURATION_INPUT");
    }
    const rejected = await api(path(), { protocolVersion: 3, capabilityId: "proxy.default", values: { defaultPolicy: "none" } }, "POST", 409);
    assert.equal(rejected.code, "CONFIGURATION_CAPABILITY_UNAVAILABLE");
    assert.deepEqual(await formal(), before);
  });
  await step("5. Dismiss a rename without writing", async () => {
    const before = await formal(); let card = await propose({ proxyId: proxy.id, name: `${marker}-refused` });
    card = await plan(card, { proxyId: proxy.id, name: `${marker}-refused` }, undefined, "dismiss");
    assert.equal((await decide(card, "dismiss")).state, "dismissed");
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
