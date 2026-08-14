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

import { expect, test, type Locator, type Page } from "@playwright/test";

const screenshotDirectory = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";

async function openProxySettings(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "System configuration" }).click();
  const configuration = page.getByRole("dialog", { name: "System configuration" });
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

test("proxy settings put defaults and registry first and expose one WebSearch policy", async ({ page }) => {
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

test("proxy settings remain usable at a narrow viewport", async ({ page }) => {
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

test("custom URL remains complete after refresh and is prefilled for editing", async ({ page }) => {
  const name = "Plaintext URL E2E proxy";
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
