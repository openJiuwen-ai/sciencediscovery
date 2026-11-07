// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: a failed Web settings synchronization cannot leak the submitted key into API logs.
 * Steps: launch an isolated committed product; save a synthetic key through its public API while the
 * owned adapter echoes it in an HTTP failure; inspect diagnostics and formal readback; clear the key.
 * Environment: Windows or Linux, built services/api/dist/server.js from the committed candidate.
 * Type: mocked JiuwenSwarm adapter; LLM/Runner execution/search/paid external capabilities: none.
 * Credentials: generated synthetic API/adapter/provider tokens only; never stored in reports or logs.
 * CostSideEffects: new .tmp data directory, two ephemeral loopback ports and one owned child process.
 * Existing instances, accounts and user data are not accessed. Stop only the child created here.
 * Run from repository root: E2E_WEB_SYNC_ISOLATED=1 node test/api/web-sync-redaction.mjs
 * Not a real JiuwenSwarm, browser, Linux or real-LLM certification.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
const directory = resolve(".tmp", `web-sync-stack-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const token = `synthetic-api-${randomUUID()}`, secret = `synthetic-provider-${randomUUID()}`, adapterToken = `synthetic-adapter-${randomUUID()}`;
const redact = value => [token, secret, adapterToken].reduce((text, key) => text.replaceAll(key, "[synthetic-secret]"), String(value));
const steps = [];
let outcome = "BLOCKED", sha, child, origin, logs = "", fail = false, echoed = false, adapter;
class Blocked extends Error {}
const waitUntil = async (check, milliseconds = 5000) => { const until = Date.now() + milliseconds; while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw Error("Timed out waiting for the owned product outcome"); };
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error) }); throw error; }
}
async function api(path, body) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "PUT", signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(secret) && !text.includes(adapterToken), "Public settings must remain write-only");
  return JSON.parse(text);
}
try {
  await step("1. Start the immutable product with an owned loopback adapter and data directory", async () => {
    if (process.env.E2E_WEB_SYNC_ISOLATED !== "1") throw new Blocked("Explicit isolated test opt-in is required");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
    sha = git("rev-parse", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit and build the candidate before running");
    adapter = createServer(async (request, response) => {
      let body = ""; for await (const part of request) body += part;
      if (request.url === "/agent/jiuwenswarm-config" && fail) {
        echoed ||= JSON.parse(body).values.bocha_api_key === secret;
        response.writeHead(401); response.end(secret);
      } else { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }
    });
    await new Promise((done, reject) => { adapter.once("error", reject); adapter.listen(0, "127.0.0.1", done); });
    const reservation = createServer(); await new Promise(done => reservation.listen(0, "127.0.0.1", done));
    const port = reservation.address().port; await new Promise(done => reservation.close(done));
    origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0",
      SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: `http://127.0.0.1:${adapter.address().port}`, SCIENCE_AGENT_ADAPTER_TOKEN: adapterToken,
      SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: "task", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    child = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs += chunk; });
    child.on("error", error => { logs += redact(error); });
    await waitUntil(async () => { if (child.exitCode !== null) throw Error("Owned API exited before readiness"); try { return (await fetch(origin + "/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 45000);
    assert.equal((await api("/api/web/settings")).backend, "jiuwenswarm");
  });
  outcome = "FAIL";
  await step("2. Save a synthetic key while the adapter returns it in a failure body", async () => {
    fail = true;
    const saved = await api("/api/web/settings", { providerApiKeys: { bocha: secret } });
    assert.ok(saved.providers.some(item => item.provider === "bocha" && item.hasApiKey));
    assert.ok(echoed, "The failing adapter must actually receive the submitted synthetic key");
    await waitUntil(() => logs.includes("could not apply the web settings to JiuwenSwarm: HTTP 401"));
    assert.ok(!logs.includes(secret), "Adapter diagnostics must not echo a provider key");
    assert.ok(!logs.includes(adapterToken), "Adapter diagnostics must not echo the authorization token");
  });
  await step("3. Read the saved state and clear the key through the public API", async () => {
    assert.ok((await api("/api/web/settings")).providers.some(item => item.provider === "bocha" && item.hasApiKey));
    fail = false;
    const cleared = await api("/api/web/settings", { providerApiKeys: { bocha: null } });
    assert.ok(cleared.providers.some(item => item.provider === "bocha" && !item.hasApiKey));
  });
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise(done => child.once("exit", done)), new Promise(done => setTimeout(done, 5000))]);
  }
  if (adapter) await new Promise(done => { adapter.close(done); adapter.closeAllConnections(); });
  await writeFile(resolve(directory, "startup.log"), redact(logs));
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, startup: "node services/api/dist/server.js", origin, dataDirectory: resolve(directory, "data"), steps, realLLM: false }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Web synchronization diagnostics: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
