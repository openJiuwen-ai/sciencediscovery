// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
test.use({ trace: "off" }); // The owned API token must not be retained in request traces.

type Row = Record<string, any>;
type HistoricalFixture = { locale: "en" | "zh-CN"; decision: "apply" | "dismiss" | "mixed"; session: Row; request: Row };
type Runtime = { desktopLegacyReady: 1; sha: string; origin: string; desktopOrigin: string; token: string; executor: string; health: { status: string; runner?: string }; fixtures: HistoricalFixture[]; fixtureModel: Row };
const words = {
  en: { confirm: "Confirm", decline: "Cancel", refused: "Do not configure",
    legacyApply: "Confirm and enable", legacyDismiss: "Not now", legacyRefused: "Not configured", saved: "Saved" },
  "zh-CN": { confirm: "确认", decline: "取消", refused: "暂不配置",
    legacyApply: "确认并启用", legacyDismiss: "暂不配置", legacyRefused: "未配置", saved: "已保存" },
};
const boundary = "Historical records are offline migration fixtures created through the real Store before API startup, not naturally generated current conversations. All later requests, decisions and rendering use the actual API and desktop. Adapter and Runner are not started. One inert credential-free loopback profile unlocks desktop setup; its guard rejects and counts model requests. No full-stack-health, model invocation, Run, tool execution or continuation claim.";
let child: ChildProcess | undefined, runtime: Runtime;
const path = (session: Row, card?: Row) => `/api/sessions/${session.id}/configuration-requests${card ? `/${card.id}` : ""}`;
async function api(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
  const response = await fetch(runtime.origin + url, { method, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  expect(response.ok, `${method} ${url}: ${response.status}`).toBe(true); return response.json();
}
async function stopFixture() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  const deadline = setTimeout(() => child?.kill("SIGKILL"), 20_000);
  try { await exited; } finally { clearTimeout(deadline); }
  expect(child.exitCode, "The owned fixture must stop and clean up normally").toBe(0);
}
async function openSession(page: Page, session: Row) {
  await page.locator(".side-session", { hasText: session.title }).click();
  await expect(page.locator(".task-head-title")).toContainText(session.title);
}
async function boot(page: Page, fixture: HistoricalFixture) {
  await page.addInitScript(({ origin, token, locale }) => {
    if (location.origin !== origin) return;
    localStorage.setItem("sciencediscovery-token", token);
    localStorage.setItem("sciencediscovery-desktop:guide", "1");
    localStorage.setItem("sciencediscovery-desktop:locale", locale);
  }, { origin: runtime.desktopOrigin, token: runtime.token, locale: fixture.locale });
  await page.setViewportSize({ width: 1440, height: 1600 });
  await page.goto(runtime.desktopOrigin); await openSession(page, fixture.session);
}
async function reload(page: Page, session: Row) {
  await page.setViewportSize({ width: 1440, height: 1600 }); await page.reload(); await openSession(page, session);
}
async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate(element => {
    const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.width > 0 && box.x >= -1 && box.right <= innerWidth + 1 && box.y >= -1 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit));
  })).toBe(true);
}
async function narrow(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function showReceipt(page: Page, label: string, count: number) {
  const records = page.locator(".conversation-configuration-record"); await expect(records).toHaveCount(count);
  const record = records.filter({ hasText: label }); await expect(record).toHaveCount(1);
  if (await record.getAttribute("open") === null) await record.locator("summary").click();
  await record.scrollIntoViewIfNeeded(); return record;
}
const isList = (response: Response, session: Row) => response.request().method() === "GET" && new URL(response.url()).pathname === path(session) && response.status() === 200;
async function unchangedModelAndNoRun(session: Row) {
  expect(await api("/api/models")).toEqual([runtime.fixtureModel]); expect(await api(`/api/sessions/${session.id}/runs`)).toEqual([]);
}

// "mocked" is the existing hermetic/offline-fixture CI lane, not an API/UI/LLM mock.
// This safety audit needs no model credential or paid/external capability.
test.describe("Desktop historical configuration migration", { tag: ["@fixture:standard", "@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:none", "@status:reviewed"] }, () => {
  test.beforeAll(async () => {
    let output = "";
    child = spawn(process.execPath, ["test/api/desktop-legacy-configuration.mjs", "--browser"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, E2E_LEGACY_DESKTOP_ISOLATED: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", value => { output += String(value); });
    // Do not echo the child readiness line: its token is private to this pipe.
    child.stderr!.on("data", () => {});
    try {
      await expect.poll(() => {
        const line = output.split("\n").find(line => line.startsWith('{"desktopLegacyReady":1,'));
        if (line) { runtime = JSON.parse(line); return true; }
        if (child!.exitCode !== null) throw new Error(`BLOCKED: owned legacy API/Vite fixture exited before readiness (${child!.exitCode}); inspect its .tmp report`);
        return false;
      }, { timeout: 120_000 }).toBe(true);
    } catch (error) { await stopFixture(); throw error; }
  });
  test.afterAll(stopFixture);
  test.beforeEach(async ({ context }) => {
    // Narrow the existing local-only guard to this journey's two owned origins.
    // Benign external requests (for example repository-star metadata) remain blocked, never fulfilled.
    await context.route("**/*", route => [runtime.origin, runtime.desktopOrigin].includes(new URL(route.request().url()).origin)
      ? route.continue() : route.abort("blockedbyclient"));
    await context.routeWebSocket(() => true, socket => {
      if (socket.url().startsWith(runtime.desktopOrigin.replace(/^http/, "ws") + "/")) socket.connectToServer(); else void socket.close();
    });
  });

  for (const locale of ["en", "zh-CN"] as const) {
    /**
     * E2E-META
     * Purpose: Preserve an incomplete generic input across real automatic polling, then safely auto-preview its completed value in a mixed historical migration Session.
     * Steps:
     *   1. Open a real public-API timeout proposal alongside an explicitly labelled offline historical legacy request.
     *   2. Clear a focused numeric field and observe two actual unchanged interval GET responses without triggering refresh manually.
     *   3. Resize, complete the value and check its automatic preview revision/digest; refuse both proposals and reload persistent receipts with settings unchanged.
     * Environment: Current committed compiled API plus desktop Vite; owned ephemeral ports/data; pinned Chromium; en/zh-CN at 1440x900 and 390x844, DPR1.
     * Type: mocked
     * LLM: an inert credential-free loopback profile only; the fixture rejects model requests and fails on any invocation; no scripted response, paid call or Run.
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none; only historical data is an offline fixture, all API/browser responses are actual product responses and non-local browser requests are blocked.
     * Credentials: generated owned local API token held in the private child pipe, not printed or traced.
     * CostSideEffects: only owned migration Session proposals; both refused, no formal configuration saved; fixture data/processes removed in afterAll.
     */
    test(`${locale}: generic edit survives real legacy-triggered polling`, { tag: "@mocked" }, async ({ page, journey }) => {
      const fixture = runtime.fixtures.find(item => item.locale === locale && item.decision === "mixed")!;
      const { session, request: legacy } = fixture, text = words[locale];
      journey.scenario({ goal: "Keep an incomplete generic draft across real interval reads, then preview its completed value without applying it.",
        preconditions: [`Frontend/backend ${runtime.sha}; executor ${runtime.executor}`, `${locale}; 1440x900 and 390x844 CSS px; DPR1`, boundary] });
      journey.note("The pending historical legacy fixture enables the real 2-second interval. A standalone public-API timeout proposal does not poll. This is not natural new-session history, and it does not prove standalone generic polling or runtime continuation.");
      journey.note(`Actual owned API health: ${runtime.health.status}; Runner: ${runtime.health.runner ?? "not reported"}. Runner is intentionally absent for this configuration-only migration check.`);
      const baseline = await api("/api/timeout-settings"), next = baseline.runnerExecTimeoutMs === 90000 ? 91000 : 90000;
      const card = await api(path(session), { protocolVersion: 3, capabilityId: "timeouts.configure", values: { runnerExecTimeoutMs: next + 1000 } });
      expect(card.id).not.toBe(legacy.id); expect(card.runId).toBeUndefined(); expect(card.autoApplyAt).toBeUndefined();
      const snapshots = (await api(path(session))).items; expect(snapshots).toHaveLength(2);
      const historical = snapshots.find((item: Row) => item.id === legacy.id);
      expect("capabilityId" in historical).toBe(false); expect(historical.state).toBe("awaiting_confirmation");
      expect(snapshots.filter((item: Row) => "capabilityId" in item)).toHaveLength(1); await unchangedModelAndNoRun(session);
      await boot(page, fixture);
      await page.setViewportSize({ width: 1440, height: 900 });
      const mutations: string[] = [];
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname.startsWith(`${path(session, card)}/`)) mutations.push(new URL(request.url()).pathname);
      });
      const panel = page.locator(`#configuration-request-${card.id}`), field = panel.locator('input[name="runnerExecTimeoutMs"]');
      await journey.step("1. Mixed migration card before input", "The untouched generic proposal is shown in the actual desktop transcript.", async () => {
        await expect(field).toHaveValue(String(next + 1000)); await panel.scrollIntoViewIfNeeded(); await expect(panel).toBeInViewport({ ratio: 1 });
        expect((await panel.boundingBox())!.height, "Closed desktop timeout card height").toBeLessThanOrEqual(300);
      });
      await journey.step("2. Same card mid-edit", "Clearing the focused numeric input leaves a real incomplete draft; confirmation and automatic preview wait for a valid value.", async () => {
        await field.fill(""); await expect(field).toBeFocused();
        await expect(panel.getByRole("button", { name: text.confirm, exact: true })).toBeDisabled();
        expect((await api(path(session))).items).toEqual(snapshots); await reachable(field);
      });
      await journey.step("3. Same edit after actual unchanged interval reads", "Two automatic browser GETs return identical snapshots and the local edited value survives.", async () => {
        const entered = Date.now();
        // No action, reload, rename, request injection, fabricated Run or timer override in this step.
        const first = await page.waitForResponse(response => isList(response, session) && response.request().timing().startTime >= entered + 1500, { timeout: 12_000 });
        expect((await first.json()).items).toEqual(snapshots);
        const firstAt = first.request().timing().startTime;
        const second = await page.waitForResponse(response => isList(response, session) && response.request().timing().startTime >= firstAt + 1500, { timeout: 12_000 });
        expect((await second.json()).items).toEqual(snapshots);
        await expect(field).toHaveValue(""); await expect(field).toBeFocused();
        await expect(panel.getByRole("button", { name: text.confirm, exact: true })).toBeDisabled();
        expect(mutations, "Incomplete numeric drafts must neither preview nor apply").toEqual([]);
        expect(await api("/api/timeout-settings")).toEqual(baseline);
        journey.note(`Actual interval GET start times: ${firstAt}, ${second.request().timing().startTime}. Both HTTP 200, full snapshots unchanged. Local numeric draft empty; server proposal ${next + 1000}. Trigger: pending historical legacy fixture. No preview or decision POST occurred.`);
        await reachable(field);
      });
      await journey.step("4. Narrow retained draft", "The same edited field remains reachable at 390x844 without horizontal page overflow.", async () => {
        await narrow(page); await expect(field).toHaveValue(""); await reachable(field);
        await panel.scrollIntoViewIfNeeded(); await expect(panel).toBeInViewport({ ratio: 1 });
        expect((await panel.boundingBox())!.height, "Closed narrow timeout card height").toBeLessThanOrEqual(300);
      });
      await journey.step("4b. Finish the value without Refresh", "Completing the numeric edit automatically persists a new preview only; its exact revision, digest and value are readable from the real API.", async () => {
        const pending = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${path(session, card)}/preview`);
        await field.fill(String(next)); await field.press("Tab");
        const response = await pending; expect(response.status()).toBe(200);
        const returned = await response.json(), reviewed = await api(path(session, card));
        expect(reviewed.revision).toBeGreaterThan(card.revision);
        expect(reviewed.revision).toBe(returned.revision); expect(reviewed.previewDigest).toBe(returned.previewDigest);
        expect(reviewed.previewDigest).toEqual(expect.any(String)); expect(reviewed.previewDigest.length).toBeGreaterThan(0);
        expect(reviewed.previewDigest).not.toBe(card.previewDigest);
        expect(reviewed.fields.find((item: Row) => item.id === "runnerExecTimeoutMs").value).toBe(next);
        expect(reviewed.state).toBe("awaiting_confirmation"); expect(reviewed.scope).toEqual(card.scope);
        expect(reviewed.choiceReceipt).toBeUndefined(); expect(reviewed.autoApplyAt).toBeUndefined();
        expect(mutations.filter(operation => operation.endsWith("/decision"))).toEqual([]);
        expect((await api(path(session))).items.find((item: Row) => item.id === legacy.id)).toEqual(historical);
        await expect(panel.getByRole("button", { name: text.confirm, exact: true })).toBeEnabled();
        await expect(panel.getByRole("button", { name: locale === "en" ? "Refresh proposed changes" : "刷新修改方案", exact: true })).toHaveCount(0);
        expect(await api("/api/timeout-settings")).toEqual(baseline); await unchangedModelAndNoRun(session);
        await panel.scrollIntoViewIfNeeded(); await expect(panel).toBeInViewport({ ratio: 1 });
      });
      await journey.step("5. Refuse the generic proposal", "Declining persists one generic receipt without saving its unsaved timeout draft.", async () => {
        const decline = panel.getByRole("button", { name: text.decline, exact: true }); await reachable(decline); await decline.click();
        await expect.poll(async () => (await api(path(session, card))).state).toBe("dismissed");
        await reload(page, session); await expect(panel).toHaveCount(0); await showReceipt(page, text.refused, 1);
        expect(await api("/api/timeout-settings")).toEqual(baseline);
      });
      await journey.step("6. Refuse the independent historical request", "Two distinct persistent receipts remain; neither pending card or its apply/dismiss controls remains.", async () => {
        const old = page.locator(`#configuration-request-${legacy.id}`); await old.getByRole("button", { name: text.legacyDismiss, exact: true }).click();
        await expect.poll(async () => (await api(path(session))).items.find((item: Row) => item.id === legacy.id).state).toBe("dismissed");
        await reload(page, session); await expect(old).toHaveCount(0); await expect(panel).toHaveCount(0); await showReceipt(page, "Web · 网络检索", 2);
        expect((await api(`/api/sessions/${session.id}/settings`)).overrides.enabledConnectorIds).toEqual([]);
        expect(await api("/api/timeout-settings")).toEqual(baseline); await unchangedModelAndNoRun(session);
      });
    });

    for (const decision of ["apply", "dismiss"] as const) {
      /**
       * E2E-META
       * Purpose: Review and decide a historical desktop connector request without inventing a generic companion, revision or consent.
       * Steps:
       *   1. Inspect the actual pending legacy card and its unchanged automatic interval response.
       *   2. Check narrow controls, confirm or refuse, reload one receipt and read formal settings.
       * Environment: Current committed compiled API plus desktop Vite; owned historical migration data; pinned Chromium; en/zh-CN, 1440x1600 and 390x844, DPR1.
       * Type: mocked
       * LLM: an inert credential-free loopback profile only; model requests are rejected and must remain zero; no response, Run or paid provider.
       * WebSearch: none; enabling built-in Web changes settings only and does not search.
       * PaperSources: none
       * MCP: none
       * OtherExternal: none; old-format data is seeded offline before actual API startup; no browser response is fulfilled or replaced.
       * Credentials: generated owned local API token in a private child pipe; no request trace.
       * CostSideEffects: owned Session connector choice only; data and processes removed by the fixture afterAll.
       */
      test(`${locale}: historical request ${decision} without generic companion`, { tag: "@mocked" }, async ({ page, journey }) => {
        const fixture = runtime.fixtures.find(item => item.locale === locale && item.decision === decision)!;
        const { session, request: card } = fixture, text = words[locale], snapshots = (await api(path(session))).items;
        expect(snapshots).toHaveLength(1); expect(snapshots[0].id).toBe(card.id);
        for (const key of ["capabilityId", "revision", "previewDigest", "securityConsent"]) expect(key in snapshots[0]).toBe(false);
        expect(snapshots[0].state).toBe("awaiting_confirmation"); await unchangedModelAndNoRun(session);
        journey.scenario({ goal: `Review and ${decision === "apply" ? "confirm" : "refuse"} a historical connector card without a generic companion.`,
          preconditions: [`Frontend/backend ${runtime.sha}; executor ${runtime.executor}`, `${locale}; 1440x1600 and 390x844 CSS px; DPR1`, boundary] });
        journey.note("This is offline-created historical migration data, not a naturally generated current conversation. The actual API owns the decision and the desktop owns its rendering; no generic revision or consent is fabricated.");
        journey.note(`Actual owned API health: ${runtime.health.status}; Runner: ${runtime.health.runner ?? "not reported"}. No healthy full-stack claim.`);
        await boot(page, fixture);
        const panel = page.locator(`#configuration-request-${card.id}`), action = decision === "apply" ? text.legacyApply : text.legacyDismiss;
        await journey.step("1. Historical pending card without companion", "Exactly one historical request is actionable in the native desktop card.", async () => {
          await expect(panel).toBeVisible(); await expect(panel.getByRole("button", { name: action, exact: true })).toBeEnabled(); await panel.scrollIntoViewIfNeeded();
        });
        await journey.step("2. Actual unchanged legacy interval", "The application itself reads the identical historical snapshot without a manual refresh.", async () => {
          const response = await page.waitForResponse(response => isList(response, session), { timeout: 10_000 });
          expect((await response.json()).items).toEqual(snapshots); await expect(panel).toBeVisible();
        });
        await journey.step("3. Narrow historical controls", "Both historical choices remain reachable at 390x844 before any setting is changed.", async () => {
          await narrow(page); await reachable(panel.getByRole("button", { name: text.legacyApply, exact: true })); await reachable(panel.getByRole("button", { name: text.legacyDismiss, exact: true }));
          expect((await api(`/api/sessions/${session.id}/settings`)).overrides.enabledConnectorIds).toEqual([]);
        });
        await journey.step("4. Persisted receipt once after reload", "The actual decision persists exactly once, its apply/dismiss actions disappear and formal settings match the choice.", async () => {
          await panel.getByRole("button", { name: action, exact: true }).click();
          await expect.poll(async () => (await api(path(session))).items[0].state).toBe(decision === "apply" ? "applied" : "dismissed");
          await reload(page, session); await expect(panel).toHaveCount(0);
          const record = await showReceipt(page, decision === "apply" ? text.saved : text.legacyRefused, 1);
          await expect(record.getByRole("button", { name: text.legacyApply, exact: true })).toHaveCount(0); await expect(record.getByRole("button", { name: text.legacyDismiss, exact: true })).toHaveCount(0);
          const current = (await api(path(session))).items; expect(current).toHaveLength(1); expect("capabilityId" in current[0]).toBe(false);
          expect((await api(`/api/sessions/${session.id}/settings`)).overrides.enabledConnectorIds).toEqual(decision === "apply" ? ["web"] : []); await unchangedModelAndNoRun(session);
        });
      });
    }
  }
});
