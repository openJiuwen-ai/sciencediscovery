// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: enable/disable workbench MemoryGraph through user confirmation and observe the actual subsequent-query gate.
 * Steps: own committed stack/stub; blank/refused card; enable and query; refuse disable; stale formal edit; disable and query.
 * Environment: actual compiled Native product with fresh data and two owned ephemeral loopback ports.
 * Type: owned MemoryGraph HTTP stub only; no LLM, real database, external Web, Runner or paid service.
 * Credentials: generated synthetic API/sidecar tokens, excluded from reports/logs.
 * CostSideEffects: only owned Memory settings/Project, restored in finally; owned server and stub closed.
 * Run: E2E_MEMORY_TOGGLE_ISOLATED=1 node test/api/configuration-memory-toggle.mjs
 * This proves the public API gate, not real Neo4j persistence/readiness, browser interaction or model-language selection.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const directory = resolve(".tmp", `memory-toggle-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-api-${randomUUID()}`, graphToken = `owned-graph-${randomUUID()}`;
const steps = [], requests = []; let outcome = "BLOCKED", sha, origin, product, stub, project, session, baseline, graphQueries = 0, graphDeletes = 0, featureGraphQueries, featureGraphDeletes, logs = "";
let browser, browserContext;
const browserRequested = process.env.E2E_MEMORY_TOGGLE_BROWSER === "1";
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
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "memory.enable", values });
const preview = (card, values, option = "persist") => api(path(card, "preview"), { expectedRevision: card.revision, values, selectedOptionId: option }, "POST", 200);
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
const formal = () => api("/api/memory/settings");
const query = () => api(`/api/memory/subgraph?session_id=${session.id}`);
try {
  await step("1. Start the immutable isolated product and an owned MemoryGraph HTTP stub", async () => {
    if (process.env.E2E_MEMORY_TOGGLE_ISOLATED !== "1") throw new Blocked("Explicit isolated startup is required");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before testing");
    stub = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      for await (const _part of request) { /* Drain only owned fixture control bodies. */ }
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/health") return response.end(JSON.stringify({ status: "healthy", backend: "local" }));
      if (request.headers.authorization !== `Bearer ${graphToken}`) { response.statusCode = 401; return response.end("{}"); }
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
    await api("/api/memory/settings", { enabled: false }, "PUT", 200);
    project = await api("/api/projects", { name: `Memory toggle ${randomUUID()}` }); session = await api(`/api/projects/${project.id}/sessions`, { title: "Memory participation" });
  });
  outcome = "FAIL";
  await step("2. An unsaved/refused card leaves the disabled graph query gate closed", async () => {
    const before = graphQueries; assert.equal((await query()).reason, "memory_graph_disabled"); assert.equal(graphQueries, before);
    let card = await propose({}); assert.equal(card.state, "collecting_input"); assert.equal((await formal()).enabled, false);
    card = await preview(card, {}, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
    assert.equal((await formal()).enabled, false);
  });
  await step("3. Manual enable permits the next public graph query without changing backend or retrying existing work", async () => {
    const settings = await formal(), before = graphQueries, card = await propose({ enabled: true });
    assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0);
    assert.equal(graphQueries, before); const result = await decide(card); assert.equal(result.state, "applied");
    assert.equal(result.activation.mode, "next_request"); assert.equal(result.activation.state, "needs_user_action");
    assert.equal((await decide(card)).state, "applied"); assert.equal(graphQueries, before);
    const saved = await formal(); assert.equal(saved.enabled, true); assert.equal(saved.backend, settings.backend); assert.equal(saved.neo4jHttp, settings.neo4jHttp); assert.equal(saved.neo4jUser, settings.neo4jUser);
    assert.equal((await query()).reason, undefined); assert.equal(graphQueries, before + 1);
  });
  await step("4. Refusing disable preserves participation and the next query still reaches the same stub", async () => {
    let card = await propose({ enabled: false }); card = await preview(card, {}, "dismiss"); await decide(card, "dismiss");
    const before = graphQueries; assert.equal((await query()).reason, undefined); assert.equal(graphQueries, before + 1);
  });
  await step("5. A concurrent formal connection edit fences an old disable approval", async () => {
    const card = await propose({ enabled: false }); await api("/api/memory/settings", { neo4jUser: "concurrent-owned-user" }, "PUT", 200);
    const result = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision: "apply" }, "POST", 409);
    assert.equal(result.code, "RESOURCE_VERSION_CONFLICT"); assert.equal((await formal()).enabled, true);
    const refreshed = await preview(card, { enabled: false }); assert.equal((await decide(refreshed)).state, "applied");
  });
  await step("6. Subsequent disabled queries stop reaching the stub; no graph deletion is issued", async () => {
    const before = graphQueries; assert.equal((await query()).reason, "memory_graph_disabled"); assert.equal(graphQueries, before); assert.equal(graphDeletes, 0);
    const saved = await formal(); assert.equal(saved.enabled, false); assert.equal(saved.hasNeo4jPassword, baseline.hasNeo4jPassword);
  });
  if (browserRequested) await step("7. Inspect and manually confirm the actual Memory card in an isolated browser", async () => {
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
    const checkbox = panel.locator('input[type="checkbox"]');
    for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 650 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await checkbox.scrollIntoViewIfNeeded();
      const state = await checkbox.evaluate(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2), rounding = 1 / devicePixelRatio;
        return { reachable: box.x >= -rounding && box.right <= innerWidth + rounding && box.y >= -rounding && box.bottom <= innerHeight + rounding && (hit === element || element.contains(hit)),
          box: { x: box.x, y: box.y, width: box.width, height: box.height }, hit: hit?.className };
      });
      await page.screenshot({ path: resolve(directory, `memory-card-${viewport.width}x${viewport.height}.png`), fullPage: true, animations: "disabled", caret: "hide" });
      assert.equal(state.reachable, true, JSON.stringify(state)); assert.equal(await checkbox.isChecked(), false);
    }
    await checkbox.check(); await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const confirm = panel.getByRole("button", { name: "Confirm choice and continue", exact: true });
    await confirm.click();
    const deadline = Date.now() + 5000; let saved;
    do { saved = await formal(); if (saved.enabled) break; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
    assert.equal(saved.enabled, true); assert.equal(saved.backend, baseline.backend);
    await page.screenshot({ path: resolve(directory, "memory-saved.png"), fullPage: true, animations: "disabled", caret: "hide" });
  });
  featureGraphQueries = graphQueries; featureGraphDeletes = graphDeletes; outcome = "PASS";
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
    featurePhase: { graphQueries: featureGraphQueries, graphDeletes: featureGraphDeletes }, includingOwnedCleanup: { graphQueries, graphDeletes },
    browser: browserRequested ? "Pinned Chromium; new empty context; 1280x800/900x650/390x844 DPR1; only owned HTTP origin allowed" : "not exercised", realDatabase: false, realLLM: false, serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Memory participation: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
