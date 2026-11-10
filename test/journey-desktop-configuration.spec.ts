// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { expect, type Locator, type Page, type Request, type Route } from "@playwright/test";
import type { ConfigurationPreviewInput, ConfigurationRequestView } from "@sciencediscovery/schema";
import { test } from "./helpers/e2e.ts";
import { api, openDesktopSession, seedDesktopOrigin, startDesktopEntry, stopDesktopEntry } from "./helpers/desktop-evolve.ts";
import { cleanupJourney, createProjectAndSession, scriptedModel, type JourneyFixture } from "./helpers/journeys.ts";

const copy = {
  en: { title: "Configure timeouts", preview: "Refresh proposed changes", confirm: "Confirm",
    decline: "Cancel", saved: "Saved", scope: "All sessions · Subsequent runs", noLimit: "No timeout limit" },
  zh: { title: "调整超时", preview: "刷新修改方案", confirm: "确认",
    decline: "取消", saved: "已保存", scope: "所有会话 · 后续运行生效", noLimit: "不限制超时" },
};

// Actual browser hit testing catches narrow cards whose visible controls are
// clipped or covered. No screenshot substitute or mocked API response is used.
async function expectReachable(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  await expect.poll(() => control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.width > 0 && box.x >= -1 && box.right <= innerWidth + 1
      && box.y >= -1 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit));
  })).toBe(true);
}

// Closed compact cards must fit above the composer as a whole, not merely
// allow each action to be reached after scrolling a page-long card.
async function expectCompactCard(page: Page, card: Locator, labels: readonly string[], maxHeight = 300): Promise<number> {
  await expect(card).toHaveClass(/configuration-request-compact/);
  await expect(card.locator(".configuration-more, details")).toHaveCount(0);
  await expect(card.locator(".eyebrow:visible, .conversation-configuration-status:visible, .configuration-diff:visible")).toHaveCount(0);
  const explanationLines = await card.locator(".configuration-compact-scope, .configuration-compact-description").evaluateAll(elements => elements.reduce((lines, element) => {
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
    return lines + Math.round(element.getBoundingClientRect().height / lineHeight);
  }, 0));
  expect(explanationLines, "At most three directly visible explanation lines").toBeLessThanOrEqual(3);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect.poll(() => card.evaluate(element => ({
    height: element.getBoundingClientRect().height,
    fits: element.scrollWidth <= element.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1,
  }))).toEqual({ height: expect.any(Number), fits: true });
  const height = (await card.boundingBox())!.height;
  expect(height, `Compact card at ${page.viewportSize()!.width}px`).toBeLessThanOrEqual(maxHeight);
  const actions = labels.map(name => card.getByRole("button", { name, exact: true }));
  const boxes = [];
  for (const action of actions) {
    await expectReachable(action);
    const box = (await action.boundingBox())!;
    const coarsePointer = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    expect(box.height, `${await action.innerText()} pointer-appropriate target height`).toBeGreaterThanOrEqual(coarsePointer ? 44 : 32);
    expect(await action.evaluate(element => getComputedStyle(element).flexGrow), "Content-width action, not an expanding input row").toBe("0");
    boxes.push(box);
  }
  if (boxes.length > 1) expect(Math.abs(boxes[0]!.y - boxes[1]!.y), "Primary and cancel actions share one row").toBeLessThanOrEqual(1);
  if (boxes.length > 1) expect(boxes[0]!.x + boxes[0]!.width, "Action hit targets do not overlap").toBeLessThanOrEqual(boxes[1]!.x);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 1 });
  return height;
}

function expectReviewedPreview(before: ConfigurationRequestView, after: ConfigurationRequestView, field: string, value: string | number): void {
  expect(after.id).toBe(before.id);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.previewDigest).toEqual(expect.any(String));
  expect(after.previewDigest!.length).toBeGreaterThan(0);
  expect(after.previewDigest).not.toBe(before.previewDigest);
  expect(after.state).toBe("awaiting_confirmation");
  expect(after.fields.find(item => item.id === field)).toMatchObject({ value });
  expect(after.scope).toEqual(before.scope);
  expect(after.selectedOptionId).toBe(before.selectedOptionId);
  expect(after.allowedActions).toContain("apply");
  expect(after.choiceReceipt).toBeUndefined();
  expect(after.autoApplyAt).toBeUndefined();
}

// Measure the rendered boxes, not just CSS declarations: a fixed-height button
// can still paint a wrapped model label over the input and below the composer.
async function expectNarrowComposerContained(page: Page, modelName: string): Promise<void> {
  const composer = page.locator(".composer");
  await expect(composer).toBeInViewport({ ratio: 1 });
  await expect(composer.locator(".model-name")).toHaveText(modelName);
  await expect(composer.locator(".model-name")).toHaveAttribute("title", modelName);
  await expect.poll(() => composer.evaluate(element => {
    const box = element.getBoundingClientRect();
    const footer = element.querySelector(".composer-footer")!.getBoundingClientRect();
    const input = element.querySelector(".composer-input")!.getBoundingClientRect();
    const pill = element.querySelector(".composer-model-pill")!.getBoundingClientRect();
    const label = element.querySelector<HTMLElement>(".model-name")!;
    const inside = (child: DOMRect, parent: DOMRect) => child.width > 0 && child.height > 0
      && child.left >= parent.left - 1 && child.right <= parent.right + 1
      && child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1;
    return {
      footerInside: inside(footer, box),
      labelInsidePill: inside(label.getBoundingClientRect(), pill),
      controlsInsideFooter: [...element.querySelectorAll(".composer-plus, .composer-model-pill, .send-button-icon")]
        .every(control => inside(control.getBoundingClientRect(), footer)),
      clearOfInput: pill.top >= input.bottom - 1,
      longNameTruncated: label.scrollWidth > label.clientWidth,
    };
  })).toEqual({ footerInside: true, labelInsidePill: true, controlsInsideFooter: true, clearOfInput: true, longNameTruncated: true });
}

test.describe("Desktop configuration choices", { tag: ["@isolation:global", "@fixture:standard", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@status:reviewed"] }, () => {
  let entry: ChildProcess | undefined;
  test.beforeAll(async () => { entry = await startDesktopEntry(); });
  test.afterAll(async () => { await stopDesktopEntry(entry); });

  for (const locale of ["en", "zh"] as const) {
    /**
     * E2E-META
     * Purpose: Desktop users review and save a timeout choice, reload its receipt, and refuse later edits without changing saved settings.
     * Steps:
     *   1. Prepare an owned session and pending card through the real public API; open the desktop entry.
     *   2. Hold one real preview transport, keep typing into the focused input, then verify its serialized latest preview and compact wide/narrow layout.
     *   3. Reload and verify the saved setting and terminal receipt.
     *   4. Cancel an incomplete draft and a reviewed unlimited-timeout proposal; reload and verify neither changed the setting.
     *   5. Open a model connection in settings, close and reopen without applying; select an existing model inline.
     * Environment: Immutable compiled isolated API at E2E_BASE_URL; desktop Vite on 4178; pinned Chromium; English and Chinese at 1440x900 and 390x844.
     * Type: mocked
     * LLM: owned loopback stub for model-profile bootstrap only; no run submitted or provider call expected.
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none; non-local browser requests are blocked. One exact owned preview POST is delayed before route.continue; its request and backend response are not fabricated.
     * Credentials: E2E_API_TOKEN from the isolated stack; synthetic loopback model token only.
     * CostSideEffects: No paid services; restores isolated timeout settings and deletes owned Project/Session/model records in finally.
     */
    test(`${locale}: review, save and refuse desktop configuration`, { tag: "@mocked" }, async ({ page, journey }) => {
      test.setTimeout(120_000);
      journey.scenario({ goal: "Review a desktop configuration change before saving; cancelling later cards never saves their edits.",
        preconditions: ["Real compiled isolated API and desktop Vite entry", "No live models or services", `${locale}; desktop and narrow Chromium viewports; DPR 1`] });
      const words = copy[locale];
      const model = await scriptedModel([{ text: "Unexpected model call: this journey submits no run." }]);
      let fixture: JourneyFixture | undefined;
      let secondFixture: JourneyFixture | undefined;
      let baseline: Record<string, number> | undefined;
      let request: ConfigurationRequestView;
      let path = "";
      let next = 0;
      let reviewed: ConfigurationRequestView;
      let setupCatalogBefore: unknown;
      const browserDecisions: Request[] = [];
      page.on("request", request => {
        if (request.method() === "POST" && /\/configuration-requests\/[^/]+\/decision$/.test(new URL(request.url()).pathname)) browserDecisions.push(request);
      });
      try {
        await journey.step("1. Open a proposed timeout change", "The new desktop shows the pending configuration card in the selected language.", async () => {
          baseline = await api<Record<string, number>>(page, "/api/timeout-settings");
          next = baseline.runnerExecTimeoutMs === 92000 ? 94000 : 92000;
          const name = `Desktop configuration ${locale} ${randomUUID()}`;
          fixture = await createProjectAndSession(page, { projectName: name, sessionTitle: name, model: { apiToken: model.apiToken, baseUrl: model.baseUrl, model: model.model, name } });
          path = `/api/sessions/${encodeURIComponent(fixture.session.id)}/configuration-requests`;
          request = await api<ConfigurationRequestView>(page, path, { method: "POST", data: {
            protocolVersion: 3, capabilityId: "timeouts.configure", values: { runnerExecTimeoutMs: baseline.runnerExecTimeoutMs === next + 1000 ? next + 2000 : next + 1000 },
          } });
          await seedDesktopOrigin(page);
          await page.addInitScript(language => localStorage.setItem("sciencediscovery-desktop:locale", language), locale === "zh" ? "zh-CN" : "en");
          await page.setViewportSize({ width: 1440, height: 900 });
          await openDesktopSession(page, { ...fixture, modelOwned: true });
          const card = page.locator(`#configuration-request-${request.id}`);
          await expect(card.getByRole("heading", { name: words.title, exact: true })).toBeVisible();
          await expect(card.locator(".configuration-field")).toHaveCount(1);
          await expect(card.locator(".configuration-compact-scope")).toHaveText(words.scope);
          await expect(card.locator(".configuration-field p, .configuration-fields > p")).toHaveCount(0);
          const height = await expectCompactCard(page, card, [words.confirm, words.decline]);
          journey.note(`Actual ${locale} 1440px timeout card height: ${height}px, maximum 300px; the entire closed card is in view.`);
        });
        // Delay only this owned browser POST before forwarding it unchanged.
        // This is test-induced transport latency, not a fake preview/API result.
        const previewUrl = new URL(`${path}/${request!.id}/preview`, page.url()).href;
        const previewRequests: Request[] = [];
        const dispatchStates: Array<{ value: string; focused: boolean; enabled: boolean; confirmDisabled: boolean }> = [];
        const card = page.locator(`#configuration-request-${request!.id}`);
        const field = card.locator('input[name="runnerExecTimeoutMs"]');
        const confirm = card.getByRole("button", { name: words.confirm, exact: true });
        const partial = next / 1000;
        let releasePreview!: () => void;
        const previewBarrier = new Promise<void>(resolve => { releasePreview = resolve; });
        const holdFirstPreview = async (route: Route) => {
          if (route.request().method() !== "POST") { await route.continue(); return; }
          previewRequests.push(route.request());
          if (previewRequests.length === 1) await previewBarrier;
          else dispatchStates.push({ value: await field.inputValue(), focused: await field.evaluate(element => element === document.activeElement),
            enabled: await field.isEnabled(), confirmDisabled: await confirm.isDisabled() });
          await route.continue();
        };
        await page.route(previewUrl, holdFirstPreview);
        try {
          await journey.step("2. Keep typing during a delayed preview", "With the first real preview transport deliberately held, the focused input stays enabled, accepts all remaining digits and cannot confirm the partial value.", async () => {
            await field.fill(String(partial));
            await expect.poll(() => previewRequests.length).toBe(1);
            const input = previewRequests[0]!.postDataJSON() as ConfigurationPreviewInput;
            expect(input.expectedRevision).toBe(request.revision);
            expect(input.values.runnerExecTimeoutMs).toBe(partial);
            await expect(field).toBeFocused();
            await expect(field).toBeEnabled();
            // Real keys go to the currently focused control. Do not refocus the
            // field after dispatch, which could hide a dropped-focus regression.
            await page.keyboard.type("000", { delay: 80 });
            await expect(field).toHaveValue(String(next));
            await expect(field).toBeFocused();
            await expect(field).toBeEnabled();
            await expect(confirm).toBeDisabled();
            expect(previewRequests).toHaveLength(1);
            expect(await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).toEqual(request);
            expect(await api(page, "/api/timeout-settings")).toEqual(baseline);
            expect(browserDecisions).toHaveLength(0);
            expect(model.calls).toHaveLength(0);
            await expectCompactCard(page, card, [words.confirm, words.decline]);
            await expect(field).toBeFocused();
            journey.note(`Test-induced latency frame: only this request's first preview POST (${partial}) is held before route.continue. Actual focused input now contains ${next}; the API still exposes its original proposal. No response, screenshot or DOM content is fabricated; this is not normal-network timing evidence.`);
          });
          await journey.step("2b. Review the latest real preview, then resize", "Releasing the unchanged request permits a serialized preview of the full value using the advanced revision; the narrow card remains compact and no settings have been applied.", async () => {
            const firstResponse = page.waitForResponse(response => response.request() === previewRequests[0]);
            const latestResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url() === previewUrl
              && (response.request().postDataJSON() as ConfigurationPreviewInput).values.runnerExecTimeoutMs === next);
            releasePreview();
            const [first, latest] = await Promise.all([firstResponse, latestResponse]);
            expect(first.status()).toBe(200); expect(latest.status()).toBe(200);
            const firstView = await first.json() as ConfigurationRequestView;
            const responseView = await latest.json() as ConfigurationRequestView;
            expectReviewedPreview(request, firstView, "runnerExecTimeoutMs", partial);
            expect(previewRequests).toHaveLength(2);
            const latestInput = previewRequests[1]!.postDataJSON() as ConfigurationPreviewInput;
            expect(latestInput.expectedRevision).toBe(firstView.revision);
            expect(latestInput.values).toEqual({ ...Object.fromEntries(request.fields.flatMap(item => item.kind !== "credential" && item.value !== undefined
              ? [[item.id, item.value]] : [])), runnerExecTimeoutMs: next });
            expect(dispatchStates).toEqual([{ value: String(next), focused: true, enabled: true, confirmDisabled: true }]);
            reviewed = await api<ConfigurationRequestView>(page, `${path}/${request.id}`);
            expectReviewedPreview(firstView, reviewed, "runnerExecTimeoutMs", next);
            expect(reviewed.revision).toBe(responseView.revision);
            expect(reviewed.previewDigest).toBe(responseView.previewDigest);
            expect(reviewed.changes).toEqual([{ field: "runnerExecTimeoutMs", before: String(baseline!.runnerExecTimeoutMs), after: String(next) }]);
            await expect(field).toHaveValue(String(next));
            await expect(field).toBeFocused();
            await expect(field).toBeEnabled();
            await expect(confirm).toBeEnabled();
            await expect(card.getByRole("button", { name: words.preview, exact: true })).toHaveCount(0);
            await page.setViewportSize({ width: 390, height: 844 });
            await expect(field).toHaveValue(String(next));
            await expectReachable(field);
            const height = await expectCompactCard(page, card, [words.confirm, words.decline]);
            await expectNarrowComposerContained(page, fixture!.model!.name);
            expect(await api(page, "/api/timeout-settings")).toEqual(baseline);
            expect(browserDecisions).toHaveLength(0);
            expect(model.calls).toHaveLength(0);
            journey.note(`Actual ${locale} 390px timeout card height: ${height}px, maximum 300px. Real preview revisions advanced ${request.revision} → ${firstView.revision} → ${reviewed.revision}; the second request used the first response's revision and full ${next} value. Formal settings and model-call count remain unchanged.`);
          });
        } finally {
          // Unblock a failed assertion too, then remove only this exact handler.
          releasePreview();
          await page.unroute(previewUrl, holdFirstPreview);
        }
        await journey.step("3. Inspect the short decision card", "The reviewed value and essential scope are visible with no hidden long details and no settings mutation.", async () => {
          const card = page.locator(`#configuration-request-${request.id}`);
          await expect(card.locator("details, .configuration-more")).toHaveCount(0);
          await expect(card.locator('input[name="runnerExecTimeoutMs"]')).toHaveValue(String(next));
          await expectCompactCard(page, card, [words.confirm, words.decline]);
          await expectNarrowComposerContained(page, fixture!.model!.name);
          expect(await api(page, "/api/timeout-settings")).toEqual(baseline);
          expect(browserDecisions).toHaveLength(0);
        });
        await journey.step("4. Confirm and reload the saved receipt", "The saved receipt and setting survive reload; the pending card is no longer actionable.", async () => {
          await page.locator(`#configuration-request-${request.id}`).getByRole("button", { name: words.confirm, exact: true }).click();
          await expect.poll(async () => (await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).state).toBe("applied");
          expect(browserDecisions).toHaveLength(1);
          expect(browserDecisions[0]!.postDataJSON()).toEqual({ decision: "apply", revision: reviewed.revision,
            previewDigest: reviewed.previewDigest, selectedOptionId: reviewed.selectedOptionId });
          const applied = await api<ConfigurationRequestView>(page, `${path}/${request.id}`);
          expect(applied.choiceReceipt).toMatchObject({ configurationWritten: true, scope: "global" });
          await page.reload();
          const receipt = page.locator(".conversation-configuration-record");
          await expect(receipt).toContainText(words.saved);
          await expect(receipt).toContainText(words.title);
          await expect(page.locator(`#configuration-request-${request.id}`)).toHaveCount(0);
          expect((await api<Record<string, number>>(page, "/api/timeout-settings")).runnerExecTimeoutMs).toBe(next);
        });
        for (const index of [0, 1]) {
          await journey.step(`${5 + index}. Cancel ${index === 0 ? "an incomplete draft" : "a reviewed unlimited-timeout proposal"}`, "The explicit Cancel action records refusal after reload and preserves the previously saved setting.", async () => {
            const saved = await api(page, "/api/timeout-settings");
            request = await api<ConfigurationRequestView>(page, path, { method: "POST", data: {
              protocolVersion: 3, capabilityId: "timeouts.configure", values: { runnerExecTimeoutMs: next + 2000 },
            } });
            await page.reload();
            await page.setViewportSize(index === 0 ? { width: 390, height: 844 } : { width: 1440, height: 900 });
            const card = page.locator(`#configuration-request-${request.id}`);
            const field = card.locator('input[name="runnerExecTimeoutMs"]');
            if (index === 0) {
              await field.fill("");
              await expect(card.getByRole("button", { name: words.confirm, exact: true })).toBeDisabled();
            } else {
              await field.fill("0"); await field.press("Tab");
              await expect(card.getByText(words.noLimit, { exact: true })).toBeVisible();
              await expect.poll(async () => (await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).revision).toBeGreaterThan(request.revision);
              await expect(card.getByRole("button", { name: words.confirm, exact: true })).toBeEnabled();
              expectReviewedPreview(request, await api<ConfigurationRequestView>(page, `${path}/${request.id}`), "runnerExecTimeoutMs", 0);
            }
            expect(await api(page, "/api/timeout-settings")).toEqual(saved);
            await expectReachable(card.getByRole("button", { name: words.decline, exact: true }));
            await card.getByRole("button", { name: words.decline, exact: true }).click();
            await expect.poll(async () => (await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).state).toBe("dismissed");
            await page.reload();
            await expect(page.locator(`#configuration-request-${request.id}`)).toHaveCount(0);
            await expect(page.locator(".conversation-configuration-record")).toHaveCount(2 + index);
            expect(await api(page, "/api/timeout-settings")).toEqual(saved);
          });
        }
        await journey.step("7. Review the compact model setup request", "The complex request is a short navigation card, with no inline model configuration form.", async () => {
          setupCatalogBefore = await api(page, "/api/models");
          request = await api<ConfigurationRequestView>(page, path, { method: "POST", data: { protocolVersion: 3, capabilityId: "model.connect", values: {} } });
          await page.reload();
          await page.setViewportSize({ width: 390, height: 844 });
          const card = page.locator(`.conversation #configuration-request-${request.id}`);
          await expect(card.locator("input, p, details")).toHaveCount(0);
          await expect(card.getByRole("button")).toHaveCount(1);
          await expectCompactCard(page, card, [locale === "zh" ? "前往设置" : "Open settings"]);
        });
        await journey.step("8. Open the original model settings page", "Navigation opens the unchanged model list and Add model control, without injecting a request editor or saving anything.", async () => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.locator(`.conversation #configuration-request-${request.id}`).getByRole("button", { name: locale === "zh" ? "前往设置" : "Open settings", exact: true }).click();
          const settings = page.getByRole("dialog");
          await expect(settings.getByRole("button", { name: locale === "zh" ? "添加模型" : "Add model", exact: true })).toBeVisible();
          await expect(settings.locator(".configuration-settings-context, .configuration-request")).toHaveCount(0);
          await expect(settings.getByRole("button", { name: locale === "zh" ? "返回对话" : "Back to conversation", exact: true })).toHaveCount(0);
          expect(await api(page, "/api/models")).toEqual(setupCatalogBefore);
          expect((await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).state).toBe(request.state);
        });
        await journey.step("8b. Inspect the original settings at narrow width", "The original settings page remains reachable without an injected form or navigation controls.", async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          const settings = page.getByRole("dialog");
          await expectReachable(settings.getByRole("button", { name: locale === "zh" ? "添加模型" : "Add model", exact: true }));
          await expect(settings.locator(".configuration-settings-context, .configuration-request")).toHaveCount(0);
          expect((await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).state).toBe(request.state);
        });
        await journey.step("9. Return to the manual settings confirmation", "Closing and reloading retains a card asking whether the settings were changed; opening alone does not settle it.", async () => {
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0);
          const card = page.locator(`.conversation #configuration-request-${request.id}`);
          await expect(card).toContainText(locale === "zh" ? "是否已完成修改？" : "Have you finished changing these settings?");
          await page.reload();
          await expect(card).toContainText(locale === "zh" ? "是否已完成修改？" : "Have you finished changing these settings?");
          await expect(card.locator("details")).toHaveCount(0);
          await expect(card.getByRole("button")).toHaveCount(2);
          expect((await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).state).toBe(request.state);
          expect(await api(page, "/api/models")).toEqual(setupCatalogBefore);
        });
        await journey.step("10. Record that settings were not changed", "An explicit answer produces a durable compact destination/outcome label without writing settings or invoking Apply.", async () => {
          const card = page.locator(`.conversation #configuration-request-${request.id}`);
          await card.getByRole("button", { name: locale === "zh" ? "未完成修改" : "Not changed", exact: true }).click();
          const label = locale === "zh" ? "已打开设置 · 模型设置 · 未完成修改" : "Settings opened · Model settings · Not changed";
          await expect(card.locator("summary .collapse-title")).toHaveText(label);
          await expect(card.locator("details")).not.toHaveAttribute("open");
          expect((await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).settingsConfirmation).toMatchObject({ destination: "models", completed: false, verified: false, configurationWritten: false });
          await page.reload();
          await expect(card.locator("summary .collapse-title")).toHaveText(label);
          expect(await api(page, "/api/models")).toEqual(setupCatalogBefore);
          expect(browserDecisions.filter(call => new URL(call.url()).pathname === `${path}/${request.id}/decision`)).toHaveLength(0);
          expect(model.calls).toHaveLength(0);
        });
        let siblingBefore: unknown, catalogBefore: unknown, globalBefore: unknown, sessionBefore: unknown;
        await journey.step("11. Choose an existing model and review its preview", "The short selector stays in the conversation. Its new preview is ready for confirmation, but no session/global/catalog setting has been saved yet.", async () => {
          secondFixture = await createProjectAndSession(page, { projectName: `Other model ${randomUUID()}`, sessionTitle: "Unchanged sibling", model: { apiToken: model.apiToken, baseUrl: model.baseUrl, model: model.model, name: `Second model ${randomUUID()}` } });
          siblingBefore = await api(page, `/api/sessions/${secondFixture.session.id}/settings`);
          sessionBefore = await api(page, `/api/sessions/${fixture!.session.id}/settings`);
          catalogBefore = await api(page, "/api/models");
          globalBefore = await api(page, "/api/settings");
          request = await api<ConfigurationRequestView>(page, path, { method: "POST", data: { protocolVersion: 3, capabilityId: "model.select", values: {} } });
          // Boot resumes the newest session, which is now the sibling. Return
          // explicitly to the session that owns this configuration request.
          // The sidebar is CSS-hidden at 390px. Select through the visible
          // desktop sidebar first, then test the card itself at narrow width.
          await page.setViewportSize({ width: 1440, height: 900 });
          await openDesktopSession(page, { ...fixture!, modelOwned: true });
          await page.setViewportSize({ width: 390, height: 844 });
          const card = page.locator(`#configuration-request-${request.id}`);
          await expect(card.locator('select[name="modelId"]')).toBeVisible();
          await card.locator('select[name="modelId"]').selectOption(secondFixture.model!.id);
          await expect.poll(async () => (await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).revision).toBeGreaterThan(request.revision);
          reviewed = await api<ConfigurationRequestView>(page, `${path}/${request.id}`);
          expectReviewedPreview(request, reviewed, "modelId", secondFixture.model!.id);
          await expect(card.getByRole("button", { name: words.confirm, exact: true })).toBeEnabled();
          await expectCompactCard(page, card, [words.confirm, words.decline]);
          await expectReachable(card.getByRole("button", { name: words.confirm, exact: true }));
          await expect(card.getByRole("button", { name: locale === "zh" ? "前往设置" : "Open settings", exact: true })).toHaveCount(0);
          await expect(page.getByRole("dialog")).toHaveCount(0);
          expect(await api(page, `/api/sessions/${fixture!.session.id}/settings`)).toEqual(sessionBefore);
          expect(await api(page, "/api/models")).toEqual(catalogBefore);
          expect(await api(page, "/api/settings")).toEqual(globalBefore);
          expect(model.calls).toHaveLength(0);
        });
        await journey.step("12. Confirm the session-only model choice", "The saved choice affects this session's future runs; global settings, model catalog and the sibling session remain unchanged.", async () => {
          await page.locator(`#configuration-request-${request.id}`).getByRole("button", { name: words.confirm, exact: true }).click();
          await expect.poll(async () => (await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).state).toBe("applied");
          expect(await api(page, "/api/models")).toEqual(catalogBefore);
          expect(await api(page, "/api/settings")).toEqual(globalBefore);
          expect(browserDecisions.at(-1)!.postDataJSON()).toEqual({ decision: "apply", revision: reviewed.revision,
            previewDigest: reviewed.previewDigest, selectedOptionId: reviewed.selectedOptionId });
          const session = await api<{ effective: { modelId: string } }>(page, `/api/sessions/${fixture!.session.id}/settings`);
          expect(session.effective.modelId).toBe(secondFixture!.model!.id);
          expect(await api(page, `/api/sessions/${secondFixture!.session.id}/settings`)).toEqual(siblingBefore);
          await page.setViewportSize({ width: 1440, height: 900 });
          // A full navigation reloads receipts; select the owner rather than
          // assuming boot chooses it over the newly created sibling session.
          await openDesktopSession(page, { ...fixture!, modelOwned: true });
          await expect(page.locator(`#configuration-request-${request.id}`)).toHaveCount(0);
          // Four terminal configuration receipts plus the separate navigation
          // self-report receipt, which must not be mistaken for a saved configuration.
          await expect(page.locator(".conversation-configuration-record")).toHaveCount(5);
          await expect(page.locator("[data-configuration-navigation-record] .conversation-configuration-record")).toHaveCount(1);
          expect((await api<ConfigurationRequestView>(page, `${path}/${request.id}`)).choiceReceipt).toMatchObject({ configurationWritten: true, scope: "session" });
          expect((await api<{ effective: { modelId: string } }>(page, `/api/sessions/${fixture!.session.id}/settings`)).effective.modelId).toBe(secondFixture!.model!.id);
        });
        expect(model.calls, "No model execution is necessary to configure timeouts or model settings").toHaveLength(0);
        expect(await api(page, `/api/sessions/${fixture!.session.id}/runs`)).toEqual([]);
        expect(await api(page, `/api/sessions/${secondFixture!.session.id}/runs`)).toEqual([]);
      } finally {
        try {
          if (baseline) await api(page, "/api/timeout-settings", { method: "PUT", data: baseline });
        } finally {
          try { if (fixture) await cleanupJourney(page, fixture); if (secondFixture) await cleanupJourney(page, secondFixture); }
          finally { await model.stop(); }
        }
      }
    });
  }
});
