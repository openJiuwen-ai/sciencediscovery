// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: Review and save the proxy default through the public configuration API.
 * Steps: create owned Project/Session; show an unsaved proxy card; confirm and reread formal settings;
 * replay confirmation; reject another change; reject a stale approval after a formal settings edit.
 * Environment: committed, isolated Native product started via node services/api/dist/server.js (or start-stack.sh).
 * Type: mocked/credential-free; LLM/Runner execution/Paper/WebSearch/OtherExternal: none.
 * Credentials: only the isolated product's E2E_API_TOKEN, never persisted in the report.
 * CostSideEffects: deployment-wide routing defaults change only inside the explicitly owned isolated instance;
 * no proxy connection, package installation, downloads, model calls, or user-instance reset. Restore owned settings in finally.
 * Run: E2E_BASE_URL=http://127.0.0.1:<owned-port> E2E_API_TOKEN=<owned-token>
 * E2E_PROXY_DEFAULT_ISOLATED=1 E2E_STARTUP_COMMAND='<actual startup>' node test/api/configuration-proxy-default.mjs
 * This covers public API/card decisions, not browser layout or real-LLM natural-language success.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const marker = `proxy-default-${randomUUID()}`;
const directory = `.tmp/${marker}`;
await mkdir(directory, { recursive: true });
const token = process.env.E2E_API_TOKEN;
const origin = process.env.E2E_BASE_URL;
const steps = [], requests = [];
let outcome = "BLOCKED", baseline, lastSaved, proxy, project, session, sha;
class Blocked extends Error {}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  requests.push({ method, path, status: response.status, code: value.code });
  assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`);
  return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (e) { steps.push({ name, status: e instanceof Blocked ? "BLOCKED" : "FAIL", error: String(e) }); throw e; }
}
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "proxy.default", values });
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest,
  decision, selectedOptionId: card.selectedOptionId }, "POST", 200);
try {
  await step("1. Verify an immutable, explicitly isolated Native product", async () => {
    if (!token || !origin || !process.env.E2E_STARTUP_COMMAND || process.env.E2E_PROXY_DEFAULT_ISOLATED !== "1") throw new Blocked("Owned isolated startup metadata and token are required");
    const url = new URL(origin);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || ["4310", "4420", "4421"].includes(url.port)) throw new Blocked("A new owned loopback instance is required");
    sha = git("rev-parse", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before running the journey");
    await api("/health");
    baseline = await api("/api/proxy/settings");
    proxy = await api("/api/proxy/servers", { name: marker, kind: "custom_url", url: "http://127.0.0.1:1" });
    lastSaved = await api("/api/proxy/settings");
    project = await api("/api/projects", { name: marker });
    session = await api(`/api/projects/${project.id}/sessions`, { title: marker });
    const capabilities = await api(`/api/sessions/${session.id}/configuration/capabilities`);
    assert.equal(capabilities.executor, "native");
    assert.ok(capabilities.items.some(item => item.id === "proxy.default" && !item.autoApplyEligible));
  });
  outcome = "FAIL";
  await step("2. Present a proxy card without modifying the deployment", async () => {
    const card = await propose({});
    assert.equal(card.state, "collecting_input");
    assert.deepEqual(card.fields.map(field => field.id), ["defaultPolicy"]);
    assert.deepEqual(await api("/api/proxy/settings"), lastSaved);
    const closed = await api(path(card, "preview"), { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200);
    await decide(closed, "dismiss");
  });
  await step("3. Confirm one field, reread formal settings and replay the same decision", async () => {
    const defaultPolicy = `proxy:${proxy.id}`;
    const card = await propose({ defaultPolicy });
    assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined);
    assert.equal(card.verificationPlan.maxRequests, 0);
    assert.deepEqual(await api("/api/proxy/settings"), lastSaved);
    assert.equal((await decide(card)).state, "applied");
    lastSaved = { ...lastSaved, defaultPolicy };
    assert.deepEqual(await api("/api/proxy/settings"), lastSaved);
    assert.equal((await decide(card)).state, "applied");
  });
  await step("4. Refuse a separate change without modifying the saved defaults", async () => {
    let card = await propose({ defaultPolicy: "none" });
    card = await api(path(card, "preview"), { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200);
    assert.equal((await decide(card, "dismiss")).state, "dismissed");
    assert.deepEqual(await api("/api/proxy/settings"), lastSaved);
  });
  await step("5. A concurrent formal update fences the old card", async () => {
    const card = await propose({ defaultPolicy: "none" });
    lastSaved = await api("/api/proxy/settings", { defaultPolicy: "none" }, "PUT", 200);
    const result = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, decision: "apply", selectedOptionId: card.selectedOptionId }, "POST", 409);
    assert.equal(result.code, "RESOURCE_VERSION_CONFLICT");
    assert.deepEqual(await api("/api/proxy/settings"), lastSaved);
  });
  outcome = "PASS";
} catch (e) { outcome = e instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try {
    if (baseline) { assert.deepEqual(await api("/api/proxy/settings"), lastSaved); await api("/api/proxy/settings", { defaultPolicy: baseline.defaultPolicy }, "PUT", 200); if (proxy) await api(`/api/proxy/servers/${proxy.id}`, undefined, "DELETE", 200); }
    if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact journey-owned state", status: "FAIL" }); }
  await writeFile(`${directory}/report.json`, JSON.stringify({ sha, outcome, startup: process.env.E2E_STARTUP_COMMAND ?? "missing", steps, requests, browser: "not exercised", realLLM: false }, null, 2));
  await writeFile(`${directory}/report.md`, `# Proxy default configuration: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: `${directory}/report.md` }));
}
