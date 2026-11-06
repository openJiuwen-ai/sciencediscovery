// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: manually select the workbench MemoryGraph backend while preserving participation/credentials and reporting activation honestly.
 * Steps: own committed API/stub; blank/refusal; manual backend save; existing GET self-heal; stale formal edit; explicit return to local; optional browser.
 * Environment: actual compiled Native product with fresh owned data and ephemeral loopback ports.
 * Type: owned MemoryGraph HTTP stub; no real database, LLM, external connection or paid services.
 * Credentials: synthetic owned API/sidecar tokens only; excluded from logs/reports.
 * CostSideEffects: exact owned fixtures restored/deleted, owned process/stub/browser closed; no graph migration/deletion/restart.
 * Run: E2E_MEMORY_BACKEND_ISOLATED=1 node test/api/configuration-memory-backend.mjs
 * Browser: E2E_MEMORY_BACKEND_BROWSER=1 with repository-pinned .e2e Chromium/cache and a fresh context.
 * Boundaries: saved choice differs from sidecar activation; existing GET may reconcile Neo4j, local requires startup/operator action.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const directory = resolve(".tmp", `memory-backend-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-api-${randomUUID()}`, graphToken = `owned-graph-${randomUUID()}`;
const steps = [], requests = []; let outcome = "BLOCKED", sha, origin, product, stub, project, session, baseline, graphQueries = 0, graphDeletes = 0, featureGraphQueries, featureGraphDeletes, logs = "";
let browser, browserContext; let sidecarBackend = "local", backendPushes = 0, featureBackend, featureBackendPushes;
const browserRequested = process.env.E2E_MEMORY_BACKEND_BROWSER === "1";
class Blocked extends Error {}
const redact = value => [token, graphToken].reduce((text, secret) => text.replaceAll(secret, "[owned-token]"), String(value));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
async function listen(server) { await new Promise(done => server.listen(0, "127.0.0.1", done)); return server.address().port; }
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15000), redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code });
  assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error.message) }); throw error; }
}
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "memory.backend", values });
const preview = (card, values, option = "persist") => api(path(card, "preview"), { expectedRevision: card.revision, values, selectedOptionId: option }, "POST", 200);
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
const formal = () => api("/api/memory/settings");
try {
  await step("1. Start the immutable isolated product and an owned MemoryGraph HTTP stub", async () => {
    if (process.env.E2E_MEMORY_BACKEND_ISOLATED !== "1") throw new Blocked("Explicit isolated startup is required");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before testing");
    stub = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      let body = ""; for await (const part of request) body += part;
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/health") return response.end(JSON.stringify({ status: "healthy", backend: sidecarBackend }));
      if (request.headers.authorization !== `Bearer ${graphToken}`) { response.statusCode = 401; return response.end("{}"); }
      if (url.pathname === "/internal/backend") { sidecarBackend = JSON.parse(body).backend; backendPushes++; }
      if (request.method === "DELETE") graphDeletes++;
      if (url.pathname === "/subgraph") { graphQueries++; return response.end(JSON.stringify({ nodes: [], edges: [], total: 0, truncated: false })); }
      return response.end(JSON.stringify({ ok: true }));
    });
    const graphPort = await listen(stub), reservation = createServer(); const port = await listen(reservation); await new Promise(done => reservation.close(done));
    origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native",
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "1", SCIENCE_AGENT_MEMORY_GRAPH_URL: `http://127.0.0.1:${graphPort}`, SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN: graphToken, SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[name] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) stream.on("data", data => { logs += redact(data); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Owned product exited during startup");
      try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned product did not become ready");
    baseline = await formal(); if (baseline.hasNeo4jPassword) throw new Blocked("Use fresh data without real credentials");
    await api("/api/memory/settings", { enabled: true, backend: "local" }, "PUT", 200);
    project = await api("/api/projects", { name: `Memory backend ${randomUUID()}` }); session = await api(`/api/projects/${project.id}/sessions`, { title: "Memory backend selection" });
  });
  outcome = "FAIL";
  await step("2. Blank/refused backend proposals preserve the configured local graph", async () => {
    assert.equal((await formal()).backend, "local");
    let card = await propose({}); assert.equal(card.state, "collecting_input");
    card = await preview(card, {}, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
    assert.equal((await formal()).backend, "local");
  });
  await step("3. Manual Neo4j selection saves only the backend; settings self-heal is a later distinct action", async () => {
    const before = await formal(), controls = backendPushes, card = await propose({ backend: "neo4j" });
    assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0);
    const result = await decide(card); assert.equal(result.state, "applied");
    assert.equal(result.activation.mode, "requires_restart"); assert.equal(result.activation.state, "needs_user_action");
    assert.equal((await decide(card)).state, "applied"); assert.equal(backendPushes, controls); assert.equal(sidecarBackend, "local");
    const saved = await formal(); assert.equal(saved.backend, "neo4j"); assert.equal(saved.enabled, before.enabled);
    assert.equal(saved.neo4jHttp, before.neo4jHttp); assert.equal(saved.neo4jUser, before.neo4jUser); assert.equal(saved.hasNeo4jPassword, false);
    assert.equal(sidecarBackend, "neo4j"); assert.equal(backendPushes, controls + 1);
  });
  await step("4. Refusing return to local leaves Neo4j selected", async () => {
    let card = await propose({ backend: "local" }); card = await preview(card, {}, "dismiss"); await decide(card, "dismiss");
    assert.equal((await formal()).backend, "neo4j");
  });
  await step("5. A concurrent formal connection edit fences approval; refresh permits an explicit local selection", async () => {
    const card = await propose({ backend: "local" }); await api("/api/memory/settings", { neo4jUser: "concurrent-owned-user" }, "PUT", 200);
    const rejected = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision: "apply" }, "POST", 409);
    assert.equal(rejected.code, "RESOURCE_VERSION_CONFLICT"); assert.equal((await formal()).backend, "neo4j");
    const refreshed = await preview(card, { backend: "local" }), controls = backendPushes;
    assert.equal((await decide(refreshed)).state, "applied"); assert.equal(backendPushes, controls);
  });
  await step("6. Saved local selection does not falsely report a changed live sidecar or delete graph data", async () => {
    const saved = await formal(); assert.equal(saved.backend, "local"); assert.equal(saved.enabled, true);
    assert.equal(saved.neo4jUser, "concurrent-owned-user"); assert.equal(saved.hasNeo4jPassword, false);
    assert.equal(sidecarBackend, "neo4j"); assert.equal(graphDeletes, 0);
  });
  if (browserRequested) await step("7. Inspect and manually confirm the actual Memory backend card in an isolated browser", async () => {
    execFileSync(process.execPath, ["test/sync-e2e.mjs", "--check"]);
    const { chromium } = createRequire(resolve(".e2e/package.json"))("@playwright/test");
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await browserContext.route("**/*", route => {
      const url = new URL(route.request().url());
      return ["http:", "https:"].includes(url.protocol) && url.origin !== origin ? route.abort() : route.continue();
    });
    await browserContext.addInitScript(({ token, origin }) => { if (location.origin === origin) {
      localStorage.setItem("sciencediscovery-token", token); localStorage.setItem("sciencediscovery-locale", "en");
    } }, { token, origin });
    const card = await propose({}), page = await browserContext.newPage();
    await page.goto(`${origin}/projects/${project.id}/sessions/${session.id}`, { waitUntil: "domcontentloaded" });
    const panel = page.locator(`#configuration-request-${card.id}`); await panel.waitFor({ state: "visible" });
    const selector = panel.locator('select[name="backend"]');
    for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 650 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await selector.scrollIntoViewIfNeeded();
      const state = await selector.evaluate(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2), rounding = 1 / devicePixelRatio;
        return { reachable: box.x >= -rounding && box.right <= innerWidth + rounding && box.y >= -rounding && box.bottom <= innerHeight + rounding && (hit === element || element.contains(hit)),
          box: { x: box.x, y: box.y, width: box.width, height: box.height }, hit: hit?.className };
      });
      await page.screenshot({ path: resolve(directory, `memory-card-${viewport.width}x${viewport.height}.png`), fullPage: true, animations: "disabled", caret: "hide" });
      assert.equal(state.reachable, true, JSON.stringify(state)); assert.equal(await selector.inputValue(), "local");
    }
    await selector.selectOption("neo4j"); await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const confirm = panel.getByRole("button", { name: "Confirm choice and continue", exact: true });
    await confirm.click();
    const deadline = Date.now() + 5000; let saved;
    do { saved = await formal(); if (saved.backend === "neo4j") break; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
    assert.equal(saved.enabled, true); assert.equal(saved.backend, "neo4j");
    const savedRecord = page.locator(".conversation-configuration-record").filter({ hasText: "Choose memory graph backend" }).last();
    const summary = savedRecord.locator("summary").first(); await summary.scrollIntoViewIfNeeded();
    assert.match(await summary.innerText(), /Saved/);
    await summary.click(); await savedRecord.getByText("Saved", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, "memory-saved.png"), fullPage: true, animations: "disabled", caret: "hide" });
  });
  featureGraphQueries = graphQueries; featureGraphDeletes = graphDeletes; featureBackend = sidecarBackend; featureBackendPushes = backendPushes; outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  await browserContext?.close(); await browser?.close();
  try {
    if (baseline) await api("/api/memory/settings", { enabled: baseline.enabled, backend: baseline.backend, neo4jHttp: baseline.neo4jHttp, neo4jUser: baseline.neo4jUser }, "PUT", 200);
    if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned fixtures", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (stub) await new Promise(done => { stub.close(done); stub.closeAllConnections(); });
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, startup: "node services/api/dist/server.js; fresh owned data/ephemeral loopback ports/native; owned MemoryGraph HTTP stub", steps, requests,
    featurePhase: { graphQueries: featureGraphQueries, graphDeletes: featureGraphDeletes, sidecarBackend: featureBackend, backendPushes: featureBackendPushes }, includingOwnedCleanup: { graphQueries, graphDeletes, sidecarBackend, backendPushes },
    browser: browserRequested ? "Pinned Chromium; new empty context; 1280x800/900x650/390x844 DPR1; only owned HTTP origin allowed" : "not exercised", realDatabase: false, realLLM: false, serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Memory backend selection: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
