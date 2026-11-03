// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: select or disable Runners and restore Project inheritance through public configuration cards.
 * Steps: create an owned Project/Session; inspect an unsaved card; confirm an explicit empty allocation;
 * reread formal state and replay; restore inheritance; reject another change; fence a stale approval.
 * Environment: immutable built Native product, new loopback port and isolated data directory.
 * Type: credential-free; LLM/Runner execution/Paper/WebSearch/OtherExternal: none.
 * Credentials: only the isolated product's E2E_API_TOKEN; never written into reports.
 * CostSideEffects: owned Project/Session allocation only; no registration, SSH, execution or host probes.
 * Delete only the Project created here in finally. Existing user runtimes are not accessed.
 * Run from root: E2E_BASE_URL=http://127.0.0.1:<owned-port> E2E_API_TOKEN=<owned-token>
 * E2E_RUNNER_ASSIGNMENT_ISOLATED=1 E2E_STARTUP_COMMAND='<actual startup>' node test/api/configuration-runner-assignment.mjs
 * Public API coverage does not certify browser UI or real-LLM natural-language behavior.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const marker = `runner-assignment-${randomUUID()}`, directory = `.tmp/${marker}`;
await mkdir(directory, { recursive: true });
const token = process.env.E2E_API_TOKEN, origin = process.env.E2E_BASE_URL;
const steps = [], requests = [];
let outcome = "BLOCKED", project, session, sha;
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID(),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code });
  assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error) }); throw error; }
}
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "runner.assign", values });
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, decision, selectedOptionId: card.selectedOptionId }, "POST", 200);
const formal = () => api(`/api/sessions/${session.id}`);
try {
  await step("1. Verify isolation and create owned Project/Session", async () => {
    if (!origin || !token || process.env.E2E_RUNNER_ASSIGNMENT_ISOLATED !== "1" || !process.env.E2E_STARTUP_COMMAND) throw new Blocked("Owned isolated startup metadata is required");
    const url = new URL(origin);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || ["4310", "4420", "4421"].includes(url.port)) throw new Blocked("A new owned loopback instance is required");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim(); sha = git("rev-parse", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before running");
    await api("/health"); project = await api("/api/projects", { name: marker });
    session = await api(`/api/projects/${project.id}/sessions`, { title: marker });
    const capabilities = await api(`/api/sessions/${session.id}/configuration/capabilities`);
    assert.ok(capabilities.items.some(item => item.id === "runner.assign" && !item.autoApplyEligible));
    assert.equal((await formal()).runnerIds, undefined);
  });
  outcome = "FAIL";
  await step("2. Opening a card does not materialize an override", async () => {
    let card = await propose({}); assert.equal(card.state, "collecting_input");
    assert.equal((await formal()).runnerIds, undefined);
    card = await api(path(card, "preview"), { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200);
    await decide(card, "dismiss");
  });
  await step("3. Confirm an explicit empty selection and replay without changing its meaning", async () => {
    const card = await propose({ runnerIds: [] }); assert.equal(card.autoApplyAt, undefined);
    assert.equal(card.verificationPlan.maxRequests, 0); assert.equal(card.scope.kind, "session");
    assert.equal((await decide(card)).state, "applied"); assert.deepEqual((await formal()).runnerIds, []);
    assert.equal((await decide(card)).state, "applied"); assert.deepEqual((await formal()).runnerIds, []);
  });
  await step("4. Restore inheritance by removing both allocation overrides", async () => {
    assert.equal((await decide(await propose({ selectionMode: "inherit" }))).state, "applied");
    const saved = await formal(); assert.equal(saved.runnerIds, undefined); assert.equal(saved.remoteRunnerHostIds, undefined);
  });
  await step("5. Refusal preserves inheritance", async () => {
    let card = await propose({ runnerIds: [] });
    card = await api(path(card, "preview"), { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200);
    await decide(card, "dismiss"); assert.equal((await formal()).runnerIds, undefined);
  });
  await step("6. Concurrent formal allocation fences the old card", async () => {
    const card = await propose({ runnerIds: [] });
    await api(`/api/sessions/${session.id}`, { runnerIds: ["local"] }, "PATCH", 200);
    const rejected = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, decision: "apply", selectedOptionId: card.selectedOptionId }, "POST", 409);
    assert.equal(rejected.code, "RESOURCE_VERSION_CONFLICT"); assert.deepEqual((await formal()).runnerIds, ["local"]);
  });
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try { if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Delete only the owned Project", status: "FAIL" }); }
  await writeFile(`${directory}/report.json`, JSON.stringify({ outcome, sha, startup: process.env.E2E_STARTUP_COMMAND, steps, requests, browser: "not exercised", realLLM: false }, null, 2));
  await writeFile(`${directory}/report.md`, `# Runner allocation: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: `${directory}/report.md` }));
}
