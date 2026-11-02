// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: keep late old-provider model discovery from replacing current-connection cache.
 * Steps: own compiled product; hold old model-list request; update provider endpoint/key;
 * complete/cache new discovery; release old response; verify conflict/current cache.
 * Environment: fresh data and two ephemeral loopback ports; controlled discovery canary.
 * Type: actual public HTTP product journey, synthetic provider model-list responses only.
 * Credentials: generated owned API token and synthetic provider keys; never report values.
 * CostSideEffects: delete exact owned provider, stop owned product/canary, retain reports.
 * Run: E2E_PROVIDER_CACHE_ISOLATED=1 node test/api/provider-model-cache-race.mjs
 * Boundary: no real model/credentials, browser, Linux, Runner or Jiuwen validation.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", "provider-cache-race-" + randomUUID()); await mkdir(directory, { recursive: true });
const token = "owned-api-" + randomUUID(), keys = ["old-", "new-"].map(prefix => prefix + randomUUID()), steps = [], requests = [], canaryCalls = [];
const redact = value => [token, ...keys].reduce((text, key) => text.replaceAll(key, "[owned-secret]"), String(value));
let origin, product, canary, provider, sha, logs = "", outcome = "BLOCKED", oldResponse, oldRequest, observedOld;
const oldStarted = new Promise(done => { observedOld = done; });
class Blocked extends Error {}
async function listen(server) { await new Promise(done => server.listen(0, "127.0.0.1", done)); return server.address().port; }
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15000), headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status });
  assert.ok([token, ...keys].every(key => !JSON.stringify(value).includes(key)), "A synthetic secret escaped the public response");
  return { status: response.status, value };
}
async function step(name, action) { try { await action(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error.message) }); throw error; } }
const modelIds = result => result.value.models.map(model => model.id);
const reply = (response, id) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ data: [{ id }] })); };
try {
  await step("1. Start an immutable isolated product with a controlled old/new discovery endpoint", async () => {
    if (process.env.E2E_PROVIDER_CACHE_ISOLATED !== "1") throw new Blocked("Explicit owned isolation required");
    const git = (...args) => execFileSync("git", ["-c", "safe.directory=" + process.cwd().replaceAll("\\", "/"), ...args], { encoding: "utf8" }).trim();
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit product candidate first");
    canary = createServer((request, response) => {
      request.resume(); const old = request.url === "/old/v1/models", current = request.url === "/new/v1/models";
      canaryCalls.push({ path: request.url, method: request.method, correctKey: request.headers.authorization === "Bearer " + keys[old ? 0 : 1] });
      if (old && !oldResponse) { oldResponse = response; observedOld(); return; }
      if (current) return reply(response, "owned-new-model");
      response.writeHead(403, { "content-type": "application/json" }); response.end('{"error":"Forbidden owned canary operation"}');
    });
    const canaryPort = await listen(canary), reservation = createServer(), port = await listen(reservation); await new Promise(done => reservation.close(done)); origin = "http://127.0.0.1:" + port;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[key] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) { stream.on("data", chunk => { logs += redact(chunk); }); }
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Owned product exited"); try { if ((await api("/health")).status === 200) { ready = true; break; } } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned product was not ready");
    const created = await api("/api/providers", { name: "Owned cache race", baseUrl: `http://127.0.0.1:${canaryPort}/old/v1`, apiProtocol: "openai-chat-completions", apiVariant: "openai", apiToken: keys[0] }); assert.equal(created.status, 201); provider = created.value;
  });
  outcome = "FAIL";
  await step("2. Hold old discovery, update endpoint/key and populate the current connection cache first", async () => {
    oldRequest = api(`/api/providers/${provider.id}/models`); await Promise.race([oldStarted, new Promise((_, reject) => setTimeout(() => reject(new Error("Old owned request did not start")), 5000))]);
    const updated = await api(`/api/providers/${provider.id}`, { baseUrl: provider.baseUrl.replace("/old/", "/new/"), apiToken: keys[1] }, "PUT"); assert.equal(updated.status, 200);
    const current = await api(`/api/providers/${provider.id}/models`); assert.equal(current.status, 200); assert.deepEqual(modelIds(current), ["owned-new-model"]); assert.equal(canaryCalls.length, 2);
  });
  await step("3. A late old discovery cannot overwrite the current cache and returns an explicit refresh conflict", async () => {
    reply(oldResponse, "owned-old-model"); const late = await oldRequest;
    const current = await api(`/api/providers/${provider.id}/models`); assert.equal(current.status, 200); assert.deepEqual(modelIds(current), ["owned-new-model"], "Late old discovery poisoned the current provider cache");
    assert.equal(late.status, 409); assert.equal(canaryCalls.length, 2, "No automatic request retry is allowed"); assert.ok(canaryCalls.every(call => call.correctKey));
  });
  await step("4. Repeated reads of the same connection keep the valid cache without new discovery", async () => {
    const current = await api(`/api/providers/${provider.id}/models`); assert.equal(current.status, 200); assert.deepEqual(modelIds(current), ["owned-new-model"]); assert.equal(canaryCalls.length, 2);
  }); outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  if (oldResponse && !oldResponse.writableEnded) reply(oldResponse, "owned-old-model"); await oldRequest?.catch(() => undefined);
  try { if (provider) assert.equal((await api(`/api/providers/${provider.id}`, undefined, "DELETE")).status, 200); steps.push({ name: "Delete exact owned provider", status: "PASS" }); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Delete exact owned provider", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  if (canary) { canary.closeAllConnections(); await new Promise(done => canary.close(done)); }
  await writeFile(resolve(directory, "startup.log"), logs); await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps, requests, canaryCalls, boundary: "Owned compiled product and controlled model-list HTTP responses; no actual model/real credentials/browser/Linux/Runner/Jiuwen", productExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Provider discovery cache: ${outcome}\n\nCommit: ${sha}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`); console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
