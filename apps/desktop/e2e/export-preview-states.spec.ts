/**
 * E2E-META
 * Purpose: Show, in both interface languages, that the desktop export dialog keeps its estimate visible but refuses to export from a stale preview, explains a revision-change failure, and re-warns after a changed over-cap selection — with the size limit the product really computes.
 * Steps:
 *   1. In zh, open 导出会话 after unticking a file while the recalculation keeps answering EXPORT_PREVIEW_PENDING; assert the stalled notice, the retained estimate and a disabled 开始导出, then capture the frame.
 *   2. Repeat step 1 in en with the same fixture, viewport and selection, and capture the English frame.
 *   3. In zh, export a conversation whose task fails with the revision-change sentence; assert the alert and the failed row lead with the localized copy and the server text sits under 技术细节, then capture the frame.
 *   4. Repeat step 3 in en and capture the English revision-change sentence.
 *   5. In zh, acknowledge an over-limit selection that the product's own default cap (5 GiB) makes over-cap, change the file set and assert the warning and the gate come back, then capture the frame.
 *   6. Repeat step 5 in en with the same numbers, assert the English limit and over-limit sentences, and capture the frame.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks; viewport 1440×900; Chinese and English UI.
 * Type: mocked
 * LLM: none; no model call is made.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; the mock answers every /api/ request.
 * Credentials: none beyond the fixture's local token.
 * CostSideEffects: none; local fixtures only.
 */
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { CREATED_AT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

const LOCALE_KEY = "sciencediscovery-desktop:locale";

const messages = [
  { id: "u1", role: "user", content: "上文问题", createdAt: CREATED_AT },
  { id: "a1", role: "assistant", content: "中间回复", createdAt: CREATED_AT },
  { id: "u2", role: "user", content: "下文问题", createdAt: CREATED_AT },
  { id: "a2", role: "assistant", content: "下文结论", createdAt: CREATED_AT },
];

const REVISION_SENTENCE = "会话内容已更新，请使用最新大小预览重新导出。";
const LOCALIZED_ZH = "会话内容已更新，请先重新计算大小预览，再重新导出。";
const LOCALIZED_EN = "The conversation has changed. Recalculate the size preview, then export again.";

/**
 * The cap the service reports as `maxBytes`, at the value a deployment really
 * uses: `RESEARCH_PACKAGE_DEFAULT_MAX_BYTES` (packages/research-package/src/index.ts:39)
 * is 5 GiB, and `SCIENCE_AGENT_RESEARCH_PACKAGE_MAX_BYTES` may only move it
 * between 64 MiB and 8 GiB − 1. The previous fixture invented a 1 MiB cap, so
 * the over-cap frame printed a limit no deployment can produce.
 *
 * The spec supplies only the bytes; the dialog renders them through its own
 * `formatBytes` (apps/desktop/src/app/format-bytes.ts: KB/MB/GB, one decimal),
 * so the assertions below pin the strings the product prints for these sizes:
 * 5 GiB → "5.0 GB", 6 GiB → "6.0 GB".
 */
const CAP_BYTES = 5 * 1024 * 1024 * 1024;
const OVER_CAP_BYTES = 6 * 1024 * 1024 * 1024;
const CAP_TEXT = "5.0 GB";
const OVER_CAP_TEXT = "6.0 GB";

const files = [
  { path: "results.csv", size: 123, selected: true },
  { path: "notes.md", size: 45, selected: true },
];

async function openExportDialog(page: Page, locale: "zh" | "en") {
  await page.getByRole("button", { name: locale === "en" ? "Session menu" : "会话菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: locale === "en" ? "Export conversation" : "导出会话" }).click();
  const dialog = page.getByRole("dialog", { name: locale === "en" ? "Export conversation" : "导出会话" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath(name) });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: a stalled recalculation keeps the estimate but cannot authorize the export`, async ({ page }, testInfo) => {
    const en = locale === "en";
    await page.setViewportSize({ width: 1440, height: 900 });
    if (en) await page.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_KEY);
    await installMockApi(page, { sessions: [makeSession({ messages })] });
    // The first preview describes the default file set; every recalculation of an
    // explicit file set keeps answering "pending", so the dialog has to stop
    // authorizing the export even though the last estimate stays visible (#1440).
    await page.route("**/research-package/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/preview")) {
        if (url.searchParams.has("customFiles")) {
          return route.fulfill({ status: 409, json: { error: "Export preview is pending", code: "EXPORT_PREVIEW_PENDING" } });
        }
        return route.fulfill({
          json: {
            revision: "revision-1",
            estimatedBytes: url.searchParams.get("level") === "complete" ? 40 * 1024 : 30 * 1024,
            files,
            omissions: [],
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: "not part of this journey" } });
    });

    await page.goto("/");
    const dialog = await openExportDialog(page, locale);
    await expect(dialog.locator(".research-file-grid")).toBeVisible();
    const start = dialog.getByRole("button", { name: en ? "Start export" : "开始导出", exact: true });
    await expect(start).toBeEnabled();

    await dialog.locator(".research-file-grid input[type=checkbox]").first().uncheck();
    // Six pending answers at 1.5 s each: the dialog gives up and says so.
    await expect(dialog.locator(".research-package-pending")).toBeVisible({ timeout: 20_000 });
    await expect(dialog.locator(".research-package-pending")).toContainText(
      en ? "The size preview is taking unusually long" : "大小预览迟迟没有完成",
    );
    await expect(dialog.getByRole("button", { name: en ? "Recalculate size" : "重新计算大小", exact: true })).toBeVisible();
    await expect(dialog.locator(".research-package-selected-size")).toContainText("30.0 KB");
    await expect(dialog.getByText(en ? "Not included: 1 workspace file" : "未包含 1 个工作区文件")).toBeVisible();
    await expect(start).toBeDisabled();

    await screenshot(page, testInfo, `01-stalled-recalculation-${locale}.png`);
  });
}

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: a revision-change failure reaches the alert and the failed row in the interface language`, async ({ page }, testInfo) => {
    const en = locale === "en";
    await page.setViewportSize({ width: 1440, height: 900 });
    if (en) await page.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_KEY);
    await installMockApi(page, { sessions: [makeSession({ messages })] });
    // The server wording is the same in both runs; only the dialog's own sentence
    // follows the interface language.
    const serverSentence = REVISION_SENTENCE;
    const localized = en ? LOCALIZED_EN : LOCALIZED_ZH;
    await page.route("**/research-package/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/preview")) {
        return route.fulfill({ json: { revision: "revision-1", estimatedBytes: 30 * 1024, files, omissions: [] } });
      }
      if (url.pathname.endsWith("/exports")) {
        return route.fulfill({
          json: { id: "export-revision", status: "failed", filename: "conversation.sdresearch", error: serverSentence },
        });
      }
      return route.fulfill({ status: 404, json: { error: "not part of this journey" } });
    });

    await page.goto("/");
    const dialog = await openExportDialog(page, locale);
    const start = dialog.getByRole("button", { name: en ? "Start export" : "开始导出", exact: true });
    await expect(start).toBeEnabled();
    await start.click();

    const toast = page.locator(".research-toast.is-error .research-toast-text");
    await expect(toast).toHaveText(localized);
    await expect(toast).not.toContainText(en ? "Operation failed" : "操作失败");

    // Reopen to read the failed row the same way the user would.
    const reopened = await openExportDialog(page, locale);
    const row = reopened.locator(".research-package-saved-row", { hasText: "conversation.sdresearch" });
    await expect(row.locator(".is-error")).toHaveText(localized);
    const raw = row.locator("details.research-package-raw");
    await raw.locator("summary").click();
    await expect(raw.locator("code")).toHaveText(serverSentence);

    await screenshot(page, testInfo, `02-revision-change-failure-${locale}.png`);
  });
}

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: an acknowledged over-cap selection is warned about again after the file set changes`, async ({ page }, testInfo) => {
    const en = locale === "en";
    await page.setViewportSize({ width: 1440, height: 900 });
    if (en) await page.addInitScript((key) => localStorage.setItem(key, "en"), LOCALE_KEY);
    await installMockApi(page, { sessions: [makeSession({ messages })] });
    // A selection those same workspace files could really grow to, reported
    // against the cap the service itself defaults to.
    await page.route("**/research-package/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/preview")) {
        return route.fulfill({
          json: {
            revision: "revision-1",
            estimatedBytes: OVER_CAP_BYTES,
            archiveBytes: OVER_CAP_BYTES,
            maxBytes: CAP_BYTES,
            files,
            omissions: [],
          },
        });
      }
      return route.fulfill({ status: 404, json: { error: "not part of this journey" } });
    });

    await page.goto("/");
    const dialog = await openExportDialog(page, locale);
    const limit = dialog.locator(".research-package-limit");
    const start = dialog.getByRole("button", { name: en ? "Start export" : "开始导出", exact: true });
    const confirmed = en
      ? "Over-limit export confirmed."
      : "已确认超限导出。";
    await expect(limit).toBeVisible();
    // Both numbers come from the dialog's own formatter over the bytes above.
    await expect(dialog.getByText(en ? `Uncompressed limit: ${CAP_TEXT}` : `未压缩上限：${CAP_TEXT}`)).toBeVisible();
    await expect(limit).toContainText(
      en
        ? `This selection is ${OVER_CAP_TEXT} uncompressed, over the ${CAP_TEXT} limit.`
        : `当前选择未压缩为 ${OVER_CAP_TEXT}，超过上限 ${CAP_TEXT}。`,
    );
    await expect(start).toBeDisabled();

    await limit.getByRole("button", { name: en ? "Export anyway" : "仍要导出", exact: true }).click();
    await expect(dialog.getByText(confirmed, { exact: false })).toBeVisible();
    await expect(start).toBeEnabled();

    await dialog.locator(".research-file-grid input[type=checkbox]").first().uncheck();
    await expect(limit).toBeVisible();
    await expect(dialog.getByText(confirmed, { exact: false })).toHaveCount(0);
    await expect(start).toBeDisabled();

    await screenshot(page, testInfo, `03-over-limit-reacknowledged-${locale}.png`);
  });
}
