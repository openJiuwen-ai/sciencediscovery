// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Connect a model in the conversation, explicitly authorize its endpoint,
 * recover from rejected credential input, retain a receipt, and complete two turns.
 * Steps: 1 prerequisites; 2 create project/session/proposal; 3 refuse unapproved
 * upload/probe; 4 consent and retry credential; 5 apply once; 6 reload receipt;
 * 7 finish two user turns without duplicates; 8 reject a bad repair; 9 recover
 * from an unavailable provider without replacing working credentials.
 * Environment: An ALREADY RUNNING isolated Native product stack built from clean HEAD.
 * Type: mocked (only the external model wire is stubbed; product routes are real).
 * LLM: journey-owned loopback OpenAI Chat Completions stub, synthetic output/usage.
 * WebSearch: none. PaperSources: none. MCP: none. OtherExternal: none.
 * Credentials: E2E_API_TOKEN for the isolated stack; synthetic in-memory model key.
 * CostSideEffects: creates and finally deletes only UUID-owned project/model/provider;
 * first-model default is restored only after checking it still belongs to this journey.
 * This driver neither starts/restarts product processes nor deletes other records.
 * Run from repository root:
 * E2E_BASE_URL=http://127.0.0.1:4410 E2E_API_TOKEN=<isolated-token> \
 * E2E_CONFIGURATION_REVIEW_ISOLATED=1 E2E_STARTUP_COMMAND='<actual product startup command>' \
 * node test/api/conversational-settings-review.mjs
 * Missing prerequisites => BLOCKED + exit 1; product assertion failure => FAIL + exit 1.
 * API coverage complements, and does not certify, browser focus/layout/secret retention.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const journeyId = randomUUID();
const marker = `configuration-review-${journeyId}`;
const reportRoot = resolve(".tmp", marker);
await mkdir(reportRoot, { recursive: true });
const token = process.env.E2E_API_TOKEN ?? "";
const secret = `synthetic-key-${randomUUID()}`;
const badSecret = `rejected-key-${randomUUID()}`;
const sensitive = [token, secret, badSecret];
const steps = [], requests = [], modelCalls = [], ownedRuns = [];
const metadata = { command: "node test/api/conversational-settings-review.mjs", worktree: process.cwd(),
  requestedRef: process.env.E2E_TARGET_REF ?? "HEAD", targetSha: "unknown", startupCommand: process.env.E2E_STARTUP_COMMAND ?? "missing",
  origin: process.env.E2E_BASE_URL ?? "missing", executor: "native required", model: "journey-owned loopback stub", browser: "not exercised" };
let outcome = "FAIL", origin, stub, stubOrigin, project, session, model, provider, baselineGlobal, baselineModels, baselineProviders;
let firstModel = false, providerUnavailable = false;
const redact = value => sensitive.filter(Boolean).reduce((text, value) => text.replaceAll(value, "[redacted]"), String(value));
class Blocked extends Error {}
async function step(name, expected, operation) {
  try { const actual = await operation(); steps.push({ name, expected, actual: redact(actual), status: "PASS" }); console.log(`PASS ${name}`); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: error instanceof Blocked ? "BLOCKED" : "FAIL" }); throw error; }
}
async function call(path, body, method = body === undefined ? "GET" : "POST", key = randomUUID()) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json", "Idempotency-Key": key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch { throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}`); }
  requests.push({ method, path, status: response.status, code: result.code, id: result.id, revision: result.revision, state: result.state });
  assert.ok(!text.includes(secret) && !text.includes(badSecret), "Product responses must never echo a submitted credential");
  return { status: response.status, body: result };
}
async function json(path, body, method, status = body === undefined ? 200 : 201, key) {
  const result = await call(path, body, method, key);
  assert.equal(result.status, status, `${method ?? (body === undefined ? "GET" : "POST")} ${path}: HTTP ${result.status}, ${result.body.code ?? "no domain code"}`);
  return result.body;
}
async function until(check, label, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  for (;;) { const result = await check(); if (result) return result;
    assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(done => setTimeout(done, 150)); }
}
const path = (request, action) => `/api/sessions/${session.id}/configuration-requests${request ? `/${request.id}` : ""}${action ? `/${action}` : ""}`;
const choice = request => request.selectedOptionId ?? request.options?.find(option => option.kind === "persisted_apply")?.id;
async function preview(request, values, handle) {
  return json(path(request, "preview"), { expectedRevision: request.revision, values,
    ...(choice(request) ? { selectedOptionId: choice(request) } : {}), ...(handle ? { credentialHandle: handle } : {}) }, "POST", 200);
}
async function consent(request) {
  assert.equal(request.endpointAuthorization?.status, "required");
  return json(path(request, "endpoint-consent"), { revision: request.revision, endpointTarget: request.endpointAuthorization.endpointTarget }, "POST", 200);
}
async function upload(request, value, key = randomUUID()) {
  const draft = await json(path(request, "credentials"), { expectedRevision: request.revision, fieldId: "apiToken", secret: value }, "POST", 200, key);
  assert.deepEqual(Object.keys(draft).sort(), ["expiresAt", "handle"]);
  sensitive.push(draft.handle); return draft;
}
async function apply(request, key = randomUUID()) {
  return json(path(request, "decision"), { revision: request.revision, previewDigest: request.previewDigest, decision: "apply",
    ...(choice(request) ? { selectedOptionId: choice(request) } : {}) }, "POST", 200, key);
}
async function turn(content) {
  const run = await json(`/api/sessions/${session.id}/runs`, { content }); ownedRuns.push(run.id);
  await until(async () => {
    const current = (await json(`/api/sessions/${session.id}/runs`)).find(item => item.id === run.id);
    assert.ok(current, "Accepted run must remain queryable");
    assert.ok(!["failed", "cancelled", "interrupted"].includes(current.status), `User turn ended as ${current.status}`);
    return current.status === "completed";
  }, `run ${run.id} completes`);
  const detail = await json(`/api/sessions/${session.id}`);
  assert.equal(detail.messages.filter(item => item.role === "user" && item.content === content).length, 1, "Exactly one stored user turn");
  assert.ok(detail.messages.some(item => item.role === "assistant" && item.content.includes(marker)), "Completed run must deliver the expected retained result");
  assert.equal((await json(`/api/sessions/${session.id}/runs`)).filter(item => item.prompt === content).length, 1, "No duplicate run for one user submission");
}
try {
  await step("1. Verify the isolated product and immutable candidate", "Clean committed HEAD, explicit isolated loopback stack and authentication; no service startup by this driver.", async () => {
    metadata.targetSha = execFileSync("git", ["-c", "core.autocrlf=true", "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (execFileSync("git", ["-c", "core.autocrlf=true", "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Blocked("Commit the candidate before formal E2E");
    if (process.env.E2E_CONFIGURATION_REVIEW_ISOLATED !== "1" || !token || !process.env.E2E_STARTUP_COMMAND) throw new Blocked("Set isolated-stack gate, API token, and actual startup command");
    let url; try { url = new URL(metadata.origin); } catch { throw new Blocked("Set E2E_BASE_URL to the isolated product origin"); }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Blocked("E2E_BASE_URL must be a loopback product origin");
    origin = url.origin;
    try { assert.equal((await fetch(origin + "/health", { signal: AbortSignal.timeout(5_000) })).status, 200); }
    catch { throw new Blocked("The isolated product API is unavailable"); }
    const auth = await call("/api/models");
    if (auth.status !== 200) throw new Blocked(`API authentication unavailable: HTTP ${auth.status}`);
    baselineModels = auth.body; baselineProviders = (await json("/api/providers")).providers;
    baselineGlobal = await json("/api/settings"); firstModel = baselineModels.length === 0;
    return `HEAD ${metadata.targetSha}; health 200; model baseline ${baselineModels.length}; first-model path ${firstModel}`;
  });
  stub = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    modelCalls.push({ path: request.url, model: body.model, streaming: body.stream === true, correctCredential: request.headers.authorization === `Bearer ${secret}` });
    if (providerUnavailable) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"Synthetic provider temporarily unavailable"}}'); return; }
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":{"message":"Synthetic credential rejected"}}'); return; }
    if (!request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end("{}"); return; }
    const usage = { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "journey-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ id: "journey-completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
    } else { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "journey-completion", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: marker }, finish_reason: "stop" }], usage })); }
  });
  await new Promise(done => stub.listen(0, "127.0.0.1", done));
  stubOrigin = `http://127.0.0.1:${stub.address().port}`;
  const values = { name: marker, model: marker, baseUrl: `${stubOrigin}/v1`, apiProtocol: "openai-chat-completions", apiVariant: "openai", tokenOptional: false };
  let proposal, approved;
  await step("2. Ask to connect a model in a new research session", "A persistent versioned request with no model creation, credential write or probe.", async () => {
    const created = await json("/api/projects", { name: marker }); project = created.project ?? created;
    session = await json(`/api/projects/${project.id}/sessions`, { title: marker, enabledConnectorIds: [], enabledSkillIds: [], approvalMode: "always_allow" });
    const key = randomUUID(); const body = { protocolVersion: 3, capabilityId: "model.connect", values: {} };
    proposal = await json(path(), body, "POST", 201, key);
    assert.equal((await json(path(), body, "POST", 201, key)).id, proposal.id, "Retrying entry must reuse the persistent request");
    proposal = await preview(proposal, values);
    assert.equal((await json(path())).items.filter(item => item.id === proposal.id).length, 1);
    assert.deepEqual((await json("/api/models")).map(item => item.id).sort(), baselineModels.map(item => item.id).sort());
    assert.equal(modelCalls.length, 0);
    return `Request ${proposal.id}, revision ${proposal.revision}; no model side effects`;
  });
  await step("3. Refuse credential upload and verification before endpoint consent", "Custom loopback destination requires explicit user-only consent; the external model receives zero requests.", async () => {
    assert.equal(proposal.endpointAuthorization?.classification, "loopback");
    assert.equal(proposal.endpointAuthorization?.status, "required");
    const rejected = await call(path(proposal, "credentials"), { expectedRevision: proposal.revision, fieldId: "apiToken", secret });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "ENDPOINT_CONSENT_REQUIRED");
    const anonymous = await preview(proposal, { ...values, tokenOptional: true });
    const result = await call(path(anonymous, "decision"), { revision: anonymous.revision, previewDigest: anonymous.previewDigest, decision: "apply", selectedOptionId: choice(anonymous) });
    assert.equal(result.status, 200);
    assert.equal(result.body.state, "needs_fix", "An unapproved token-optional endpoint must never be saved");
    assert.equal(modelCalls.length, 0);
    proposal = await preview(anonymous, values);
    return `Unapproved upload rejected (409); unapproved probe blocked (HTTP ${result.status}); model requests = 0`;
  });
  await step("4. Approve the exact destination and retry rejected credential input", "Consent alone performs no request; a failed credential upload can be retried at the same accepted revision.", async () => {
    proposal = await consent(proposal);
    assert.equal(proposal.endpointAuthorization.status, "confirmed"); assert.equal(modelCalls.length, 0);
    assert.equal((await call(path(proposal, "credentials"), { expectedRevision: proposal.revision, fieldId: "apiToken", secret: "" })).status, 400);
    const key = randomUUID(), draft = await upload(proposal, secret, key);
    assert.equal((await upload(proposal, secret, key)).handle, draft.handle, "A retry must not create a second isolated draft");
    approved = await preview(proposal, values, draft.handle);
    assert.equal(approved.fields.find(field => field.kind === "credential").status, "provided");
    assert.equal(modelCalls.length, 0, "Preview is not permission to send the probe");
    return `Credential provided at revision ${approved.revision}; ready for version-bound confirmation`;
  });
  await step("5. Confirm once and recover from a repeated confirmation", "One probe, one model, and one saved decision; first model explicitly becomes the global default.", async () => {
    const key = randomUUID(), saved = await apply(approved, key);
    assert.equal(saved.state, "applied");
    assert.equal((await apply(approved, key)).id, saved.id);
    assert.equal(modelCalls.length, 1);
    const models = await json("/api/models");
    assert.equal(models.length, baselineModels.length + 1);
    model = models.find(item => item.model === marker); assert.ok(model);
    provider = (await json("/api/providers")).providers.find(item => item.id === model.providerId); assert.ok(provider);
    assert.equal((await json(`/api/sessions/${session.id}`)).modelId, model.id);
    const global = await json("/api/settings");
    if (firstModel) assert.equal(global.effective.modelId, model.id);
    else assert.deepEqual(global.overrides, baselineGlobal.overrides);
    return `Saved model ${model.id}; exactly one probe and one registry addition; first-model default ${firstModel}`;
  });
  await step("6. Reload the conversation and inspect the durable receipt", "The saved request and one timeline receipt survive repeated independent public API reads without inventing a task run.", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await json(path(approved)); assert.equal(current.state, "applied");
      const messages = (await json(`/api/sessions/${session.id}`)).messages;
      assert.equal(messages.filter(item => item.kind === "configuration_notice" && item.configurationRequestId === approved.id).length, 1);
      assert.equal((await json(`/api/sessions/${session.id}/runs`)).length, 0);
    }
    return "One persisted receipt per request; zero synthetic runs or user messages";
  });
  await step("7. Complete the original draft and a subsequent user turn", "Each submitted task completes, retains its result, and creates exactly one run and one user turn.", async () => {
    await turn(`Complete the original research draft ${marker}. Reply with the journey marker; do not use tools or subagents.`);
    await turn(`Continue the research session ${marker}. Reply with the journey marker; do not use tools or subagents.`);
    assert.equal((await json(`/api/sessions/${session.id}/runs`)).length, 2);
    return "Two distinct user turns completed; stored expected answers; exactly two runs";
  });
  await step("8. Reject a bad credential repair while retaining the usable model", "Failed verification does not overwrite formal credentials; the session still completes a new task.", async () => {
    let repair = await json(path(), { protocolVersion: 3, capabilityId: "model.repair_credential", values: { modelId: model.id } });
    if (repair.endpointAuthorization?.status === "required") repair = await consent(repair);
    const draft = await upload(repair, badSecret); repair = await preview(repair, { modelId: model.id }, draft.handle);
    const rejected = await apply(repair);
    assert.equal(rejected.state, "needs_fix");
    assert.equal((await json(`/api/sessions/${session.id}`)).modelId, model.id);
    await turn(`After a rejected credential repair, finish this task ${marker}. Reply with the journey marker; do not use tools or subagents.`);
    assert.ok(modelCalls.some(item => !item.correctCredential), "The bad candidate was checked against the controlled external stub");
    assert.ok(modelCalls.at(-1).correctCredential, "The later task still uses the earlier formal credential");
    return "Bad repair visibly needs correction; third task completed using the unchanged formal credential";
  });
  await step("9. Recover from an unavailable provider during verification", "A service outage produces a correction receipt without overwriting saved credentials; a later task completes after recovery.", async () => {
    let repair = await json(path(), { protocolVersion: 3, capabilityId: "model.repair_credential", values: { modelId: model.id } });
    if (repair.endpointAuthorization?.status === "required") repair = await consent(repair);
    const draft = await upload(repair, secret); repair = await preview(repair, { modelId: model.id }, draft.handle);
    providerUnavailable = true;
    try { assert.equal((await apply(repair)).state, "needs_fix"); }
    finally { providerUnavailable = false; }
    assert.equal((await json(`/api/sessions/${session.id}`)).modelId, model.id);
    await turn(`After the provider recovers, finish this task ${marker}. Reply with the journey marker; do not use tools or subagents.`);
    return "Unavailable provider reported as needs_fix; fourth user task completed after recovery";
  });
  outcome = "PASS";
} catch (error) {
  outcome = error instanceof Blocked ? "BLOCKED" : "FAIL";
  console.error(redact(error.stack)); process.exitCode = 1;
} finally {
  // Always preserve evidence before cleanup. Never enumerate/delete unrelated data.
  const saveReport = async () => {
    await writeFile(resolve(reportRoot, "report.md"), `# Conversational settings review: ${outcome}\n\n${Object.entries(metadata).map(([key, value]) => `${key}: ${redact(value)}`).join("\n\n")}\n\nNo real model, paid API, browser automation, service restart, or external lookup was used.\n\n${steps.map(item => `## ${item.name}: ${item.status}\n\nExpected: ${item.expected}\n\nActual: ${item.actual}\n`).join("\n")}\n`);
    await writeFile(resolve(reportRoot, "steps.json"), JSON.stringify({ outcome, metadata, steps, requests, modelCalls }, null, 2));
  };
  await saveReport();
  try {
    if (project) await step("10. Remove only this journey's scratch records", "Owned project/session, model and provider removed; original default retained/restored; evidence remains.", async () => {
      for (const id of ownedRuns) {
        const run = (await json(`/api/sessions/${session.id}/runs`)).find(item => item.id === id);
        if (run && !["completed", "failed", "cancelled", "interrupted"].includes(run.status)) await json(`/api/sessions/${session.id}/runs/${id}/cancel`, undefined, "POST");
      }
      const projects = await json("/api/projects"), own = projects.find(item => item.id === project.id);
      assert.equal(own?.name, marker, "Cleanup must verify exact project ownership");
      await json(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
      const models = await json("/api/models"); model ??= models.find(item => item.model === marker);
      if (model) {
        assert.equal(model.model, marker);
        if (firstModel) {
          const current = await json("/api/settings");
          assert.equal(current.effective.modelId, model.id, "Do not overwrite another editor's default during cleanup");
          const rest = { ...current.overrides }; delete rest.modelId;
          const oldRest = { ...baselineGlobal.overrides }; delete oldRest.modelId;
          assert.deepEqual(rest, oldRest, "Do not overwrite unrelated settings during cleanup");
          await json("/api/settings", baselineGlobal.overrides, "PUT", 200);
        }
        await json(`/api/models/${model.id}`, undefined, "DELETE", 200);
        provider ??= (await json("/api/providers")).providers.find(item => item.id === model.providerId);
      }
      if (provider) { assert.equal(provider.name, marker); assert.ok(!baselineProviders.some(item => item.id === provider.id)); await json(`/api/providers/${provider.id}`, undefined, "DELETE", 200); }
      assert.deepEqual((await json("/api/models")).map(item => item.id).sort(), baselineModels.map(item => item.id).sort());
      return "Exact UUID-owned records removed; no bulk reset or filesystem deletion";
    });
  } catch (error) { outcome = "FAIL"; process.exitCode = 1; console.error(redact(error.stack)); }
  if (stub) { stub.closeAllConnections(); await new Promise(done => stub.close(done)); }
  await saveReport();
  console.log(JSON.stringify({ outcome, targetSha: metadata.targetSha, report: resolve(reportRoot, "report.md") }));
}
