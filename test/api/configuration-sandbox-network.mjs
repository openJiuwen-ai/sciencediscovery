// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: change sandbox network policy only after independent human-channel consent and manual Apply.
 * Steps: start an isolated committed product with an owned mock Runner; reject ordinary Apply;
 * independently acknowledge the exact policy; apply/read formal policy and epoch; verify exact old-kernel
 * cleanup; replay without a second mutation; reject stale consent; decline without authorizing a policy.
 * Environment: built services/api/dist/server.js; fresh data directory and two ephemeral loopback ports.
 * Type: mocked Runner metadata/control; no kernel process, SSH, external network, search or LLM calls.
 * Credentials: generated synthetic API and Runner tokens only, excluded from reports/logs.
 * CostSideEffects: changes the network policy only in this explicitly owned isolated instance.
 * Existing instances, user data, pending cards and global account settings are not accessed.
 * Run from repository root: E2E_SECURITY_NETWORK_ISOLATED=1 node test/api/configuration-sandbox-network.mjs
 * This is public API coverage, not browser layout, real Runner enforcement or Linux/real-model evidence.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
const directory = resolve(".tmp", `security-network-stack-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const token = `synthetic-api-${randomUUID()}`, runnerToken = `synthetic-runner-${randomUUID()}`;
const redact = value => [token, runnerToken].reduce((text, key) => text.replaceAll(key, "[synthetic-token]"), String(value));
let origin, child, runner, logs = "", outcome = "BLOCKED", sha, project, session, baseline, oldEpoch, oldAlive = true, lists = 0;
const steps = [], retired = [];
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, action) { try { await action(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error) }); throw error; } }
const path = (card, operation) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${operation ? `/${operation}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "security.network", values });
const decision = card => ({ revision: card.revision, previewDigest: card.previewDigest, decision: "apply", selectedOptionId: "persist" });
const consent = card => api(path(card, "security-consent"), { revision: card.revision, targetDigest: card.securityConsent.targetDigest, acknowledged: true }, "POST", 200);
try {
  await step("1. Start the immutable isolated product and owned Runner control stub", async () => {
    if (process.env.E2E_SECURITY_NETWORK_ISOLATED !== "1") throw new Blocked("Explicit isolated test opt-in is required");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim(); sha = git("rev-parse", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit and build the candidate before running");
    const kernel = (id, epoch) => ({ id, permissionEpochId: epoch, sessionId: session.id, agentId: "main", status: "running", language: "python", kernelMode: "persistent", createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), environmentRevisionId: "owned-fixture" });
    runner = createServer(async (request, response) => {
      request.resume(); response.setHeader("content-type", "application/json");
      try {
        if (request.url === "/kernels" && request.method === "GET") {
          lists++; const current = await api(`/api/sessions/${session.id}`);
          response.end(JSON.stringify([...(oldAlive ? [kernel("owned-old-kernel", oldEpoch)] : []), kernel("owned-new-kernel", current.permissionEpochId)]));
        } else if (request.url?.startsWith("/kernels/") && request.url !== "/kernels/teardown") {
          const id = decodeURIComponent(request.url.split("/")[2]); retired.push(id);
          if (id === "owned-old-kernel") oldAlive = false;
          response.end(JSON.stringify({ count: 1, kernelId: id, reason: "owned mock acknowledgement" }));
        } else response.end(JSON.stringify(request.url === "/health" ? { scientificEnvs: { available: true } } : { count: 0 }));
      } catch { response.statusCode = 500; response.end(JSON.stringify({ error: "Owned mock failed" })); }
    });
    await new Promise((done, reject) => { runner.once("error", reject); runner.listen(0, "127.0.0.1", done); });
    const reservation = createServer(); await new Promise(done => reservation.listen(0, "127.0.0.1", done));
    const port = reservation.address().port; await new Promise(done => reservation.close(done)); origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0",
      SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_RUNNER_URL: `http://127.0.0.1:${runner.address().port}`, SCIENCE_AGENT_RUNNER_TOKEN: runnerToken,
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[key] = "";
    child = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs += chunk; });
    const deadline = Date.now() + 45000; let ready = false;
    while (Date.now() < deadline) { if (child.exitCode !== null) throw Error("Owned API exited"); try { if ((await fetch(origin + "/health", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {} await new Promise(done => setTimeout(done, 100)); }
    assert.ok(ready, "Owned API readiness"); baseline = await api("/api/sandbox-network-settings");
    project = await api("/api/projects", { name: `owned-security-${randomUUID()}` });
    session = await api(`/api/projects/${project.id}/sessions`, { title: "Owned security policy" }); oldEpoch = session.permissionEpochId;
  });
  outcome = "FAIL";
  let card;
  await step("2. Ordinary Apply cannot authorize a sandbox policy", async () => {
    card = await propose({ mode: "domain-allowlist", allowedDomainsText: "EXAMPLE.ORG", allowPrivateNetwork: false });
    assert.equal(card.securityConsent.status, "required"); assert.equal(card.autoApplyAt, undefined);
    const rejected = await api(path(card, "decision"), decision(card), "POST", 409); assert.equal(rejected.code, "SECURITY_CONSENT_REQUIRED");
    const noAcknowledgement = await api(path(card, "security-consent"), { revision: card.revision, targetDigest: card.securityConsent.targetDigest, acknowledged: false }, "POST", 409);
    assert.equal(noAcknowledgement.code, "SECURITY_CONSENT_REQUIRED"); assert.deepEqual(await api("/api/sandbox-network-settings"), baseline);
    assert.equal((await api(`/api/sessions/${session.id}`)).permissionEpochId, oldEpoch);
  });
  await step("3. Independent acknowledgement alone still does not apply the policy", async () => {
    card = await consent(card); assert.equal(card.securityConsent.status, "confirmed");
    assert.deepEqual(await api("/api/sandbox-network-settings"), baseline); assert.deepEqual(retired, []);
  });
  await step("4. Manual Apply saves policy and retires only old-epoch kernel IDs", async () => {
    const applied = await api(path(card, "decision"), decision(card), "POST", 200);
    assert.equal(applied.state, "applied"); assert.equal(applied.activation.state, "active"); assert.equal(applied.activation.mode, "next_execution");
    const saved = await api("/api/sandbox-network-settings"); assert.equal(saved.mode, "domain-allowlist"); assert.deepEqual(saved.allowedDomains, ["example.org"]);
    const current = await api(`/api/sessions/${session.id}`); assert.notEqual(current.permissionEpochId, oldEpoch); assert.equal(current.approvalMode, session.approvalMode);
    assert.deepEqual(retired, ["owned-old-kernel"]); const count = lists;
    await api(path(card, "decision"), decision(card), "POST", 200);
    assert.equal((await api(`/api/sessions/${session.id}`)).permissionEpochId, current.permissionEpochId); assert.equal(lists, count);
  });
  await step("5. Concurrent formal policy changes invalidate the exact old consent", async () => {
    card = await propose({ mode: "none", allowedDomainsText: "" }); await consent(card);
    await api("/api/sandbox-network-settings", baseline, "PUT", 200);
    const rejected = await api(path(card, "decision"), decision(card), "POST", 409); assert.equal(rejected.code, "RESOURCE_VERSION_CONFLICT");
    assert.deepEqual(await api("/api/sandbox-network-settings"), baseline);
  });
  await step("6. Refusal needs no security consent and does not change permissions", async () => {
    // The stale request is still the active target. Replan that card rather than opening a duplicate.
    card = await api(path(card, "preview"), { expectedRevision: card.revision, values: { mode: "open" }, selectedOptionId: "dismiss" }, "POST", 200);
    assert.equal(card.securityConsent.status, "required");
    const result = await api(path(card, "decision"), { ...decision(card), decision: "dismiss", selectedOptionId: "dismiss" }, "POST", 200);
    assert.equal(result.state, "dismissed"); assert.deepEqual(await api("/api/sandbox-network-settings"), baseline);
  });
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try { if (baseline) await api("/api/sandbox-network-settings", baseline, "PUT", 200); if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned state", status: "FAIL" }); }
  if (child && child.exitCode === null) { child.kill(); await Promise.race([new Promise(done => child.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (runner) await new Promise(done => { runner.close(done); runner.closeAllConnections(); });
  await writeFile(resolve(directory, "startup.log"), redact(logs));
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, startup: "node services/api/dist/server.js", steps, oldKernelIdsRetired: retired, kernelListings: lists, realLLM: false }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Independent sandbox network policy: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
