// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { startOAuthFixture } from "./fixtures/mcp-oauth.mjs";

test.use({ locale: "zh-CN", actionTimeout: 15_000 });

/**
 * E2E-META
 * Purpose: A user authorizes a remote HTTP MCP service and invokes it in Inspector.
 * Steps:
 *   1. Configure OAuth, verify unauthorized API calls are rejected, cancel browser login.
 *   2. Grant consent in a real popup, discover tools and inspect a successful call.
 *   3. Refresh an expired bearer, deny reauthorization, recover, clear local credentials.
 * Environment: Isolated API/Runner and data directory; local HTTP identity/MCP fixture.
 * Type: mocked
 * LLM: none; no model calls.
 * WebSearch: none
 * PaperSources: none
 * MCP: Real SDK HTTP transport with loopback OAuth discovery, registration, PKCE and refresh.
 * OtherExternal: none; non-local browser requests blocked.
 * Credentials: E2E_API_TOKEN for the isolated API; generated fixture tokens only.
 * CostSideEffects: Creates and deletes a temporary Project/Session and custom MCP server.
 */
test("Authorize MCP, inspect tools and recover from denied consent", { tag: "@mocked" }, async ({ page, context, journey }) => {
  journey.scenario({ goal: "Log in to an OAuth MCP service and verify its tools", preconditions: ["Isolated API and Runner running", "Only a local OAuth/MCP fixture is used"] });
  const oauth = await startOAuthFixture();
  await page.addInitScript(() => localStorage.setItem("science-agent-locale", "zh-CN"));
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await createProjectAndSession(page, { projectName: `OAuth ${Date.now()}`, sessionTitle: "OAuth Inspector" });
  const name = `OAuth MCP ${Date.now()}`;
  const dialog = page.getByRole("dialog", { name: "系统设置" });
  const settings = dialog.locator(".mcp-settings");
  const row = settings.locator(".mcp-server").filter({ has: page.locator("strong", { hasText: name }) });
  const base = apiBaseUrl();
  const headers = authorizationHeader();
  let id: string | undefined;
  const openLogin = async (reauthorize = false) => {
    const popupPromise = context.waitForEvent("page");
    await row.getByRole("button", { name: reauthorize ? "重新授权" : "登录授权", exact: true }).click();
    const popup = await popupPromise;
    await expect(popup.getByRole("heading", { name: "Local MCP consent" })).toBeVisible();
    return popup;
  };
  const consent = async (reauthorize = false) => {
    const popup = await openLogin(reauthorize);
    await popup.getByRole("link", { name: "Allow test access" }).click();
    await expect(row).toContainText("OAuth · 已授权");
    await expect(row).toContainText("1 个工具");
    await expect(row).toContainText("已连接");
  };
  try {
    await openProjectSession(page, fixture);
    await journey.step("配置 OAuth MCP", "保存后明确提示需要登录，后台不会自动注册客户端", async () => {
      await page.getByRole("button", { name: /^系统设置/ }).click();
      await dialog.getByRole("navigation", { name: "设置分组" }).getByRole("button", { name: /^MCP 服务器/ }).click();
      await settings.getByRole("button", { name: "添加服务器", exact: true }).click();
      await settings.getByLabel("名称", { exact: true }).fill(name);
      await settings.getByLabel("URL", { exact: true }).fill(oauth.mcpUrl);
      await settings.getByLabel("认证方式").selectOption("oauth");
      await expect(settings.getByLabel("回调地址")).toHaveValue(`${base}/api/mcp/oauth/callback`);
      await settings.getByLabel("启用此 MCP 服务器", { exact: true }).check();
      await settings.getByRole("button", { name: "保存", exact: true }).click();
      await expect(row.locator(".mcp-server-details")).toBeHidden();
      await row.getByRole("button", { name: `展开服务器 ${name}`, exact: true }).click();
      await expect(row).toContainText("需要登录");
      expect(oauth.counts.registrations).toBe(0);
      const servers = await (await page.request.get(`${base}/api/mcp/servers`, { headers })).json();
      id = servers.find((item: { name: string }) => item.name === name).id;
      expect((await page.request.post(`${base}/api/mcp/servers/${id}/oauth/start`, { data: { redirectUrl: `${base}/api/mcp/oauth/callback` } })).status()).toBe(401);
      expect((await page.request.post(`${base}/api/mcp/servers/${id}/oauth/start`, { headers, data: { redirectUrl: "http://127.0.0.1:1/api/mcp/oauth/callback" } })).status()).toBe(400);
      expect((await page.request.get(`${base}/api/mcp/oauth/callback?state=invalid&code=invalid`)).status()).toBe(400);
    });
    await journey.step("关闭授权窗口", "关闭弹窗取消等待，可重新点击登录", async () => {
      const popup = await openLogin();
      await expect(row).toContainText("等待授权");
      await popup.close();
      await expect(row.getByRole("button", { name: "登录授权", exact: true })).toBeVisible();
      await expect(row).toContainText("需要登录");
    });
    await journey.step("同意授权", "真实回调完成 PKCE 交换，自动连接并展示工具", async () => {
      await consent();
      expect(oauth.counts.pkce).toBe(1);
    });
    await journey.step("手机宽度查看授权入口", "授权操作自动换行，文字和按钮不溢出", async () => {
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(row.getByRole("button", { name: "重新授权", exact: true })).toBeVisible();
    });
    await journey.step("授权后运行 Inspector", "工具返回正文及审计 ID，不需要另外传令牌", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await row.getByRole("button", { name: "MCP Inspector", exact: true }).click();
      await settings.getByLabel("工具", { exact: true }).selectOption("echo");
      await settings.getByLabel("调用参数（JSON）").fill('{"text":"browser authorization works"}');
      await settings.getByRole("button", { name: "执行工具", exact: true }).click();
      await expect(settings.locator(".mcp-inspector-output")).toContainText("OAUTH: browser authorization works");
      expect(oauth.counts.tools).toBe(1);
      await settings.getByText("审计记录 ID", { exact: true }).click();
      await expect(settings.locator(".mcp-invocation-id code")).not.toBeEmpty();
    });
    await journey.step("令牌失效后自动刷新", "测试连接仍成功，服务商收到一次 refresh_token 请求", async () => {
      await settings.getByRole("button", { name: "返回服务器列表", exact: true }).click();
      oauth.expire();
      await row.getByRole("button", { name: `测试连接 ${name}`, exact: true }).click();
      await expect(settings.locator(".mcp-feedback.success")).toContainText("连接成功");
      expect(oauth.counts.refreshes).toBe(1);
    });
    await journey.step("拒绝重新授权", "拒绝会结束等待并显示错误，不沿用旧的已连接状态", async () => {
      const popup = await openLogin(true);
      await popup.getByRole("link", { name: "Deny", exact: true }).click();
      await expect(row).toContainText("需要登录");
      await expect(row.getByRole("alert")).toContainText("denied");
      await expect(row.getByRole("button", { name: "MCP Inspector", exact: true })).toHaveCount(0);
    });
    await journey.step("拒绝后恢复授权", "下一次同意后重新发现工具并恢复连接", async () => {
      await consent();
    });
    await journey.step("清除本地授权", "已授权状态与工具入口消失，刷新页面后仍需登录", async () => {
      await row.getByRole("button", { name: "清除本地授权", exact: true }).click();
      await expect(row).toContainText("需要登录");
      await expect(row.getByRole("button", { name: "MCP Inspector", exact: true })).toHaveCount(0);
      await page.reload();
      await expect(row.getByRole("button", { name: `展开服务器 ${name}`, exact: true })).toHaveAttribute("aria-expanded", "false");
      await expect(row.locator(".mcp-server-details")).toBeHidden();
      await row.getByRole("button", { name: `展开服务器 ${name}`, exact: true }).click();
      await expect(row).toContainText("需要登录");
      const saved = await (await page.request.get(`${base}/api/mcp/servers`, { headers })).json();
      expect(JSON.stringify(saved)).not.toContain("access_token");
    });
  } finally {
    if (id) await page.request.delete(`${base}/api/mcp/servers/${id}`, { headers });
    await cleanupJourney(page, fixture);
    await oauth.close();
  }
});
