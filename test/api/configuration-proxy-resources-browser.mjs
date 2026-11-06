// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: use the actual proxy resource card in a browser, including clearing a URL when its proxy type changes.
 * Steps: owned immutable startup/card; inspect wide/narrow layouts; switch proxy type; secure preview and manual Apply.
 * Environment: compiled Native product, fresh data/port, repository-pinned .e2e Chromium and an empty browser context.
 * Type: synthetic proxy URL only; no real LLM, proxy connections, Runner operations or other external services.
 * Credentials: owned generated API token and a synthetic Proxy URL, excluded from reports; all non-owned browser HTTP is blocked.
 * CostSideEffects: only an owned proxy resource/Project, removed in finally; owned browser/server closed.
 * Run: E2E_PROXY_RESOURCES_BROWSER_ISOLATED=1 PLAYWRIGHT_BROWSERS_PATH=<owned pinned cache>
 * node test/api/configuration-proxy-resources-browser.mjs
 * Requires node test/sync-e2e.mjs --write and npm ci in .e2e, plus the matching Chromium download.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const directory = resolve(".tmp", `proxy-resource-browser-${randomUUID()}`);
await mkdir(directory, { recursive: true });
let outcome = "BLOCKED", sha, server, browser, context, page, origin, project, session, card;
const steps = [], blockedExternal = [], token = `owned-browser-${randomUUID()}`;
const fixtureName = `Proxy browser fixture ${randomUUID()}`; let createdProxyId;
let logs = "";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const redact = value => String(value).replaceAll(token, "[owned-token]").replaceAll("https://synthetic:browser-password@proxy.invalid:8443/", "[synthetic-key]");
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
    if (process.env.E2E_PROXY_RESOURCES_BROWSER_ISOLATED !== "1") throw new Blocked("Explicit owned browser isolation is required");
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
    project = await api("/api/projects", { name: `Proxy resource browser ${randomUUID()}` });
    session = await api(`/api/projects/${project.id}/sessions`, { title: "Secure Proxy resource card" });
    card = await api(`/api/sessions/${session.id}/configuration-requests`, { protocolVersion: 3, capabilityId: "proxy.resources", values: { operation: "create", name: fixtureName, kind: "custom_url" } });
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
      await panel.getByText("Manage proxy resources", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(directory, `card-heading-${viewport.width}x${viewport.height}.png`), fullPage: true });
      for (const control of [panel.locator('[name="kind"]'), panel.locator('[name="proxyUrl"]'), panel.getByRole("button", { name: "Refresh proposed changes", exact: true })]) {
        await control.scrollIntoViewIfNeeded(); assert.equal(await control.isVisible(), true);
        const reachability = () => control.evaluate(element => {
          const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return { reachable: box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight && (hit === element || element.contains(hit)),
            field: element.getAttribute("name") ?? element.tagName, box: { x: box.x, y: box.y, width: box.width, height: box.height },
            hit: { tag: hit?.tagName, className: hit?.className }, viewport: { width: innerWidth, height: innerHeight } };
        });
        let state = await reachability(); const settledDeadline = Date.now() + 2000;
        while (!state.reachable && Date.now() < settledDeadline) { await new Promise(done => setTimeout(done, 100)); state = await reachability(); }
        if (!state.reachable) await page.screenshot({ path: resolve(directory, `covered-control-${viewport.width}x${viewport.height}.png`), fullPage: true });
        assert.equal(state.reachable, true, `A reviewed field or action is clipped or covered: ${JSON.stringify(state)}`);
      }
      await page.screenshot({ path: resolve(directory, `card-actions-${viewport.width}x${viewport.height}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step("3. Switching proxy type clears the private URL, including when returning to the original proxy type", async () => {
    await panel.locator('[name="proxyUrl"]').fill("https://synthetic:browser-password@proxy.invalid:8443/");
    await panel.locator('[name="kind"]').selectOption("system");
    assert.equal(await panel.locator('[name="proxyUrl"]').inputValue(), "");
    await panel.locator('[name="kind"]').selectOption("custom_url");
    assert.equal(await panel.locator('[name="proxyUrl"]').inputValue(), "");
  });
  await step("4. Secure preview clears plaintext, manual Apply creates a proxy and preserves default routing", async () => {
    const before = await api("/api/proxy/settings");
    await panel.locator('[name="proxyUrl"]').fill("https://synthetic:browser-password@proxy.invalid:8443/");
    await panel.getByRole("button", { name: "Refresh proposed changes", exact: true }).click();
    const confirm = panel.locator("button.primary-button"); await confirm.waitFor({ state: "visible" });
    const deadline = Date.now() + 15000;
    while (!await confirm.isEnabled() && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
    assert.equal(await confirm.isEnabled(), true);
    assert.equal(await panel.locator('[name="proxyUrl"]').inputValue(), "");
    await page.screenshot({ path: resolve(directory, "reviewed-secure-key.png"), fullPage: true });
    await confirm.click();
    let saved; const savedDeadline = Date.now() + 15000;
    while (Date.now() < savedDeadline) { saved = await api("/api/proxy/settings"); if (saved.servers.some(item => item.name === fixtureName)) break; await new Promise(done => setTimeout(done, 100)); }
    const created = saved.servers.find(item => item.name === fixtureName); assert.ok(created); createdProxyId = created.id;
    assert.equal(created.url, "https://synthetic:browser-password@proxy.invalid:8443/");
    assert.equal(saved.defaultPolicy, before.defaultPolicy);
    await page.screenshot({ path: resolve(directory, "saved-unverified-key.png"), fullPage: true });
  });
  outcome = "PASS";
} catch (error) { outcome = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1; }
finally {
  try { await context?.close(); await browser?.close();
    if (project) { if (!createdProxyId) createdProxyId = (await api("/api/proxy/settings")).servers.find(item => item.name === fixtureName)?.id;
      if (createdProxyId) await api(`/api/proxy/servers/${createdProxyId}`, undefined, "DELETE", 200); await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  } catch { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Cleanup exact owned browser fixtures", status: "FAIL" }); }
  if (server && server.exitCode === null && server.signalCode === null) { server.kill(); await Promise.race([new Promise(done => server.once("exit", done)), new Promise(done => setTimeout(done, 5000))]); }
  if (server && server.exitCode === null && server.signalCode === null) { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Owned server exit", status: "FAIL" }); }
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, startup: "node services/api/dist/server.js; fresh owned data/loopback port/native", steps, viewports: ["1280x800 DPR1", "390x844 DPR1"], blockedExternal, realLLM: false, proxyConnectivity: "not tested", serverExit: { code: server?.exitCode, signal: server?.signalCode, pid: server?.pid } }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Proxy resource browser: ${outcome}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, report: resolve(directory, "report.md") }));
}
