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

import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-143-proxy-settings.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@sandbox:bubblewrap"] }, () => {

const screenshotDirectory = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";

async function openProxySettings(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  // Bootstrap selects a default Session after rendering the shell and closes
  // navigation on selection. Open the drawer only after that public route settles.
  await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/?]+(?:\?.*)?$/);
  // Below the 1024px breakpoint the sidebar is an off-canvas drawer: open it
  // before reaching for its entries.
  const drawerToggle = page.getByRole("button", { name: "Open navigation" });
  if (await drawerToggle.isVisible()) {
    await drawerToggle.click();
    await expect(page.locator(".sidebar-drawer-toggle")).toHaveAttribute("aria-expanded", "true");
  }
  await page.getByRole("button", { name: "System configuration" }).click();
  const configuration = page.getByRole("dialog", { name: "System configuration" });
  // The settings directory folds behind its toggle at the same breakpoint, so
  // open it before reaching for a group entry.
  const settingsNavigation = configuration.getByRole("navigation", { name: "Setting groups" });
  if (!(await settingsNavigation.isVisible())) {
    await configuration.getByRole("button", { name: /^Settings directory/ }).click();
  }
  await configuration.getByRole("button", { name: "Network proxies" }).click();
  await expect(configuration.getByRole("heading", { name: "Network proxies" })).toBeVisible();
  return configuration;
}

async function captureFormGeometry(form: Locator) {
  const input = await form.getByRole("textbox", { name: "Proxy URL", exact: true }).boundingBox();
  const cancel = await form.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
  const save = await form.getByRole("button", { name: "Add", exact: true }).boundingBox();
  if (!input || !cancel || !save) throw new Error("Proxy form controls must have measurable geometry");
  return {
    cancelTop: cancel.y,
    inputTop: input.y,
    saveTop: save.y,
    scrollHeight: await form.evaluate((element) => element.scrollHeight),
  };
}

function expectStableGeometry(before: Awaited<ReturnType<typeof captureFormGeometry>>, after: Awaited<ReturnType<typeof captureFormGeometry>>) {
  expect(Math.abs(after.inputTop - before.inputTop)).toBeLessThan(1);
  expect(Math.abs(after.cancelTop - before.cancelTop)).toBeLessThan(1);
  expect(Math.abs(after.saveTop - before.saveTop)).toBeLessThan(1);
  expect(Math.abs(after.scrollHeight - before.scrollHeight)).toBeLessThan(1);
}

async function expectOverlayWithinDialogAndViewport(page: Page, dialog: Locator, overlay: Locator) {
  const overlayBox = await overlay.boundingBox();
  const dialogBox = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (!overlayBox || !dialogBox || !viewport) throw new Error("Tooltip, dialog, and viewport must have measurable geometry");
  expect(overlayBox.x).toBeGreaterThanOrEqual(Math.max(0, dialogBox.x) - 1);
  expect(overlayBox.y).toBeGreaterThanOrEqual(Math.max(0, dialogBox.y) - 1);
  expect(overlayBox.x + overlayBox.width).toBeLessThanOrEqual(Math.min(viewport.width, dialogBox.x + dialogBox.width) + 1);
  expect(overlayBox.y + overlayBox.height).toBeLessThanOrEqual(Math.min(viewport.height, dialogBox.y + dialogBox.height) + 1);
}

/**
 * E2E-META
 * Purpose: 代理设置把默认代理与注册表放在最前，URL 格式帮助稳定可操作，且 WebSearch 代理策略只有一处入口。
 * Steps:
 *   1. 在系统设置中打开 Network proxies。
 *   2. 断言 Default proxy 位于 Proxy server list 之前，旧式 URL 指南入口不存在。
 *   3. 打开添加表单，展开 URL 格式帮助，断言内容、表单几何稳定与浮层边界。
 *   4. 断言帮助可悬停、聚焦、Escape 与点击切换，并在 environment/system 类型下隐藏。
 *   5. 断言 WebSearch proxy 只在此页出现，Web providers 页只给出指向说明。
 * Environment: 隔离本地栈，浏览器 egress 仅限 127.0.0.1。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 只读本地设置页，不发起真实代理连接。
 * Credentials: 隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none — 用例只打开表单后取消。
 */
test("proxy settings put defaults and registry first and expose one WebSearch policy", { tag: "@mocked" }, async ({ page }) => {
  const configuration = await openProxySettings(page);
  const defaultHeading = configuration.getByRole("heading", { name: "Default proxy" });
  const serversHeading = configuration.getByRole("heading", { name: "Proxy server list" });
  await expect(defaultHeading).toBeVisible();
  await expect(serversHeading).toBeVisible();
  const defaultBox = await defaultHeading.boundingBox();
  const serversBox = await serversHeading.boundingBox();
  expect(defaultBox?.y).toBeLessThan(serversBox?.y ?? 0);

  await expect(configuration.getByText("http_proxy / HTTP_PROXY", { exact: true })).toBeVisible();
  await expect(configuration.locator(".proxy-url-guide")).toHaveCount(0);
  await expect(configuration.getByRole("button", { name: "Show proxy URL format help" })).toHaveCount(0);
  await expect(configuration.getByLabel("Add proxy server")).toHaveCount(0);
  await configuration.getByRole("button", { name: "Add proxy server" }).click();
  const form = configuration.getByRole("form", { name: "Add proxy server" });
  await expect(form).toBeVisible();
  await expect(form).toHaveClass(/proxy-server-form/);
  const guideTrigger = form.getByRole("button", { name: "Show proxy URL format help" });
  const guide = form.getByRole("tooltip");
  await expect(guideTrigger).toBeVisible();
  await guideTrigger.scrollIntoViewIfNeeded();
  const closedGeometry = await captureFormGeometry(form);
  const triggerVisual = await guideTrigger.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderStyle: style.borderTopStyle,
      borderWidth: Number.parseFloat(style.borderTopWidth),
      circleCount: element.querySelectorAll("svg circle").length,
    };
  });
  expect(triggerVisual.borderWidth).toBe(0);
  expect(triggerVisual.borderStyle).toBe("none");
  expect(triggerVisual.circleCount).toBe(1);
  await guideTrigger.hover();
  await expect(guide).toBeVisible();
  // A scroll anywhere in the app repositions the fixed overlay, even if its
  // anchor has not moved. It must keep the help visible while still hovered.
  await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
  await expect(guide).toContainText("Use HTTP for a standard HTTP proxy");
  await expect(guide).toContainText("https://proxy.example.test:8443");
  await expect(guide).toContainText("socks5://proxy.example.test:1080");
  await expect(guide).toContainText("scheme://username:password@host:port");
  await expect(guide).toContainText("research%40team:p%40ss%3Aword");
  expectStableGeometry(closedGeometry, await captureFormGeometry(form));
  await expectOverlayWithinDialogAndViewport(page, configuration, guide);
  await page.mouse.move(0, 0);
  await expect(guide).toBeHidden();
  expectStableGeometry(closedGeometry, await captureFormGeometry(form));
  await guideTrigger.focus();
  await expect(guide).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  // Escape belongs to the topmost layer only: the guide closes, the System
  // configuration dialog underneath it stays open and usable.
  await expect(configuration).toBeVisible();
  await expect(configuration.getByRole("heading", { name: "Network proxies" })).toBeVisible();
  await guideTrigger.click();
  await expect(guide).toBeVisible();
  await expect(guideTrigger).toHaveAttribute("aria-expanded", "true");
  await guideTrigger.click();
  await expect(guide).toBeHidden();
  await guideTrigger.click();
  await form.getByLabel("Name").click();
  await expect(guide).toBeHidden();
  await form.getByLabel("Type").selectOption("environment");
  await expect(guideTrigger).toHaveCount(0);
  await form.getByLabel("Type").selectOption("system");
  await expect(guideTrigger).toHaveCount(0);
  await form.getByLabel("Type").selectOption("custom_url");
  await expect(form.getByRole("button", { name: "Show proxy URL format help" })).toBeVisible();
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toBeHidden();

  await expect(configuration.getByLabel("WebSearch proxy")).toBeVisible();
  await configuration.getByRole("heading", { name: "Network proxies" }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${screenshotDirectory}/issue-143-proxy-settings-desktop.png`,
    fullPage: false,
    mask: [configuration.locator(".proxy-effective-value, .proxy-server-url")],
  });
  await configuration.getByRole("button", { name: "Web providers" }).click();
  await expect(configuration.getByText(/WebSearch proxy selection is managed in Network proxies/)).toBeVisible();
  await expect(configuration.getByLabel("Web proxy")).toHaveCount(0);
});

/**
 * E2E-META
 * Purpose: 390×844 窄屏下代理设置仍可用：帮助浮层不撑破对话框与视口，页面不产生横向溢出。
 * Steps:
 *   1. 在 390×844 打开 Network proxies。
 *   2. 打开添加表单并展开 URL 格式帮助。
 *   3. 断言表单几何稳定、浮层落在对话框与视口内。
 *   4. 断言对话框与页面都没有横向溢出。
 * Environment: 隔离本地栈；浏览器 egress 仅限 127.0.0.1；390×844 视口。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 只读本地设置页，不发起真实代理连接。
 * Credentials: 隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none — 用例只打开表单，不保存条目。
 */
test("proxy settings remain usable at a narrow viewport", { tag: "@mocked" }, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const configuration = await openProxySettings(page);
  await expect(configuration.getByRole("heading", { name: "Default proxy" })).toBeVisible();
  await expect(configuration.getByRole("heading", { name: "Proxy server list" })).toBeVisible();
  await configuration.getByRole("button", { name: "Add proxy server" }).click();
  const form = configuration.getByRole("form", { name: "Add proxy server" });
  await form.getByRole("button", { name: "Show proxy URL format help" }).scrollIntoViewIfNeeded();
  const closedGeometry = await captureFormGeometry(form);
  await form.getByRole("button", { name: "Show proxy URL format help" }).click();
  const guide = form.getByRole("tooltip");
  await expect(guide).toBeVisible();
  expectStableGeometry(closedGeometry, await captureFormGeometry(form));
  await expectOverlayWithinDialogAndViewport(page, configuration, guide);
  const hasHorizontalOverflow = await configuration.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
  const hasPageHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(hasPageHorizontalOverflow).toBe(false);
  await page.screenshot({
    path: `${screenshotDirectory}/issue-143-proxy-settings-mobile.png`,
    fullPage: false,
    mask: [configuration.locator(".proxy-effective-value, .proxy-server-url")],
  });
});

/**
 * E2E-META
 * Purpose: 自定义明文 URL 在刷新后仍完整保留，并原样预填到编辑表单。
 * Steps:
 *   1. 用唯一名称添加带凭据的明文 URL 代理。
 *   2. 断言列表显示归一化 URL。
 *   3. 刷新页面后断言条目仍在，编辑表单预填完整 URL。
 *   4. 删除条目并断言它从列表消失。
 * Environment: 隔离本地栈；浏览器 egress 仅限 127.0.0.1。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 只读写本地设置页。
 * Credentials: 隔离实例的 E2E_API_TOKEN；代理 URL 中的凭据是合成值。
 * CostSideEffects: none — 测试创建的代理条目在末尾删除。
 */
test("custom URL remains complete after refresh and is prefilled for editing", { tag: "@mocked" }, async ({ page }) => {
  // The E2E stack can keep its data directory between CI attempts. A fixed
  // name makes a retry depend on whether the previous attempt reached the
  // cleanup at the end of this test: if it did not, creating the server fails
  // with the registry's duplicate-name validation before the refresh behavior
  // is exercised. Give every run its own registry entry instead.
  const name = `Plaintext URL E2E proxy ${randomUUID()}`;
  const url = "http://e2e%40user:e2e%3Apass@proxy.example.test:8080";
  let configuration = await openProxySettings(page);
  await configuration.getByRole("button", { name: "Add proxy server" }).click();
  const addForm = configuration.getByRole("form", { name: "Add proxy server" });
  await addForm.getByLabel("Name").fill(name);
  const urlInput = addForm.getByRole("textbox", { name: "Proxy URL", exact: true });
  await expect(urlInput).toHaveAttribute("type", "text");
  await urlInput.fill(url);
  await addForm.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addForm).toBeHidden();
  const normalizedUrl = `${url}/`;
  await expect(configuration.getByText(normalizedUrl, { exact: true })).toBeVisible();

  await page.reload();
  configuration = await openProxySettings(page);
  const card = configuration.locator(".proxy-server-card").filter({ hasText: name });
  await expect(card.getByText(normalizedUrl, { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Edit" }).click();
  const editForm = configuration.getByRole("form", { name: `Edit proxy server ${name}` });
  await expect(editForm.getByRole("textbox", { name: "Proxy URL", exact: true })).toHaveValue(normalizedUrl);
  await expect(editForm.getByRole("button", { name: "Show proxy URL format help" })).toBeVisible();
  await editForm.getByRole("button", { name: "Cancel" }).click();

  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(card).toBeHidden();
});

});
