// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: save a Neo4j root origin/account only after separate recipient approval, preserving existing credentials.
 * Steps: committed owned API/stub; reject password/approval bypass; confirm connection; refuse; concurrent password-presence change; self-heal; optional browser.
 * Environment: actual compiled Native product, fresh owned data/two ephemeral loopback ports, optional pinned Chromium/new context.
 * Type: owned MemoryGraph control stub only; no real database, model, Runner execution or paid service.
 * Credentials: synthetic owned API/sidecar and existing-password fixtures; evidence uses slots/booleans only, logs redacted.
 * CostSideEffects: own settings restored, exact own Project deleted, owned process/browser/stub stopped.
 * Run: E2E_NEO4J_CONNECTION_ISOLATED=1 node test/api/configuration-neo4j-connection.mjs
 * Browser: E2E_NEO4J_CONNECTION_BROWSER=1 with repository-pinned .e2e Chromium/cache.
 * Boundary: saved metadata and subsequent control payloads, not real Neo4j authentication or verified sidecar mirroring.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `neo4j-connection-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-api-${randomUUID()}`, graphToken = `owned-sidecar-${randomUUID()}`;
const passwords = [0, 1].map(() => `synthetic-neo4j-${randomUUID()}`);
const redact = value => [token, graphToken, ...passwords].reduce((text, secret) => text.replaceAll(secret, "[owned-secret]"), String(value));
const initialOrigin = "https://initial-owned.invalid:7474", browserOrigin = "http://127.0.0.1:1";
const accounts = ["owned-user", "approved-user", "next-owned-user", "browser-owned-user"];
const steps = [], requests = [], credentialPushes = [], browserUploads = [], ordinaryLeaks = [];
let outcome = "BLOCKED", sha, origin, graphOrigin, product, stub, project, session, baseline, browser, context, logs = "", graphBackend = "local", runtimeSlot = "cleared", featurePushes;
class Blocked extends Error {}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
async function listen(server) { await new Promise(done => server.listen(0, "127.0.0.1", done)); return server.address().port; }
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code });
  assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`);
  assert.ok(passwords.every(secret => !JSON.stringify(value).includes(secret)), "A password escaped into a public response"); return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error.message) }); throw error; }
}
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "memory.connection", values });
const formal = () => api("/api/memory/settings");
const preview = (card, values, extra = {}) => api(path(card, "preview"), { expectedRevision: card.revision, values, selectedOptionId: "persist", ...extra }, "POST", 200);
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
const consent = card => api(path(card, "endpoint-consent"), { revision: card.revision, endpointTarget: card.endpointAuthorization.endpointTarget }, "POST", 200);
try {
  await step("1. Start the immutable product with an owned sidecar stub and fresh settings/session", async () => {
    if (process.env.E2E_NEO4J_CONNECTION_ISOLATED !== "1") throw new Blocked("Explicit owned isolation is required");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before testing");
    stub = createServer(async (request, response) => {
      let raw = ""; for await (const part of request) raw += part;
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") return response.end(JSON.stringify({ status: "degraded", backend: graphBackend }));
      if (request.headers.authorization !== `Bearer ${graphToken}`) { response.statusCode = 401; return response.end("{}"); }
      const body = JSON.parse(raw || "{}");
      if (request.url?.startsWith("/subgraph")) return response.end(JSON.stringify({ nodes: [], edges: [], total: 0, truncated: false }));
      if (request.url === "/internal/backend") graphBackend = body.backend;
      if (request.url === "/internal/neo4j-password") {
        runtimeSlot = body.password === null ? "cleared" : String(passwords.indexOf(body.password));
        credentialPushes.push({ slot: runtimeSlot, originSlot: body.http_uri === initialOrigin ? "initial" : body.http_uri === graphOrigin ? "saved" : body.http_uri === browserOrigin ? "browser" : "other", accountSlot: accounts.indexOf(body.user) });
      }
      return response.end(JSON.stringify({ ok: true }));
    });
    graphOrigin = `http://127.0.0.1:${await listen(stub)}`;
    const reservation = createServer(), port = await listen(reservation); await new Promise(done => reservation.close(done)); origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native",
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "1", SCIENCE_AGENT_MEMORY_GRAPH_URL: graphOrigin, SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN: graphToken, SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[name] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) stream.on("data", data => { logs += redact(data); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Owned product exited during startup");
      try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned product did not become ready");
    baseline = await formal(); if (baseline.hasNeo4jPassword) throw new Blocked("Fresh owned data must not contain real credentials");
    await api("/api/memory/settings", { enabled: false, backend: "neo4j", neo4jHttp: initialOrigin, neo4jUser: accounts[0], neo4jPassword: passwords[0] }, "PUT", 200);
    project = await api("/api/projects", { name: `Neo4j connection ${randomUUID()}` }); session = await api(`/api/projects/${project.id}/sessions`, { title: "Owned approved connection" });
  });
  outcome = "FAIL"; let card;
  const change = () => ({ neo4jHttp: graphOrigin, neo4jUser: accounts[1] });
  await step("2. Ordinary password fields and an unapproved connection save are rejected", async () => {
    const invalid = await api(path(), { protocolVersion: 3, capabilityId: "memory.connection", values: { neo4jPassword: passwords[0] } }, "POST", 400);
    assert.equal(invalid.code, "INVALID_CONFIGURATION_INPUT"); card = await propose(change());
    assert.equal(card.endpointAuthorization.status, "required"); assert.equal(card.fields.some(field => field.kind === "credential"), false);
    const before = await formal(), pushes = credentialPushes.length;
    assert.notEqual((await decide(card)).state, "applied"); assert.deepEqual(await formal(), before); assert.equal(credentialPushes.length, pushes);
  });
  await step("3. Separate recipient consent and manual confirmation preserve password/backend/participation", async () => {
    card = await preview(card, change()); card = await consent(card); const before = await formal(), pushes = credentialPushes.length;
    const saved = await decide(card); assert.equal(saved.state, "applied"); assert.equal(saved.activation.mode, "requires_restart"); assert.equal(saved.activation.state, "needs_user_action");
    assert.equal((await decide(card)).state, "applied"); assert.equal(credentialPushes.length, pushes);
    assert.deepEqual(await formal(), { ...before, neo4jHttp: graphOrigin, neo4jUser: accounts[1] });
  });
  await step("4. Refusing another account proposal preserves the approved connection", async () => {
    let refused = await propose({ neo4jUser: "declined-owned-user" }); refused = await preview(refused, {}, { selectedOptionId: "dismiss" });
    assert.equal((await decide(refused, "dismiss")).state, "dismissed"); assert.equal((await formal()).neo4jUser, accounts[1]);
  });
  await step("5. A password added during the wait invalidates the old save and requires new recipient approval", async () => {
    await api("/api/memory/settings", { neo4jPassword: null }, "PUT", 200);
    card = await consent(await propose({ neo4jUser: accounts[2] }));
    await api("/api/memory/settings", { neo4jPassword: passwords[1] }, "PUT", 200);
    const stale = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision: "apply" }, "POST", 409);
    assert.equal(stale.code, "RESOURCE_VERSION_CONFLICT"); card = await preview(card, { neo4jUser: accounts[2] });
    assert.equal(card.endpointAuthorization.status, "required"); assert.match(card.impact.message, /password is already stored/);
    card = await consent(card); assert.equal((await decide(card)).state, "applied");
  });
  await step("6. Existing settings self-heal reuses the stored password at the newly approved account", async () => {
    await api("/api/memory/settings", { enabled: true }, "PUT", 200); const before = credentialPushes.length, saved = await formal();
    assert.equal(saved.hasNeo4jPassword, true); assert.equal(credentialPushes.length, before + 1);
    assert.deepEqual(credentialPushes.at(-1), { slot: "1", originSlot: "saved", accountSlot: 2 });
  });
  if (process.env.E2E_NEO4J_CONNECTION_BROWSER === "1") await step("7. A new isolated browser edits origin/account, separately approves their recipient and saves", async () => {
    execFileSync(process.execPath, ["test/sync-e2e.mjs", "--check"]);
    const { chromium } = createRequire(resolve(".e2e/package.json"))("@playwright/test"); browser = await chromium.launch({ headless: true, channel: "chromium" });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => { const url = new URL(route.request().url()); return ["http:", "https:"].includes(url.protocol) && url.origin !== origin ? route.abort() : route.continue(); });
    await context.addInitScript(({ token, origin }) => { if (location.origin === origin) { localStorage.setItem("sciencediscovery-token", token); localStorage.setItem("sciencediscovery-locale", "en"); } }, { token, origin });
    card = await propose({}); const page = await context.newPage();
    page.on("request", request => {
      const url = new URL(request.url()); if (url.origin !== origin || request.method() !== "POST") return;
      try { const body = request.postDataJSON();
        if (url.pathname.endsWith("/credentials")) browserUploads.push({ unexpected: true });
        if (passwords.some(secret => JSON.stringify(body).includes(secret))) ordinaryLeaks.push(true);
      } catch { /* No JSON body contains no candidate secret. */ }
    });
    await page.goto(origin + "/projects/" + project.id + "/sessions/" + session.id, { waitUntil: "domcontentloaded" });
    const panel = page.locator("#configuration-request-" + card.id); await panel.waitFor({ state: "visible" });
    assert.equal(await panel.locator('input[type="password"]').count(), 0);
    await panel.locator('input[name="neo4jHttp"]').fill(browserOrigin); await panel.locator('input[name="neo4jUser"]').fill(accounts[3]);
    assert.equal(await panel.getByRole("button", { name: "Allow this exact endpoint", exact: true }).count(), 0);
    await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const allow = panel.getByRole("button", { name: "Allow this exact endpoint", exact: true }); await allow.waitFor({ state: "visible" }); await allow.click();
    for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 650 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const field of ["neo4jHttp", "neo4jUser"]) {
        const control = panel.locator('input[name="' + field + '"]'); await control.scrollIntoViewIfNeeded();
        const inspect = () => control.evaluate(element => { const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2), rounding = 1 / devicePixelRatio;
          return { reachable: box.x >= -rounding && box.right <= innerWidth + rounding && box.y >= -rounding && box.bottom <= innerHeight + rounding && (hit === element || element.contains(hit)),
            field: element.getAttribute("name"), box: { x: box.x, y: box.y, width: box.width, height: box.height }, hit: { tag: hit?.tagName, className: hit?.className } }; });
        let state = await inspect(); const deadline = Date.now() + 2000;
        while (!state.reachable && Date.now() < deadline) { await page.waitForTimeout(100); state = await inspect(); }
        await page.screenshot({ path: resolve(directory, "neo4j-connection-" + field + "-" + viewport.width + "x" + viewport.height + ".png"), fullPage: true, animations: "disabled", caret: "hide" });
        assert.equal(state.reachable, true, JSON.stringify(state));
      }
    }
    await panel.getByRole("button", { name: "Confirm choice and continue", exact: true }).click();
    const deadline = Date.now() + 5000; let saved;
    do { saved = await formal(); if (saved.neo4jHttp === browserOrigin && saved.neo4jUser === accounts[3]) break; await page.waitForTimeout(100); } while (Date.now() < deadline);
    assert.equal(saved.neo4jHttp, browserOrigin); assert.equal(saved.neo4jUser, accounts[3]); assert.equal(saved.hasNeo4jPassword, true);
    assert.equal(ordinaryLeaks.length, 0); assert.equal(browserUploads.length, 0);
    assert.deepEqual(credentialPushes.at(-1), { slot: "1", originSlot: "browser", accountSlot: 3 });
    await panel.waitFor({ state: "detached" });
    const record = page.locator(".conversation-configuration-record").filter({ hasText: "Configure Neo4j connection" }).last(), summary = record.locator("summary").first();
    assert.match(await summary.innerText(), /Saved/); await summary.click(); await record.getByText("Saved", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, "neo4j-connection-saved.png"), fullPage: true, animations: "disabled", caret: "hide" });
  });
  featurePushes = structuredClone(credentialPushes); outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close();
  try { if (baseline) await api("/api/memory/settings", { enabled: baseline.enabled, backend: baseline.backend, neo4jHttp: baseline.neo4jHttp, neo4jUser: baseline.neo4jUser, neo4jPassword: null }, "PUT", 200);
    if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned fixtures", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (stub) await new Promise(done => { stub.close(done); stub.closeAllConnections(); });
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps, requests, featurePushes, includingOwnedCleanup: credentialPushes, browserUploads, ordinaryLeaks,
    browser: context ? "Pinned Chromium attempted; see step7 outcome; new context/only owned origin;1280x800,900x650,390x844 DPR1" : "not exercised",
    boundary: "Owned MemoryGraph control stub, no real Neo4j/model/authentication or verified sidecar mirror", serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Neo4j connection: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
