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

import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";

import { apiBaseUrl, BROWSER_TOKEN_STORAGE_KEY, requireApiToken } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, type JourneyFixture } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-local-token-onboarding.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

for (const locale of ["en", "zh-CN"] as const) {
  test.describe(locale, () => {
    test.setTimeout(60_000);
    test.use({ storageState: { cookies: [], origins: [{ origin: new URL(apiBaseUrl()).origin, localStorage: [
      { name: "sciencediscovery-locale", value: locale },
    ] }] } });
    const zh = locale === "zh-CN";
    const tokenLabel = zh ? "本地服务访问令牌" : "Local service access token";
    const save = zh ? "保存" : "Save";
    const saveClose = zh ? "保存并关闭" : "Save and close";
    const rejected = zh ? "本地服务访问令牌被拒绝" : "Local service access token rejected";

    /**
     * E2E-META
     * Purpose: A first-time user finds one clear local-token prompt, recovers from wrong credentials, and distinguishes model keys.
     * Steps:
     *   1. Open a fresh browser and follow the startup-log guidance.
     *   2. Try a wrong token twice and see a single rejection without toasts.
     *   3. Save the correct token, refresh, and open model credentials.
     * Environment: Isolated stack at E2E_BASE_URL; empty browser storage except locale.
     * Type: mocked
     * LLM: none
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none
     * Credentials: E2E_API_TOKEN for the isolated local service only.
     * CostSideEffects: Browser-local token storage only; no model calls or records created.
     */
    test(`首次连接可理解且错误令牌可恢复 ${locale}`, { tag: "@mocked" }, async ({ page, journey }) => {
      journey.scenario({ goal: "首次使用时按一处引导完成连接，并知道模型 Key 应填在哪里。", preconditions: ["独立本机栈", `界面语言 ${locale}`, "浏览器未保存令牌"] });
      const dialog = page.getByRole("dialog");
      await journey.step("打开应用查看引导", "只有一处启动日志与保存说明，没有 Unauthorized 红字、Toast 或设置警示条。", async () => {
        await page.goto("/");
        await expect(dialog.getByLabel(tokenLabel, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("status")).toContainText("Open to sign in");
        await expect(dialog.getByRole("status")).toContainText(zh ? "保存" : "Save");
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.getByText("Unauthorized", { exact: false })).toHaveCount(0);
      });
      await journey.step("输入错误令牌并重试", "同一位置显示一次本地令牌被拒绝；再次保存仍可修改，无重复报错。", async () => {
        await dialog.getByLabel(tokenLabel, { exact: true }).fill("not-a-local-service-token");
        await dialog.getByRole("button", { name: save, exact: true }).click();
        await expect(page.getByRole("alert")).toHaveCount(1);
        await expect(page.getByRole("alert")).toContainText(rejected);
        await dialog.getByRole("button", { name: saveClose, exact: true }).click();
        await expect(dialog).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(1);
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), BROWSER_TOKEN_STORAGE_KEY)).not.toBe("not-a-local-service-token");
      });
      await journey.step("保存正确令牌并刷新", "设置关闭；刷新后仍可读取项目且不再要求令牌。", async () => {
        await dialog.getByLabel(tokenLabel, { exact: true }).fill(requireApiToken());
        await dialog.getByRole("button", { name: saveClose, exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const response = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.status() === 200);
        await page.reload();
        await response;
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(await page.evaluate((key) => localStorage.getItem(key), BROWSER_TOKEN_STORAGE_KEY) === requireApiToken()).toBe(true);
      });
      await journey.step("查看模型凭据名称", "连接模型表单明确显示外部模型 API Key，与本地服务访问令牌区分。", async () => {
        await page.goto("/settings/models");
        await expect(dialog).toBeVisible();
        // 新建服务商已并入连接模型卡片；没有已配置服务商时它默认展开。
        if (!await dialog.locator(".model-connect-wizard").count()) {
          await dialog.getByRole("button", { name: zh ? "连接模型" : "Connect model" }).click();
        }
        const modelKey = dialog.getByLabel(zh ? "外部模型 API Key" : "External model API Key", { exact: true });
        await modelKey.scrollIntoViewIfNeeded();
        await expect(modelKey).toBeInViewport();
      });
    });

    /**
     * E2E-META
     * Purpose: Opening the startup sign-in URL authenticates automatically, cleans the address bar, and survives a reload.
     * Steps:
     *   1. Open the startup URL in an empty browser and read the project list.
     *   2. Refresh the cleaned URL and remain authenticated.
     *   3. Replace a stale credential with the same startup URL.
     * Environment: Isolated stack at E2E_BASE_URL; optional E2E_STARTUP_LOG supplies the actual printed URL.
     * Type: mocked
     * LLM: none
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none
     * Credentials: E2E_API_TOKEN for the isolated local service only.
     * CostSideEffects: Browser-local token storage only; no model calls or records created.
     */
    test(`启动链接自动登录并持久保存 ${locale}`, { tag: "@mocked" }, async ({ page, journey }) => {
      journey.scenario({ goal: "打开启动日志链接即可使用产品，刷新时无须再次复制令牌。", preconditions: ["独立本机栈", `界面语言 ${locale}`, "空浏览器"] });
      const url = process.env.E2E_STARTUP_LOG
        ? readFileSync(process.env.E2E_STARTUP_LOG, "utf8").match(/Open to sign in: (http[^\s]+)/)?.[1]
        : `${apiBaseUrl()}/#token=${encodeURIComponent(requireApiToken())}`;
      expect(Boolean(url)).toBe(true);
      expect(new URL(url!).origin).toBe(new URL(apiBaseUrl()).origin);
      const unauthorized: string[] = [];
      page.on("response", (r) => { if (r.status() === 401) unauthorized.push(r.url()); });
      await journey.step("打开启动日志链接", "自动进入应用并成功加载项目；地址栏中的令牌已移除，没有认证弹窗。", async () => {
        const response = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.status() === 200);
        await page.goto(url!);
        await response;
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(new URL(page.url()).hash).toBe("");
        expect(await page.evaluate((key) => localStorage.getItem(key), BROWSER_TOKEN_STORAGE_KEY) === requireApiToken()).toBe(true);
      });
      await journey.step("刷新已清理的地址", "持久保存的令牌继续有效，没有先失败再恢复的 401 请求。", async () => {
        const response = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.status() === 200);
        await page.reload();
        await response;
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(unauthorized).toEqual([]);
      });
      await journey.step("替换浏览器中的过期令牌", "重新打开启动链接覆盖过期令牌，直接恢复连接。", async () => {
        await page.evaluate((key) => localStorage.setItem(key, "stale-local-token"), BROWSER_TOKEN_STORAGE_KEY);
        const response = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.status() === 200);
        await page.goto(url!);
        await response;
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(unauthorized).toEqual([]);
      });
      await journey.step("打开无效令牌链接", "错误令牌只显示一处恢复提示，没有额外 Toast 或设置警示条。", async () => {
        await page.goto(`${apiBaseUrl()}/#token=invalid-link-token`);
        await expect(page.getByRole("alert")).toHaveCount(1);
        await expect(page.getByRole("alert")).toContainText(rejected);
        expect(new URL(page.url()).hash).toBe("");
      });
      await journey.step("用有效链接恢复连接", "再次打开正确启动链接立即恢复，刷新后仍然登录。", async () => {
        const response = page.waitForResponse((r) => r.url().endsWith("/api/projects") && r.status() === 200);
        await page.goto(url!);
        await response;
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
      });
    });

    /**
     * E2E-META
     * Purpose: A user whose token expires inside an existing Session gets one Connection prompt despite repeated background polling.
     * Steps:
     *   1. Sign in and open a prepared Project and Session; wait for successful background requests.
     *   2. Send an expired bearer credential from the browser and wait for two memory and governed-download polls to return real HTTP 401.
     *   3. Verify Connection is the only authentication feedback, then save the valid token and continue the same Session.
     * Environment: Isolated stack at E2E_BASE_URL; browser request routing injects an expired credential without mocking responses.
     * Type: mocked
     * LLM: none
     * WebSearch: none
     * PaperSources: none
     * MCP: none; governed-download polling only.
     * OtherExternal: none
     * Credentials: E2E_API_TOKEN for the isolated local service only.
     * CostSideEffects: Temporary Project and Session removed in finally; no model calls.
     */
    test(`会话内令牌失效后只显示连接引导 ${locale}`, { tag: "@mocked" }, async ({ page, journey }) => {
      journey.scenario({ goal: "使用已有会话时令牌失效，只需按 Connection 引导恢复连接，不会不断叠加错误提示。", preconditions: ["独立本机栈", `界面语言 ${locale}`, "会话已创建，无模型调用"] });
      let fixture: JourneyFixture | undefined;
      const successful = { memory: 0, governed: 0 };
      const rejectedPolls = { memory: 0, governed: 0 };
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        const kind = path === "/api/memory/subgraph" ? "memory" : path.endsWith("/mcp/artifact-candidates") ? "governed" : undefined;
        if (!kind) return;
        if (response.status() === 200) successful[kind] += 1;
        if (response.status() === 401) rejectedPolls[kind] += 1;
      });
      let expired = false;
      await page.route("**/api/**", async (route) => {
        // Exercise the real API's token rejection, including its auth callback.
        if (expired) await route.continue({ headers: { ...route.request().headers(), authorization: "Bearer expired-session-token" } });
        else await route.continue();
      });
      try {
        fixture = await createProjectAndSession(page, { projectName: `Token recovery ${locale} ${Date.now()}`, sessionTitle: `Session token recovery ${locale}` });
        await journey.step("登录并打开已有会话", "会话可见，内存与下载轮询均成功，没有错误提示。", async () => {
          await page.goto(`/#token=${encodeURIComponent(requireApiToken())}`);
          await openProjectSession(page, fixture!);
          await expect.poll(() => successful.memory).toBeGreaterThan(0);
          await expect.poll(() => successful.governed).toBeGreaterThan(0);
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.locator(".toast.error, .connection.bad")).toHaveCount(0);
        });
        await journey.step("令牌失效后等待多轮后台请求", "两类轮询都重复返回 401；只有 Connection 的一处恢复引导，无错误 Toast、设置警示条或连接错误标记。", async () => {
          expired = true;
          await expect.poll(() => rejectedPolls.memory, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
          await expect.poll(() => rejectedPolls.governed).toBeGreaterThanOrEqual(2);
          const dialog = page.getByRole("dialog");
          await expect(dialog.getByLabel(tokenLabel, { exact: true })).toBeVisible();
          await expect(page.getByRole("alert")).toHaveCount(1);
          await expect(page.getByRole("alert")).toContainText(rejected);
          await expect(page.locator(".toast.error, .connection.bad")).toHaveCount(0);
          await expect(page.getByText("Unauthorized", { exact: false })).toHaveCount(0);
        });
        await journey.step("保存有效令牌继续原会话", "连接引导关闭，原会话保留，后台请求恢复成功，无残留错误提示。", async () => {
          expired = false;
          const count = successful.governed;
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel(tokenLabel, { exact: true }).fill(requireApiToken());
          await dialog.getByRole("button", { name: saveClose, exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await expect.poll(() => successful.governed).toBeGreaterThan(count);
          await expect(page.getByRole("heading", { name: fixture!.session.title, exact: true })).toBeVisible();
          await expect(page.getByRole("alert")).toHaveCount(0);
          await expect(page.locator(".toast.error, .connection.bad")).toHaveCount(0);
        });
      } finally {
        expired = false;
        if (fixture) await cleanupJourney(page, fixture);
      }
    });
  });
}

});
