// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: review upgrade-era connector requests in the new desktop without a generic-protocol rewrite.
 * Steps: prepare owned historical records before startup; open the desktop; confirm/refuse; reload receipts and read formal settings.
 * Environment: Linux, committed API build and desktop source, own ephemeral loopback ports/data, pinned .e2e Chromium.
 * Type: mocked
 * LLM: none; no prompt or run is submitted.
 * WebSearch: none; enabling built-in Web does not call it.
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; browser egress is restricted to the owned origins.
 * Credentials: generated owned API token, never persisted in reports.
 * CostSideEffects: owned Project/Session records only; data and processes are removed in finally.
 * Run: E2E_LEGACY_DESKTOP_ISOLATED=1 node test/api/desktop-legacy-configuration.mjs
 * Preconditions: build API dependencies, install desktop dependencies, assemble .e2e and install its pinned Chromium.
 * Boundary: historical fixtures are seeded offline because no public endpoint creates legacy requests anymore.
 * CI: journey-desktop-configuration-migration.spec.ts uses --browser to own Chromium and automatic step reports.
 * --browser: starts only the actual API/Vite and historical fixtures; private readiness is emitted to the parent pipe, SIGTERM cleans owned data.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = resolve(".tmp", `desktop-legacy-${randomUUID()}`), data = resolve(directory, "data");
await mkdir(directory, { recursive: true });
const token = randomUUID(), steps = [], children = [], fixtures = [], network = [];
let sha, origin, desktopOrigin, store, browser, context, result = "BLOCKED", logs = "";
const browserMode = process.argv.includes("--browser");
let stopping = false;
const stopped = browserMode ? new Promise(done => {
  const stop = () => { stopping = true; done(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}) : undefined;
class Blocked extends Error {}
async function step(name, expected, work) {
  try { await work(); steps.push({ name, expected, result: "PASS" }); }
  catch (error) { steps.push({ name, expected, result: error instanceof Blocked ? "BLOCKED" : "FAIL", error: String(error.message).replaceAll(token, "[token]") }); throw error; }
}
async function freePort() {
  const socket = createServer(); await new Promise(done => socket.listen(0, "127.0.0.1", done));
  const port = socket.address().port; await new Promise(done => socket.close(done)); return port;
}
function start(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on("data", value => { logs += String(value).replaceAll(token, "[token]"); }); return child;
}
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
}
async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (stopping) throw new Blocked("Owned fixture stopped before readiness");
    if (child.exitCode !== null) throw new Blocked("Owned product process exited before readiness");
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }); if (response.ok || response.status === 401) return; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Blocked("Owned product did not become ready");
}
try {
  await step("1. Prepare historical requests and start the isolated product", "The API returns legacy requests without capabilityId; no user instance is touched.", async () => {
    if (process.env.E2E_LEGACY_DESKTOP_ISOLATED !== "1") throw new Blocked("Explicit owned isolation is required");
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Blocked("Commit the candidate before testing");
    execFileSync(process.execPath, ["test/sync-e2e.mjs", "--check"], { stdio: "pipe" });
    const { SessionStore } = await import(pathToFileURL(resolve("services/api/dist/store.js")).href);
    store = new SessionStore(data); await store.load();
    const project = await store.createProject(`Legacy desktop ${randomUUID()}`);
    for (const locale of ["en", "zh-CN"]) for (const decision of browserMode ? ["apply", "dismiss", "mixed"] : ["apply", "dismiss"]) {
      const session = await store.createSession(project.id, `${locale} ${decision} historical card`, { enabledConnectorIds: [] }, {}, { allowUnconfiguredModel: true });
      const request = store.proposeConnectorConfiguration({ sessionId: session.id, runId: `user-request:${randomUUID()}`,
        connectorId: "web", connectorName: "Web · 网络检索", reason: "USER_REQUESTED_CONNECTOR" });
      fixtures.push({ session, request, locale, decision });
    }
    store.close(); store = undefined;
    const port = await freePort(), desktopPort = await freePort();
    origin = `http://127.0.0.1:${port}`; desktopOrigin = `http://127.0.0.1:${desktopPort}`;
    const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port), SCIENCE_AGENT_AUTH_TOKEN: token,
      SCIENCE_AGENT_DATA_DIR: data, SCIENCE_DISCOVERY_DATA_DIR: data, SCIENCE_AGENT_SAMPLE_SESSION: "0",
      SCIENCE_AGENT_EXECUTOR: process.env.SCIENCE_AGENT_EXECUTOR ?? (process.env.CI_E2E_BACKEND === "jiuwenswarm" ? "jiuwenswarm" : "native"),
      // Configuration-only journey: retain CI's executor without contacting its
      // shared adapter. The adapter and Runner are intentionally unavailable;
      // no model/Run is created and no execution or full-stack claim is made.
      SCIENCE_AGENT_ADAPTER_URL: "http://127.0.0.1:1",
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = "";
    const product = start(["services/api/dist/server.js"], process.cwd(), env); await ready(origin + "/health", product);
    const desktop = start([resolve("apps/desktop/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(desktopPort), "--strictPort"],
      resolve("apps/desktop"), { ...env, SCIENCE_AGENT_API_URL: origin });
    await ready(desktopOrigin, desktop);
    for (const fixture of fixtures) {
      const items = (await api(`/api/sessions/${fixture.session.id}/configuration-requests`)).items;
      assert.equal(items.length, 1); assert.equal(items[0].id, fixture.request.id); assert.equal("capabilityId" in items[0], false);
      assert.deepEqual(await api(`/api/sessions/${fixture.session.id}/runs`), []);
    }
    assert.deepEqual(await api("/api/models"), []);
    if (browserMode) return;
    const require = createRequire(resolve(".e2e/package.json"));
    try { browser = await require("@playwright/test").chromium.launch({ headless: true }); }
    catch (error) { throw new Blocked(`Pinned Chromium could not launch: ${error.message}`); }
  });
  if (browserMode) {
    const health = await api("/health");
    // Consumed only from a private child pipe, never printed by the journey.
    // This is readiness, not a passing browser result. The Playwright fixture owns that verdict.
    console.log(JSON.stringify({ desktopLegacyReady: 1, sha, origin, desktopOrigin, token, fixtures,
      executor: process.env.SCIENCE_AGENT_EXECUTOR ?? (process.env.CI_E2E_BACKEND === "jiuwenswarm" ? "jiuwenswarm" : "native"),
      health: { status: health.status, runner: health.runner?.status },
      boundary: "Offline historical migration fixtures; actual product API and desktop. Adapter and Runner are not started; no model, Run, tool execution or full-stack-health claim." }));
    await stopped;
    result = "PREPARED";
  } else {
  for (const [index, fixture] of fixtures.entries()) {
    const { expect } = createRequire(resolve(".e2e/package.json"))("@playwright/test");
    await step(`${index + 2}. ${fixture.locale}: ${fixture.decision === "apply" ? "confirm" : "refuse"} the historical request and reload`,
      "The native card is reachable at wide/narrow widths; only explicit confirmation changes settings, and the receipt survives reload.", async () => {
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if ([desktopOrigin, origin].includes(url.origin) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
          network.push(url.origin); return route.abort();
        });
        await context.addInitScript(({ token, locale }) => {
          localStorage.setItem("sciencediscovery-token", token);
          localStorage.setItem("sciencediscovery-desktop:guide", "1");
          localStorage.setItem("sciencediscovery-desktop:locale", locale);
        }, { token, locale: fixture.locale });
        const page = await context.newPage(); await page.goto(desktopOrigin);
        const row = page.locator(".side-session", { hasText: fixture.session.title }).first(); await row.click();
        const card = page.locator(`#configuration-request-${fixture.request.id}`); await expect(card).toBeVisible();
        const zh = fixture.locale === "zh-CN";
        const label = fixture.decision === "apply" ? zh ? "确认并启用" : "Confirm and enable" : zh ? "暂不配置" : "Not now";
        for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport); const control = card.getByRole("button", { name: label, exact: true });
          await control.scrollIntoViewIfNeeded(); await control.click({ trial: true });
          assert.equal(await control.evaluate(element => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return box.x >= -1 && box.right <= innerWidth + 1 && (hit === element || element.contains(hit)); }), true);
          await page.screenshot({ path: resolve(directory, `${index + 1}-${fixture.locale}-${fixture.decision}-${viewport.width}.png`), fullPage: true });
        }
        assert.deepEqual((await api(`/api/sessions/${fixture.session.id}/settings`)).overrides.enabledConnectorIds, []);
        await card.getByRole("button", { name: label, exact: true }).click();
        await expect.poll(async () => (await api(`/api/sessions/${fixture.session.id}/configuration-requests`)).items[0].state)
          .toBe(fixture.decision === "apply" ? "applied" : "dismissed");
        await page.reload(); await expect(card).toHaveCount(0);
        const receipt = page.locator(".conversation-configuration-record"); await expect(receipt).toHaveCount(1);
        await expect(receipt).toContainText(fixture.decision === "apply" ? zh ? "已保存" : "Saved" : zh ? "未配置" : "Not configured");
        await receipt.locator("summary").click();
        await page.screenshot({ path: resolve(directory, `${index + 1}-${fixture.locale}-${fixture.decision}-receipt.png`), fullPage: true });
        assert.deepEqual((await api(`/api/sessions/${fixture.session.id}/settings`)).overrides.enabledConnectorIds, fixture.decision === "apply" ? ["web"] : []);
        assert.deepEqual(await api(`/api/sessions/${fixture.session.id}/runs`), []);
        await context.close(); context = undefined;
      });
  }
  assert.deepEqual(network, []); result = "PASS";
  }
} catch (error) {
  result = error instanceof Blocked ? "BLOCKED" : "FAIL"; process.exitCode = 1;
} finally {
  store?.close(); await context?.close(); await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const kill = signal => { try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
    kill("SIGTERM"); await Promise.race([new Promise(done => child.once("exit", done)), new Promise(done => setTimeout(done, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) { kill("SIGKILL"); await new Promise(done => child.once("exit", done)); }
  }
  await rm(data, { recursive: true, force: true });
  await writeFile(resolve(directory, "startup.log"), logs);
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ result, sha, steps, blockedOrigins: network,
    boundary: "Historical offline fixture setup, actual API and desktop; no real model, tool execution or bound-task continuation.", command: "E2E_LEGACY_DESKTOP_ISOLATED=1 node test/api/desktop-legacy-configuration.mjs" }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# Desktop legacy connector requests: ${result}\n\nCommit: ${sha ?? "unknown"}\n\n${steps.map(item => `- ${item.name}: ${item.result}. Expected: ${item.expected}${item.error ? ` Error: ${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ result, sha, report: resolve(directory, "report.md") }));
}
