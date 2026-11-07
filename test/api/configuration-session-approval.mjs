// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: independently acknowledge and save the current Session approval mode.
 * Steps: clean compiled product; separate human consent; exact old-epoch cleanup;
 * failed-cleanup explicit retry; concurrent pending permission; refusal; optional browser.
 * Environment: fresh data and ephemeral loopback product/controlled Runner ports.
 * Type: mocked Runner kernel control only; no execution, model, install or remote job.
 * Credentials: generated owned API token only, redacted from reports.
 * CostSideEffects: delete exact owned Project; stop owned process/browser/stub.
 * Run: E2E_SESSION_APPROVAL_ISOLATED=1 node test/api/configuration-session-approval.mjs
 * Browser: E2E_SESSION_APPROVAL_BROWSER=1 with pinned .e2e Playwright/Chromium.
 * Boundary: no real Runner, Linux, model, Jiuwen or actual bound Agent continuation.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `session-approval-stack-${randomUUID()}`); await mkdir(directory, { recursive: true });
const token = `owned-${randomUUID()}`, steps = [], requests = [], runnerRequests = [], kernels = [];
let outcome = "BLOCKED", sha, origin, product, project, session, sibling, baseline, browser, context, logs = "", runner, failCleanup = false;
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); requests.push({ method, path, status: response.status, code: value.code }); assert.equal(response.status, expected, `${method} ${path}: ${value.code ?? response.status}`); return value;
}
async function step(name, work) { try { await work(); steps.push({ name, status: "PASS" }); } catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error.message).replaceAll(token, "[owned-token]") }); throw error; } }
const path = (card, action) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}${action ? `/${action}` : ""}`;
const current = () => api(`/api/sessions/${session.id}`);
const authorizations = () => api(`/api/sessions/${session.id}/permission-authorizations`);
const propose = values => api(path(), { protocolVersion: 3, capabilityId: "security.approval_mode", values });
const consent = card => api(path(card, "security-consent"), { revision: card.revision, targetDigest: card.securityConsent.targetDigest, acknowledged: true }, "POST", 200);
const decide = (card, decision = "apply", expected = 200) => api(path(card, "decision"), { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: card.selectedOptionId, decision }, "POST", expected);
const save = async card => { await consent(card); return decide(card); };
const cleanupCalls = () => runnerRequests.filter(row => row.method === "POST");
try {
  await step("1. Start a clean committed product and an execution-rejecting controlled Runner", async () => {
    if (process.env.E2E_SESSION_APPROVAL_ISOLATED !== "1") throw new Blocked("Explicit owned isolation required");
    const git = (...args) => execFileSync("git", ["-c", `safe.directory=${process.cwd().replaceAll("\\", "/")}`, ...args], { encoding: "utf8" }).trim();
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit candidate first");
    runner = httpServer(async (request, response) => {
      const pathname = new URL(request.url, "http://owned.test").pathname; runnerRequests.push({ method: request.method, path: pathname });
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET" && pathname === "/health") return send(200, { status: "ok", scientificEnvs: { available: false } });
      if (request.method === "GET" && pathname === "/kernels") return send(200, kernels);
      const match = /^\/kernels\/([^/]+)\/teardown$/u.exec(pathname);
      if (request.method === "POST" && match) {
        for await (const _chunk of request) { /* drain owned request */ }
        if (failCleanup) return send(503, { error: "Owned synthetic cleanup failure" });
        const kernel = kernels.find(item => item.id === decodeURIComponent(match[1]));
        if (kernel) kernel.status = "terminated";
        return send(200, { count: kernel ? 1 : 0, kernelId: match[1] });
      }
      send(403, { error: "Execution and other Runner operations are forbidden in this journey" });
    });
    await new Promise(done => runner.listen(0, "127.0.0.1", done));
    const reservation = createServer(); await new Promise(done => reservation.listen(0, "127.0.0.1", done)); const port = reservation.address().port; await new Promise(done => reservation.close(done)); origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: `http://127.0.0.1:${runner.address().port}` };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[key] = "";
    product = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [product.stdout, product.stderr]) { stream.on("data", data => { logs += String(data).replaceAll(token, "[owned-token]"); }); }
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (product.exitCode !== null) throw new Blocked("Product exited"); try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned API did not become ready");
    baseline = { network: await api("/api/sandbox-network-settings"), settings: await api("/api/settings") };
    project = await api("/api/projects", { name: `Session approval ${randomUUID()}` });
    session = await api(`/api/projects/${project.id}/sessions`, { title: "Owned Session approval" });
    sibling = await api(`/api/projects/${project.id}/sessions`, { title: "Unaffected sibling" });
  });
  outcome = "FAIL"; let card;
  await step("2. Ordinary Apply cannot authorize the Session security policy", async () => {
    card = await propose({ approvalMode: "always_allow" }); assert.equal(card.scope.kind, "session"); assert.equal(card.securityConsent.status, "required"); assert.equal(card.autoApplyAt, undefined);
    assert.equal((await decide(card, "apply", 409)).code, "SECURITY_CONSENT_REQUIRED"); assert.equal((await current()).permissionEpochId, session.permissionEpochId);
  });
  await step("3. Independent consent saves one Session, retires only its old-epoch kernel and never grants an action", async () => {
    const beforeAuthorizations = await authorizations();
    kernels.push({ id: "owned-retired", permissionEpochId: session.permissionEpochId, status: "running", sessionId: session.id }, { id: "owned-new", permissionEpochId: "new-epoch-sentinel", status: "running", sessionId: session.id }, { id: "owned-sibling", permissionEpochId: sibling.permissionEpochId, status: "running", sessionId: sibling.id });
    const saved = await save(card); assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "active"); assert.equal(saved.resumption.state, "not_requested");
    const after = await current(); assert.equal(after.approvalMode, "always_allow"); assert.notEqual(after.permissionEpochId, session.permissionEpochId); assert.equal(after.autoApplyLowRiskConfiguration, session.autoApplyLowRiskConfiguration);
    const calls = cleanupCalls().length; assert.equal(calls, 1); assert.equal(cleanupCalls()[0].path, "/kernels/owned-retired/teardown");
    await decide(card); assert.equal(cleanupCalls().length, calls); assert.equal((await current()).permissionEpochId, after.permissionEpochId);
    assert.deepEqual(await authorizations(), beforeAuthorizations); assert.equal(kernels[1].status, "running"); assert.equal(kernels[2].status, "running");
    assert.equal((await api(`/api/sessions/${sibling.id}`)).permissionEpochId, sibling.permissionEpochId);
    assert.deepEqual(await api("/api/sandbox-network-settings"), baseline.network); assert.deepEqual(await api("/api/settings"), baseline.settings);
  });
  await step("4. Failed cleanup stays distinct from saved policy; replay is inert and explicit Continue retries only retired kernels", async () => {
    const before = await current(); kernels.push({ id: "owned-retry", permissionEpochId: before.permissionEpochId, status: "running", sessionId: session.id });
    failCleanup = true; card = await propose({ approvalMode: "ask_for_dangerous" }); const saved = await save(card);
    assert.equal(saved.state, "applied"); assert.equal(saved.activation.state, "failed"); const epoch = (await current()).permissionEpochId, count = cleanupCalls().length;
    await decide(card); await api(path(card)); assert.equal(cleanupCalls().length, count);
    failCleanup = false; const settled = await api(path(card, "continue"), {}, "POST", 200); assert.equal(settled.activation.state, "active");
    assert.equal((await current()).permissionEpochId, epoch); assert.equal(cleanupCalls().length, count + 1); assert.equal(cleanupCalls().at(-1).path, "/kernels/owned-retry/teardown");
    assert.deepEqual(await authorizations(), []);
  });
  await step("5. A concurrent pending permission invalidates old consent; it remains pending and is denied separately", async () => {
    card = await propose({ approvalMode: "always_allow" }); await consent(card);
    const pending = await api(`/api/sessions/${session.id}/permission-requests`, { action: "remote_job", resource: "owned-never-submitted-job", summary: "Separate permission decision required" }); assert.equal(pending.allowed, false);
    assert.equal((await decide(card, "apply", 409)).code, "RESOURCE_VERSION_CONFLICT"); assert.equal((await current()).approvalMode, "ask_for_dangerous");
    assert.equal((await api(`/api/permission-requests?sessionId=${session.id}`)).find(item => item.id === pending.request.id).state, "pending");
    await api(`/api/permission-requests/${pending.request.id}/decision`, { decision: "deny" }, "POST", 200);
    card = await api(path(card, "preview"), { expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }, "POST", 200); await decide(card, "dismiss");
  });
  if (process.env.E2E_SESSION_APPROVAL_BROWSER === "1") await step("6. Browser separately acknowledges and confirms; saved policy and scope remain visible at three viewports", async () => {
    execFileSync(process.execPath, ["test/sync-e2e.mjs", "--check"]); const { chromium } = createRequire(resolve(".e2e/package.json"))("@playwright/test");
    browser = await chromium.launch({ headless: true, channel: "chromium" }); context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => { const url = new URL(route.request().url()); return ["http:", "https:"].includes(url.protocol) && url.origin !== origin ? route.abort() : route.continue(); });
    await context.addInitScript(({ token, origin }) => { if (location.origin === origin) { localStorage.setItem("sciencediscovery-token", token); localStorage.setItem("sciencediscovery-locale", "en"); } }, { token, origin });
    card = await propose({}); const page = await context.newPage(); await page.goto(origin + "/projects/" + project.id + "/sessions/" + session.id, { waitUntil: "domcontentloaded" });
    const panel = page.locator("#configuration-request-" + card.id); await panel.waitFor({ state: "visible" }); const control = panel.locator('select[name="approvalMode"]');
    await control.selectOption("always_allow"); await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const confirm = panel.getByRole("button", { name: "Confirm choice and continue", exact: true }); await confirm.waitFor({ state: "visible" }); assert.equal(await confirm.isDisabled(), true);
    const independent = panel.getByRole("button", { name: "Independently approve this exact security policy", exact: true }); assert.equal(await independent.isDisabled(), true);
    assert.match(await panel.innerText(), /Existing permission cards must be handled separately/); await panel.locator('input[type="checkbox"]').check(); await independent.click();
    for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 650 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await control.scrollIntoViewIfNeeded();
      const inspect = () => control.evaluate(element => { const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return { reachable: box.x >= -1 && box.right <= innerWidth + 1 && box.y >= -1 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit)), hit: hit?.className }; });
      let state = await inspect(); const deadline = Date.now() + 2000; while (!state.reachable && Date.now() < deadline) { await page.waitForTimeout(100); state = await inspect(); }
      await page.screenshot({ path: resolve(directory, `approval-${viewport.width}x${viewport.height}.png`), fullPage: true, animations: "disabled", caret: "hide" }); assert.equal(state.reachable, true, JSON.stringify(state));
    }
    await confirm.click(); await panel.waitFor({ state: "detached" }); assert.equal((await current()).approvalMode, "always_allow");
    const record = page.locator(".conversation-configuration-record").filter({ hasText: "Current session approval" }).last(); await record.scrollIntoViewIfNeeded();
    await record.locator("summary").first().click();
    const savedStatus = record.getByText("Session policy saved; the new permission epoch is installed", { exact: false });
    await savedStatus.waitFor({ state: "visible" }); await savedStatus.scrollIntoViewIfNeeded();
    assert.match(await record.innerText(), /This session only/);
    await page.screenshot({ path: resolve(directory, "approval-saved.png"), fullPage: true, animations: "disabled", caret: "hide" });
  });
  assert.ok(runnerRequests.every(row => row.method === "GET" || /^\/kernels\/[^/]+\/teardown$/u.test(row.path)), "No execution route is permitted"); outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  await context?.close(); await browser?.close();
  try { if (project) await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); steps.push({ name: "Delete exact owned Project and Sessions", status: "PASS" }); }
  catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Delete exact owned Project and Sessions", status: "FAIL" }); }
  if (product && product.exitCode === null && product.signalCode === null) { product.kill(); await Promise.race([new Promise(done => product.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (product && product.exitCode === null && product.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; }
  if (runner) { runner.closeAllConnections(); await new Promise(done => runner.close(done)); }
  await writeFile(resolve(directory, "startup.log"), logs); await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps, requests, runnerRequests, boundary: "Windows isolated product; controlled Runner kernel control only, no actual execution/Agent/model/Jiuwen/Linux", serverExit: { code: product?.exitCode, signal: product?.signalCode, pid: product?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Current Session approval: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`); console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
