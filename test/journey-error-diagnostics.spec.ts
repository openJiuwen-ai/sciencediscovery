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

import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { BROWSER_TOKEN_STORAGE_KEY } from "./e2e-auth.js";

// No models, tools or third-party services are contacted by this error-reporting journey.
test.describe("error diagnostics", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const zh = locale === "zh-CN";
    test.describe(locale, () => {
      test.use({ viewport: zh ? { width: 390, height: 844 } : { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
      /**
       * E2E-META
       * Purpose: A user copies bounded sanitized diagnostics from a real request error, opens a prefilled GitHub draft, and recovers from denied clipboard access.
       * Steps:
       *   1. Submit a project creation with an injected oversized description and receive the real API validation failure.
       *   2. Copy the error diagnostics and verify version, locale, correlation ID and matching service-log metadata without credentials.
       *   3. Open the GitHub issue draft and inspect its complete prefilled URL without sending it to GitHub.
       *   4. Deny clipboard access and verify actionable feedback; dismiss the error without any upload.
       *   5. Reject a local connection token and copy diagnostics from the inline alert while the service cannot authenticate the snapshot.
       * Environment: Isolated API/Web and Runner at E2E_BASE_URL; English desktop and Chinese narrow viewport.
       * Type: mocked
       * LLM: none
       * WebSearch: none
       * PaperSources: none
       * MCP: none
       * OtherExternal: none; GitHub navigation intercepted locally and never sent.
       * Credentials: E2E_API_TOKEN for the local stack; synthetic secret in the error fixture only.
       * CostSideEffects: No external cost; invalid project submission creates no records; browser-local token changes only.
       */
      test(`复制错误诊断并打开 Issue 草稿 ${locale}`, { tag: "@mocked" }, async ({ page, context, journey }) => {
        journey.scenario({ goal: "从错误提示中获得可安全分享的诊断，并带到 GitHub 草稿中自行检查和提交。", preconditions: ["独立 API/Web 与 Runner", `${locale}，${zh ? "390×844" : "1440×900"}，DPR 1`, "不访问外部服务"] });
        await page.addInitScript(value => localStorage.setItem("sciencediscovery-locale", value), locale);
        const copy = zh ? "复制关键诊断" : "Copy key diagnostics";
        const issue = zh ? "打开 GitHub Issue" : "Open GitHub issue";
        let requestId: string | undefined;
        let bundle = "";
        let issueUrl = "";
        let diagnosticRequests = 0;
        page.on("request", request => { if (request.url().includes("/api/error-diagnostics")) diagnosticRequests++; });
        // Fault injection changes the request only: API validation and logging run normally.
        await page.route("**/api/projects", async route => {
          if (route.request().method() !== "POST") { await route.continue(); return; }
          const response = await route.fetch({ postData: JSON.stringify({ name: "Diagnostic failure", description: "x".repeat(2001) }) });
          expect(response.status()).toBeGreaterThanOrEqual(400);
          requestId = response.headers()["x-request-id"];
          await route.fulfill({ response, json: { error: 'Project description is too long. /home/alice/log.txt /Users/bob/file.ts C:\\Users\\charlie\\AppData\\log.txt api_key="synthetic-private-key" ' + "诊断测试 ".repeat(400) } });
        });
        await context.route("https://github.com/**", async route => {
          issueUrl = route.request().url();
          await route.fulfill({ contentType: "text/html", body: "<p>Issue draft navigation captured locally.</p>" });
        });
        const toast = page.locator(".toast.error");
        await journey.step("触发真实请求错误", "创建失败显示可操作的错误 Toast，已有表单草稿仍可见。", async () => {
          await page.goto("/");
          const showNavigation = page.getByRole("button", { name: zh ? "打开导航" : "Open navigation" });
          if (await showNavigation.isVisible()) await showNavigation.click();
          await page.getByRole("button", { name: zh ? "添加项目" : "Add project", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: zh ? "创建项目" : "Create Project" });
          await dialog.getByLabel(zh ? "项目名称" : "Project name", { exact: true }).fill("Diagnostic failure");
          await dialog.getByRole("button", { name: zh ? "创建项目" : "Create Project", exact: true }).click();
          await expect(toast.getByRole("button", { name: copy })).toBeVisible();
          expect(requestId).toBeTruthy();
          await expect(dialog.getByLabel(zh ? "项目名称" : "Project name", { exact: true })).toHaveValue("Diagnostic failure");
        });
        await journey.step("复制脱敏诊断", "剪贴板包含版本、系统、语言、错误、请求 ID 与匹配日志；长度有限且不含凭据。", async () => {
          await toast.getByRole("button", { name: copy }).click();
          await expect(toast.getByRole("status")).toContainText(zh ? "已复制诊断" : "Diagnostics copied");
          bundle = await page.evaluate(() => navigator.clipboard.readText());
          for (const value of ["Version/build:", "OS:", `UI locale: ${locale}`, `requestId: ${requestId}`, "event=http_request_failed"]) expect(bundle).toContain(value);
          expect(bundle).not.toContain("synthetic-private-key");
          expect(bundle).not.toMatch(/alice|bob|charlie/);
          expect(bundle).toContain("[truncated]");
          expect(bundle.length).toBeLessThanOrEqual(4000);
          expect(encodeURIComponent(bundle).length).toBeLessThanOrEqual(6500);
          const localToken = await page.evaluate(key => localStorage.getItem(key), BROWSER_TOKEN_STORAGE_KEY);
          expect(localToken).toBeTruthy(); expect(bundle).not.toContain(localToken!);
          const bounds = await toast.boundingBox(); expect(bounds).toBeTruthy();
          expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        });
        await journey.step("打开预填 Issue 草稿", "新标签页 URL 指向指定 GitHub 仓；正文包含刚才复制的相同诊断，未调用创建 Issue API。", async () => {
          const popup = page.waitForEvent("popup");
          await toast.getByRole("button", { name: issue }).click();
          const tab = await popup;
          await expect.poll(() => issueUrl).not.toBe("");
          const url = new URL(issueUrl);
          expect(url.pathname).toBe("/openJiuwen-ai/sciencediscovery/issues/new");
          expect(url.searchParams.get("title")).toMatch(/^\[Bug\]: /);
          expect(url.searchParams.get("body")).toContain(bundle);
          expect(decodeURIComponent(url.toString())).not.toMatch(/alice|bob|charlie|synthetic-private-key/);
          expect(await tab.evaluate(() => window.opener === null)).toBe(true);
          await tab.close();
        });
        await journey.step("处理剪贴板拒绝并关闭错误", "拒绝时显示可重试提示；关闭 Toast 不会再请求日志。", async () => {
          await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("Denied")) }));
          await toast.getByRole("button", { name: copy }).click();
          await expect(toast.getByRole("status")).toContainText(zh ? "无法复制" : "Could not copy");
          const count = diagnosticRequests;
          await toast.getByRole("button", { name: zh ? "关闭通知" : "Dismiss notification", exact: true }).click();
          await expect(toast).toHaveCount(0);
          expect(diagnosticRequests).toBe(count);
        });
        await journey.step("从连接错误复制离线诊断", "错误令牌的内联提示也提供两个动作；日志不可用时仍能复制且不会泄露令牌。", async () => {
          await page.evaluate(key => localStorage.removeItem(key), BROWSER_TOKEN_STORAGE_KEY);
          await page.reload();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel(zh ? "本地服务访问令牌" : "Local service access token", { exact: true }).fill("synthetic-rejected-local-token");
          await dialog.getByRole("button", { name: zh ? "保存" : "Save", exact: true }).click();
          const alert = dialog.getByRole("alert");
          await alert.getByRole("button", { name: copy }).click();
          await expect(alert.getByRole("status")).toContainText(zh ? "已复制诊断" : "Diagnostics copied");
          const offline = await page.evaluate(() => navigator.clipboard.readText());
          expect(offline).toContain("Unavailable:"); expect(offline).not.toContain("synthetic-rejected-local-token");
          await expect(alert.getByRole("button", { name: issue })).toBeVisible();
        });
      });
    });
  }
});
