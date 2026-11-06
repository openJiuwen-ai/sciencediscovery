// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect, type Locator, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { BROWSER_TOKEN_STORAGE_KEY, requireApiToken } from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("gateway-token-recovery.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@sandbox:bubblewrap"] }, () => {

/**
 * Recovering from a rejected access token.
 *
 * The stack generates its access token on first start, so a browser that has
 * never been given one is rejected and must be handed the Connection settings.
 * Authentication failures are owned by that dialog rather than by the
 * notification column, so the footer the user needs to click stays reachable
 * even after the user saves a wrong token first.
 *
 * The access token comes from the shared `E2E_API_TOKEN` wiring like every other
 * spec; a missing one already failed the run in the global setup.
 */
const WRONG_TOKEN = "e2e-wrong-token";

const connectionDialog = (page: Page): Locator => page.locator("section.system-config-dialog[role='dialog']");
const saveAndClose = (page: Page): Locator => page.getByRole("button", { name: "Save and close" });
const toasts = (page: Page): Locator => page.locator(".toast-viewport .toast");
const TOKEN_LABEL = "Local service access token";
const REJECTED_TITLE = "Local service access token rejected";

/** What the user's pointer would actually reach at the button's centre. */
async function saveButtonIsReachable(page: Page): Promise<boolean> {
  const box = await saveAndClose(page).boundingBox();
  if (!box) return false;
  return await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target?.closest("button") !== null && target?.closest(".toast-viewport") === null;
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

async function saveToken(page: Page, token: string): Promise<void> {
  await page.getByLabel(TOKEN_LABEL).fill(token);
  await saveAndClose(page).click({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  // English keeps the selectors stable wherever this runs. The suite seeds the
  // access token into every context; this is the one spec that must start from
  // the real cold-start state, so it clears that key again on every navigation.
  await page.addInitScript((tokenKey) => {
    window.localStorage.setItem("sciencediscovery-locale", "en");
    window.localStorage.removeItem(tokenKey);
  }, BROWSER_TOKEN_STORAGE_KEY);
});

/**
 * E2E-META
 * Purpose: 冷启动没有 token 时由 Connection settings 接管，不被逐请求的未授权通知淹没，且底部保存按钮可点。
 * Steps:
 *   1. 清空浏览器 token 后打开首页。
 *   2. 断言连接对话框说明需要粘贴本地访问 token，且没有 rejected 结论。
 *   3. 断言没有 Unauthorized 通知，Save and close 在指针命中范围内。
 * Environment: 隔离本地栈；浏览器在每个测试前清空 localStorage 中的 token。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 页面请求只指向本地栈。
 * Credentials: 本用例刻意不提供 token；正确值来自隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none
 */
test("a cold start with no token opens Connection settings without burying its footer", { tag: "@mocked" }, async ({ page }) => {
  await page.goto("/");

  await expect(connectionDialog(page)).toBeVisible();
  // With no stored token at all the panel explains how to connect; the
  // "rejected" verdict belongs to a wrong token the user actually saved.
  await expect(connectionDialog(page).getByRole("status")).toContainText("paste the local service access token");
  await expect(connectionDialog(page).getByText(REJECTED_TITLE)).toHaveCount(0);
  // Every startup request fails at once, but they stack no toast per request.
  await expect(toasts(page).filter({ hasText: "Unauthorized" })).toHaveCount(0);
  expect(await saveButtonIsReachable(page)).toBe(true);
});

/**
 * E2E-META
 * Purpose: 先保存错误 token 再保存正确 token 可以原地恢复，中途不产生通知堆积，也不需要手动清理状态。
 * Steps:
 *   1. 冷启动打开连接对话框并记录当前通知数量。
 *   2. 保存错误 token，断言对话框返回并显示 rejected，通知数量不增长，保存按钮仍可点。
 *   3. 保存正确 token，断言对话框与 rejected 提示都消失。
 * Environment: 隔离本地栈；浏览器从无 token 的冷启动状态开始。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 页面请求只指向本地栈。
 * Credentials: 一个故意错误的本地 token 与隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none
 */
test("a wrong token then the right one recovers without clearing notifications", { tag: "@mocked" }, async ({ page }) => {
  await page.goto("/");
  await expect(connectionDialog(page)).toBeVisible();
  const initialToasts = await toasts(page).count();

  await saveToken(page, WRONG_TOKEN);

  // The wrong token is rejected too: the dialog comes back and says why.
  await expect(connectionDialog(page)).toBeVisible();
  await expect(page.getByText(REJECTED_TITLE)).toBeVisible();
  // Another round of failures adds no notifications: the dialog is the feedback.
  await expect(toasts(page)).toHaveCount(initialToasts);
  await expect(toasts(page).filter({ hasText: "Unauthorized" })).toHaveCount(0);
  expect(await saveButtonIsReachable(page)).toBe(true);

  // The whole point: correcting the token works with no manual clean-up in
  // between, and the rejection state clears with it.
  await saveToken(page, requireApiToken());

  await expect(connectionDialog(page)).toBeHidden();
  await expect(page.getByText(REJECTED_TITLE)).toBeHidden();
});

/**
 * E2E-META
 * Purpose: 390×844 窄屏下拒绝与恢复流程仍然可操作：对话框底部保存按钮不被覆盖，错误 token 后仍能原地恢复。
 * Steps:
 *   1. 390×844 冷启动打开首页，断言连接对话框出现。
 *   2. 保存错误 token，断言对话框返回且保存按钮仍可点。
 *   3. 保存正确 token，断言对话框消失。
 * Environment: 隔离本地栈；浏览器在每个测试前清空 localStorage 中的 token；390×844 视口。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 页面请求只指向本地栈。
 * Credentials: 一个故意错误的本地 token 与隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none
 */
test("the recovery dialog stays operable on a narrow viewport", { tag: "@mocked" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(connectionDialog(page)).toBeVisible();

  await saveToken(page, WRONG_TOKEN);

  await expect(connectionDialog(page)).toBeVisible();
  expect(await saveButtonIsReachable(page)).toBe(true);

  await saveToken(page, requireApiToken());

  await expect(connectionDialog(page)).toBeHidden();
});

});
