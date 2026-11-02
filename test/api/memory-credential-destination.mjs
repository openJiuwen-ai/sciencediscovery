// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: formal password changes and self-heal forward the current saved Neo4j target with the credential.
 * Steps: immutable owned API/stub; configure target; password-only PUT; degraded GET self-heal; clear; confirm no later credential push.
 * Environment: actual compiled Native product, fresh owned data and two ephemeral loopback ports.
 * Type: owned MemoryGraph HTTP stub only, never a real database, LLM, Runner execution or paid request.
 * Credentials: synthetic owned API, sidecar and Neo4j values; only presence/equality booleans enter evidence.
 * CostSideEffects: own settings restored and own server/stub closed; no user project/settings touched.
 * Run: E2E_MEMORY_DESTINATION_ISOLATED=1 node test/api/memory-credential-destination.mjs
 * Boundary: verifies API→sidecar control binding, not real Neo4j authentication or database readiness.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `memory-destination-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-api-${randomUUID()}`, sidecarToken = `owned-sidecar-${randomUUID()}`, password = `synthetic-neo4j-${randomUUID()}`;
const httpUri = "https://owned-graph.invalid:7474", user = "owned-neo4j-user";
const steps = [], requests = [], pushes = []; let outcome = "BLOCKED", sha, product, stub, origin, baseline, logs = "", backend = "local", featurePushes;
class Blocked extends Error {}
const redact = value => [token, sidecarToken, password].reduce((text, secret) => text.replaceAll(secret, "[owned-secret]"), String(value));
async function listen(server) { await new Promise(done => server.listen(0, "127.0.0.1", done)); return server.address().port; }
async function api(path, body, method = body === undefined ? "GET" : "PUT") {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status }); assert.equal(response.status, 200); return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error.message) }); throw error; }
}
function bound(push, clear = false) {
  assert.ok(push, "The sidecar must receive the owned credential control request");
  assert.equal(push.httpUriMatches, true, "Credential push must carry the current formal HTTP destination");
  assert.equal(push.userMatches, true, "Credential push must carry the current formal username");
  assert.equal(clear ? push.cleared : push.passwordMatches, true);
}
try {
  await step("1. Start the immutable owned product and a degraded MemoryGraph HTTP stub", async () => {
    if (process.env.E2E_MEMORY_DESTINATION_ISOLATED !== "1") throw new Blocked("Explicit owned isolation is required");
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Blocked("Commit the candidate before running");
    stub = createServer(async (request, response) => {
      let raw = ""; for await (const part of request) raw += part;
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") return response.end(JSON.stringify({ status: "degraded", backend }));
      if (request.headers.authorization !== `Bearer ${sidecarToken}`) { response.statusCode = 401; return response.end("{}"); }
      const body = JSON.parse(raw || "{}");
      if (request.url === "/internal/backend") backend = body.backend;
      if (request.url === "/internal/neo4j-password") pushes.push({ httpUriMatches: body.http_uri === httpUri, userMatches: body.user === user,
        passwordMatches: body.password === password, cleared: body.password === null, hasHttpUri: Object.hasOwn(body, "http_uri"), hasUser: Object.hasOwn(body, "user") });
      return response.end(JSON.stringify({ ok: true }));
    });
    const sidecarPort = await listen(stub), reservation = createServer(), port = await listen(reservation); await new Promise(done => reservation.close(done));
    origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native",
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "1", SCIENCE_AGENT_MEMORY_GRAPH_URL: `http://127.0.0.1:${sidecarPort}`, SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN: sidecarToken, SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[name] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) stream.on("data", data => { logs += redact(data); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Owned product exited during startup");
      try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned product did not become ready");
    baseline = await api("/api/memory/settings"); if (baseline.hasNeo4jPassword) throw new Blocked("Fresh owned data must not contain a credential");
  });
  outcome = "FAIL";
  await step("2. Save an owned formal connection without a credential or real database access", async () => {
    await api("/api/memory/settings", { enabled: false, backend: "neo4j", neo4jHttp: httpUri, neo4jUser: user }); assert.equal(pushes.length, 0);
  });
  await step("3. A password-only PUT forwards the saved destination and username with the new value", async () => {
    const saved = await api("/api/memory/settings", { neo4jPassword: password }); assert.equal(saved.hasNeo4jPassword, true); bound(pushes.at(-1)); assert.equal(pushes.length, 1);
  });
  await step("4. GET-time credential self-heal also carries the same formal target", async () => {
    await api("/api/memory/settings", { enabled: true }); const before = pushes.length;
    const saved = await api("/api/memory/settings"); assert.equal(saved.memoryGraphStatus, "degraded");
    assert.equal(pushes.length, before + 1); bound(pushes.at(-1));
  });
  await step("5. Clearing a password sends null together with the current formal connection", async () => {
    const saved = await api("/api/memory/settings", { neo4jPassword: null }); assert.equal(saved.hasNeo4jPassword, false); bound(pushes.at(-1), true);
  });
  await step("6. A later degraded GET cannot re-push the cleared credential", async () => {
    const before = pushes.length, saved = await api("/api/memory/settings"); assert.equal(saved.hasNeo4jPassword, false);
    assert.equal(saved.neo4jHttp, httpUri); assert.equal(saved.neo4jUser, user); assert.equal(pushes.length, before);
  });
  featurePushes = structuredClone(pushes); outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try { if (baseline) await api("/api/memory/settings", { enabled: baseline.enabled, backend: baseline.backend, neo4jHttp: baseline.neo4jHttp, neo4jUser: baseline.neo4jUser, neo4jPassword: null }); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore owned baseline", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (stub) await new Promise(done => { stub.close(done); stub.closeAllConnections(); });
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps, requests, featurePushes, includingCleanup: pushes,
    boundary: "Actual compiled API to owned sidecar stub; no real Neo4j, model, browser or authenticated database probe", serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Memory credential destination: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
