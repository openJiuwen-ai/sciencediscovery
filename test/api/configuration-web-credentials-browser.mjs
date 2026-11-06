// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: use the actual Web credential card in a browser, including clearing a key when its provider changes.
 * Steps: owned immutable startup/card; inspect wide/narrow layouts; switch provider; secure preview and manual Apply.
 * Environment: compiled Native product, fresh data/port, repository-pinned .e2e Chromium and an empty browser context.
 * Type: synthetic key only; no real LLM, Web provider calls, Runner operations or other external services.
 * Credentials: owned generated API token and a synthetic Web key, excluded from reports; all non-owned browser HTTP is blocked.
 * CostSideEffects: only owned fixture keys/Project, removed in finally; owned browser/server closed.
 * Run: E2E_WEB_CREDENTIALS_BROWSER_ISOLATED=1 PLAYWRIGHT_BROWSERS_PATH=<owned pinned cache>
 * node test/api/configuration-web-credentials-browser.mjs
 * Requires node test/sync-e2e.mjs --write and npm ci in .e2e, plus the matching Chromium download.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd(), directory = resolve(".tmp", `web-credential-browser-${randomUUID()}`);
await mkdir(directory, { recursive: true });
let outcome = "BLOCKED", sha, server, browser, context, page, origin, project, session, card;
const steps = [], blockedExternal = [], token = `owned-browser-${randomUUID()}`;
let logs = "";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const redact = value => String(value).replaceAll(token, "[owned-token]").replaceAll("synthetic-browser-key", "[synthetic-key]");
class Blocked extends Error {}
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${path}`); return response.json();
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); }
  catch (error) { steps.push({ name, status: error instanceof Blocked ? "BLOCKED" : "FAIL", error: redact(error.message) }); throw error; }
}
try {
  await step("1. Start the immutable isolated product and open an owned configuration card", async () => {
    if (process.env.E2E_WEB_CREDENTIALS_BROWSER_ISOLATED !== "1") throw new Blocked("Explicit owned browser isolation is required");
    sha = git("rev-parse", "HEAD"); if (git("status", "--porcelain", "--untracked-files=no")) throw new Blocked("Commit the candidate before testing");
    execFileSync(process.execPath, ["test/sync-e2e.mjs", "--check"]);
    const requirePinned = createRequire(resolve(".e2e/package.json")); const { chromium } = requirePinned("@playwright/test");
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    const reservation = createServer(); await new Promise(done => reservation.listen(0, "127.0.0.1", done));
    const port = reservation.address().port; await new Promise(done => reservation.close(done)); origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"), SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_SAMPLE_SESSION: "0",
      SCIENCE_AGENT_EXECUTOR: "native", SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[name] = "";
    server = spawn(process.execPath, ["services/api/dist/server.js"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [server.stdout, server.stderr]) stream.on("data", data => { logs += redact(data); });
    let ready = false; const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { if (server.exitCode !== null) throw new Blocked("Owned product exited during startup");
      try { await api("/health"); ready = true; break; } catch {} await new Promise(done => setTimeout(done, 200)); }
    if (!ready) throw new Blocked("Owned product did not become ready");
    project = await api("/api/projects", { name: `Web credential browser ${randomUUID()}` });
    session = await api(`/api/projects/${project.id}/sessions`, { title: "Secure Web credential card" });
    card = await api(`/api/sessions/${session.id}/configuration-requests`, { protocolVersion: 3, capabilityId: "web.credential", values: { webProvider: "jina" } });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) { blockedExternal.push(url.origin); return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(({ token, origin }) => { if (location.origin === origin) { localStorage.setItem("sciencediscovery-token", token); localStorage.setItem("sciencediscovery-locale", "en"); } }, { token, origin });
    page = await context.newPage(); await page.goto(`${origin}/projects/${project.id}/sessions/${session.id}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator(`#configuration-request-${card.id}`).waitFor({ state: "visible", timeout: 30000 });
  });
  outcome = "FAIL";
  const panel = page.locator(`#configuration-request-${card.id}`);
  await step("2. Inspect the visible card and reachable actions at wide and narrow viewports", async () => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await panel.getByText("Manage Web service credentials", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(directory, `card-heading-${viewport.width}x${viewport.height}.png`), fullPage: true });
      for (const control of [panel.locator('[name="webProvider"]'), panel.locator('[name="apiToken"]'), panel.getByRole("button", { name: "Refresh proposed changes", exact: true })]) {
        await control.scrollIntoViewIfNeeded(); assert.equal(await control.isVisible(), true);
        const reachable = await control.evaluate(element => {
          const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight && (hit === element || element.contains(hit));
        });
        assert.equal(reachable, true, "A reviewed field or action is clipped or covered");
      }
      await page.screenshot({ path: resolve(directory, `card-actions-${viewport.width}x${viewport.height}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step("3. Switching provider clears the private key, including when returning to the original provider", async () => {
    await panel.locator('[name="apiToken"]').fill("synthetic-browser-key");
    await panel.locator('[name="webProvider"]').selectOption("exa");
    assert.equal(await panel.locator('[name="apiToken"]').inputValue(), "");
    await panel.locator('[name="webProvider"]').selectOption("jina");
    assert.equal(await panel.locator('[name="apiToken"]').inputValue(), "");
  });
  await step("4. Secure preview clears plaintext, manual Apply stores the key and preserves routing", async () => {
    const before = await api("/api/web/settings");
    await panel.locator('[name="apiToken"]').fill("synthetic-browser-key");
    await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const confirm = panel.locator("button.primary-button"); await confirm.waitFor({ state: "visible" });
    const deadline = Date.now() + 15000;
    while (!await confirm.isEnabled() && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    assert.equal(await confirm.isEnabled(), true);
    assert.equal(await panel.locator('[name="apiToken"]').inputValue(), "");
    await page.screenshot({ path: resolve(directory, "reviewed-secure-key.png"), fullPage: true });
    await confirm.click();
    let saved; const savedDeadline = Date.now() + 15000;
    while (Date.now() < savedDeadline) { saved = await api("/api/web/settings"); if (saved.providers.find(item => item.provider === "jina").hasApiKey) break; await new Promise(done => setTimeout(done, 100)); }
    assert.equal(saved.providers.find(item => item.provider === "jina").hasApiKey, true);
    assert.equal(saved.proxyPolicy, before.proxyPolicy); assert.deepEqual(saved.paidSearchProviders, before.paidSearchProviders);
    await page.screenshot({ path: resolve(directory, "saved-unverified-key.png"), fullPage: true });
  });
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try { await context?.close(); await browser?.close();
    if (project) { await api("/api/web/settings", { providerApiKeys: { jina: null } }, "PUT", 200); await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Cleanup exact owned browser fixtures", status: "FAIL" }); }
  if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await Promise.race([new Promise(done => server.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (server && server.exitCode === null && server.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Owned server exit", status: "FAIL" }); }
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, startup: "node services/api/dist/server.js; fresh owned data/loopback port/native", steps, viewports: ["1280x800 DPR1", "390x844 DPR1"], blockedExternal, realLLM: false, providerAuthentication: "not tested", serverExit: { code: server?.exitCode, signal: server?.signalCode, pid: server?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Web credential browser: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
