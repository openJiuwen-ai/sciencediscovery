// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: manually change global Reviewer Specialist participation without changing session review preferences or feedback policy.
 * Steps: committed owned stack; blank/refusal; enable/replay; refuse disable; stale formal policy edit; disable; optional browser.
 * Environment: actual compiled Native product, fresh owned data and ephemeral loopback API port.
 * Type: public settings API/card only; no LLM, external service, Runner execution or paid review.
 * Credentials: generated owned API token excluded from logs/reports.
 * CostSideEffects: exact owned settings restored and Project deleted; owned browser/server stopped.
 * Run: E2E_REVIEWER_GLOBAL_ISOLATED=1 node test/api/configuration-reviewer-global.mjs
 * Browser: E2E_REVIEWER_GLOBAL_BROWSER=1 with repository-pinned .e2e Chromium/cache, new empty context.
 * Boundaries: API/card persistence and concurrent approval only; real queue-admission coverage is a separate integration test.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const directory = resolve(".tmp", `reviewer-global-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-api-${randomUUID()}`;
const steps = [], requests = []; let outcome = "BLOCKED", sha, origin, product, project, session, baseline, sessionBefore, logs = "";
let browser, browserContext;
const browserRequested = process.env.E2E_REVIEWER_GLOBAL_BROWSER === "1";
class Blocked extends Error {}
const redact = value => String(value).replaceAll(token, "[owned-token]");
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
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "reviewer.enable", values });
const preview = (card, values, option = "persist") => api(path(card, "preview"), { expectedRevision: card.revision, values, selectedOptionId: option }, "POST", 200);
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
const formal = () => api("/api/reviewer-specialist/settings");
const preferences = () => api(`/api/sessions/${session.id}/reviewer-specialist/settings`);
try {
  await step("1. Start the immutable isolated product and a fresh configuration baseline", async () => {
    if (process.env.E2E_REVIEWER_GLOBAL_ISOLATED !== "1") throw new Blocked("Explicit isolated startup is required");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before testing");
    const reservation = createServer(); const port = await listen(reservation); await new Promise(done => reservation.close(done));
    origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native",
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[name] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) stream.on("data", data => { logs += redact(data); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Owned product exited during startup");
      try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned product did not become ready");
    baseline = await formal();
    await api("/api/reviewer-specialist/settings", { enabled: false, feedbackPolicy: "record" }, "PUT", 200);
    project = await api("/api/projects", { name: `Reviewer global ${randomUUID()}` }); session = await api(`/api/projects/${project.id}/sessions`, { title: "Global Reviewer participation" }); sessionBefore = await preferences();
  });
  outcome = "FAIL";
  await step("2. A blank/refused global switch proposal does not alter settings", async () => {
    assert.equal((await formal()).enabled, false); let card = await propose({}); assert.equal(card.state, "collecting_input");
    card = await preview(card, {}, "dismiss"); assert.equal((await decide(card, "dismiss")).state, "dismissed");
    assert.equal((await formal()).enabled, false);
  });
  await step("3. Manual enable and replay preserve feedback and session review preferences", async () => {
    const before = await formal(), card = await propose({ enabled: true });
    assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined); assert.equal(card.verificationPlan.maxRequests, 0);
    const result = await decide(card); assert.equal(result.state, "applied");
    assert.equal(result.activation.mode, "next_request"); assert.equal(result.activation.state, "needs_user_action");
    assert.equal(result.resumption.state, "not_requested"); assert.equal((await decide(card)).state, "applied");
    assert.deepEqual(await formal(), { ...before, enabled: true }); assert.deepEqual(await preferences(), sessionBefore);
  });
  await step("4. Refusing disable preserves the global enabled value", async () => {
    let card = await propose({ enabled: false }); card = await preview(card, {}, "dismiss"); await decide(card, "dismiss");
    assert.equal((await formal()).enabled, true);
  });
  await step("5. A concurrent formal feedback-policy edit fences an old switch approval", async () => {
    const card = await propose({ enabled: false }); await api("/api/reviewer-specialist/settings", { enabled: true, feedbackPolicy: "explain" }, "PUT", 200);
    const result = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision: "apply" }, "POST", 409);
    assert.equal(result.code, "RESOURCE_VERSION_CONFLICT"); assert.equal((await formal()).enabled, true);
    const refreshed = await preview(card, { enabled: false }); assert.equal((await decide(refreshed)).state, "applied");
  });
  await step("6. Disable preserves the independent global feedback policy and session preferences", async () => {
    assert.deepEqual(await formal(), { enabled: false, feedbackPolicy: "explain" }); assert.deepEqual(await preferences(), sessionBefore);
    assert.equal((await api(path())).filter(card => card.state === "applied").length, 2);
  });
  if (browserRequested) await step("7. Inspect and manually confirm the actual global Reviewer card in an isolated browser", async () => {
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
      await page.screenshot({ path: resolve(directory, `reviewer-card-${viewport.width}x${viewport.height}.png`), fullPage: true, animations: "disabled", caret: "hide" });
      assert.equal(state.reachable, true, JSON.stringify(state)); assert.equal(await checkbox.isChecked(), false);
    }
    await checkbox.check(); await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const confirm = panel.getByRole("button", { name: "Confirm choice and continue", exact: true });
    await confirm.click();
    const deadline = Date.now() + 5000; let saved;
    do { saved = await formal(); if (saved.enabled) break; await new Promise(done => setTimeout(done, 100)); } while (Date.now() < deadline);
    assert.equal(saved.enabled, true); assert.equal(saved.feedbackPolicy, "explain"); assert.deepEqual(await preferences(), sessionBefore);
    const savedRecord = page.locator(".conversation-configuration-record").filter({ hasText: "Configure global Reviewer Specialist" }).last();
    const summary = savedRecord.locator("summary").first(); await summary.scrollIntoViewIfNeeded();
    assert.match(await summary.innerText(), /Saved/);
    await summary.click(); await savedRecord.getByText("Saved", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, "reviewer-saved.png"), fullPage: true, animations: "disabled", caret: "hide" });
  });
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  await browserContext?.close(); await browser?.close();
  try {
    if (baseline) await api("/api/reviewer-specialist/settings", { enabled: baseline.enabled, feedbackPolicy: baseline.feedbackPolicy }, "PUT", 200);
    if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200);
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned fixtures", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, startup: "node services/api/dist/server.js; fresh owned data/ephemeral loopback port/native; no model or review executed", steps, requests,
    browser: browserRequested ? "Pinned Chromium; new empty context; 1280x800/900x650/390x844 DPR1; only owned HTTP origin allowed" : "not exercised", realLLM: false, actualReviewExecution: "not exercised by this driver; separate coordinator integration coverage", serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Global Reviewer participation: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
