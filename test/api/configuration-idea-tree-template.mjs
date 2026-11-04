// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: change the registered Idea Tree template through a manually reviewed proposal.
 * Steps: owned compiled product; finite input/preview; apply/replay; refuse; concurrent formal change; optional browser.
 * Environment: fresh isolated data and ephemeral loopback API port, Native product, unavailable Runner/MemoryGraph.
 * Type: no model or external service; no research, packages or paid calls.
 * Credentials: generated owned API token only, redacted from evidence.
 * CostSideEffects: restore own settings, delete exact owned Project, stop own process/browser.
 * Run: E2E_IDEA_TEMPLATE_ISOLATED=1 node test/api/configuration-idea-tree-template.mjs
 * Browser: E2E_IDEA_TEMPLATE_BROWSER=1, pinned .e2e Playwright/Chromium.
 * Boundary: saved template, not actual scientific research quality or real model injection.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `idea-template-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-${randomUUID()}`, steps = [], requests = [];
let outcome = "BLOCKED", sha, origin, product, project, session, baseline, browser, context, logs = "";
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code }); assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, work) { try { await work(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error.message).replaceAll(token, "[owned-token]") }); throw error; } }
const formal = () => api("/api/settings/idea-tree");
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "idea_tree.configure", values });
const decide = (card, decision = "apply") => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", 200);
try {
  await step("1. Start a clean committed product with an owned Project and Session", async () => {
    if (process.env.E2E_IDEA_TEMPLATE_ISOLATED !== "1") throw new Blocked("Explicit owned isolation required");
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Blocked("Commit candidate first");
    const reservation = createServer(); await new Promise(done => reservation.listen(0, "127.0.0.1", done)); const port = reservation.address().port; await new Promise(done => reservation.close(done)); origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[key] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) stream.on("data", data => { logs += String(data).replaceAll(token, "[owned-token]"); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Product exited"); try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned API did not become ready"); baseline = await formal();
    project = await api("/api/projects", { name: `Idea template ${randomUUID()}` }); session = await api(`/api/projects/${project.id}/sessions`, { title: "Owned template proposal" });
  });
  outcome = "FAIL"; let card;
  await step("2. Reject arbitrary templates; preview a finite change without writing settings", async () => {
    assert.equal((await api(path(), { protocolVersion: 3, capabilityId: "idea_tree.configure", values: { templateId: "custom/arbitrary" } }, "POST", 400)).code, "INVALID_CONFIGURATION_INPUT");
    card = await propose({ templateId: "water-treatment-materials/v1" }); assert.equal(card.scope.kind, "global"); assert.equal(card.autoApplyAt, undefined);
    const field = card.fields.find(field => field.id === "templateId"); assert.equal(field.kind, "enum"); assert.equal(field.choices.length, 2); assert.deepEqual(await formal(), baseline);
  });
  await step("3. Manually confirm and replay once, preserving all other Idea Tree settings", async () => {
    assert.equal((await decide(card)).state, "applied"); assert.equal((await decide(card)).state, "applied"); assert.deepEqual(await formal(), { ...baseline, templateId: "water-treatment-materials/v1" });
  });
  await step("4. Refuse another template choice without reverting the saved template", async () => {
    let refused = await propose({ templateId: "scientific-hypothesis-general/v1" }); refused = await api(path(refused, "preview"), { expectedRevision: refused.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200);
    assert.equal((await decide(refused, "dismiss")).state, "dismissed"); assert.equal((await formal()).templateId, "water-treatment-materials/v1");
  });
  await step("5. A concurrent formal change blocks the stale template approval", async () => {
    card = await propose({ templateId: "scientific-hypothesis-general/v1" }); await api("/api/settings/idea-tree", { explorationIntensity: "deep" }, "PUT", 200);
    const stale = await api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision: "apply" }, "POST", 409); assert.equal(stale.code, "RESOURCE_VERSION_CONFLICT");
    card = await api(path(card, "preview"), { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200); await decide(card, "dismiss");
    assert.equal((await formal()).templateId, "water-treatment-materials/v1"); assert.equal((await formal()).explorationIntensity, "deep");
  });
  if (process.env.E2E_IDEA_TEMPLATE_BROWSER === "1") await step("6. Edit the finite template in a new browser context and manually save", async () => {
    execFileSync(process.execPath, ["test/sync-e2e.mjs", "--check"]); const { chromium } = createRequire(resolve(".e2e/package.json"))("@playwright/test");
    browser = await chromium.launch({ headless: true, channel: "chromium" }); context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => { const url = new URL(route.request().url()); return ["http:", "https:"].includes(url.protocol) && url.origin !== origin ? route.abort() : route.continue(); });
    await context.addInitScript(({ token, origin }) => { if (location.origin === origin) { localStorage.setItem("sciencediscovery-token", token); localStorage.setItem("sciencediscovery-locale", "en"); } }, { token, origin });
    card = await propose({}); const page = await context.newPage(); await page.goto(origin + `/projects/${project.id}/sessions/${session.id}`, { waitUntil: "domcontentloaded" });
    const panel = page.locator("#configuration-request-" + card.id); await panel.waitFor({ state: "visible" }); const control = panel.locator('select[name="templateId"]');
    await control.selectOption("scientific-hypothesis-general/v1"); await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 650 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await control.scrollIntoViewIfNeeded(); const inspect = () => control.evaluate(element => { const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return { reachable: box.x >= -1 && box.right <= innerWidth + 1 && box.y >= -1 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit)), hit: hit?.className }; });
      let state = await inspect(); const deadline = Date.now() + 2000; while (!state.reachable && Date.now() < deadline) { await page.waitForTimeout(100); state = await inspect(); }
      await page.screenshot({ path: resolve(directory, `template-${viewport.width}x${viewport.height}.png`), fullPage: true, animations: "disabled", caret: "hide" }); assert.equal(state.reachable, true, JSON.stringify(state));
    }
    await panel.getByRole("button", { name: "Confirm choice and continue", exact: true }).click(); await panel.waitFor({ state: "detached" });
    assert.equal((await formal()).templateId, "scientific-hypothesis-general/v1"); assert.equal((await formal()).explorationIntensity, "deep");
    await page.screenshot({ path: resolve(directory, "template-saved.png"), fullPage: true, animations: "disabled", caret: "hide" });
  }); outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close();
  try { if (baseline) await api("/api/settings/idea-tree", baseline, "PUT", 200); if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Restore exact owned fixtures", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  await writeFile(resolve(directory, "startup.log"), logs); await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps, requests, boundary: "No actual scientific research or model; Windows isolated API/optional pinned Chromium", serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Idea Tree template: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(step => `- ${step.name}: ${step.status}${step.error ? ` — ${step.error}` : ""}`).join("\n")}\n`); console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
