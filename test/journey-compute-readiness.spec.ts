// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import type { RunnerExecutionCapability } from "@sciencediscovery/schema";

test.describe("Local compute readiness", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@arch:arm64", "@model:mock", "@sandbox:none"] }, () => {
  /**
   * E2E-META
   * Purpose: Read the actual local Runner readiness before analysis while retaining access to Sessions.
   * Steps:
   *   1. Open an isolated Project/Session and compare the two status labels with the real API probe.
   *   2. Reload and confirm the same local compute state and Session remain accessible.
   * Environment: Isolated API/Web/Runner stack at E2E_BASE_URL; sandbox may be available or deliberately missing.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; uses real local readiness responses, browser non-local requests blocked.
   * Credentials: E2E_API_TOKEN for isolated stack.
   * CostSideEffects: no external cost; temporary Project/Session deleted in finally.
   */
  test("查看实际计算状态后仍可浏览会话", { tag: "@mocked" }, async ({ page, journey }) => {
    journey.scenario({ goal: "在提交分析前分清 API 连接与本地沙箱状态，并能继续浏览会话。", preconditions: ["隔离 API/Web/Runner 已启动；不运行分析或调用模型"] });
    const fixture = await createProjectAndSession(page, { projectName: `Compute readiness ${Date.now()}`, sessionTitle: "Inspect local compute" });
    try {
      const response = await page.request.get(`${apiBaseUrl()}/api/runners/local/execution-capability`, { headers: authorizationHeader() });
      expect(response.ok()).toBe(true);
      const probe = await response.json() as { connected: boolean; capability?: RunnerExecutionCapability; reason?: string };
      const compute = !probe.connected || probe.capability?.ready === false ? "Unavailable" : probe.capability?.ready === true ? "Ready" : "Unknown";
      await journey.step("打开会话并读取计算状态", "API 显示已连接；本地沙箱与实际 Runner 探测一致，不可用时显示具体原因。", async () => {
        await openProjectSession(page, fixture);
        await expect(page.getByText("API · Connected", { exact: true })).toBeVisible();
        await expect(page.getByText(`Local sandbox · ${compute}`, { exact: true })).toBeVisible();
        if (compute === "Unavailable") {
          const notice = page.getByRole("status", { name: "Local sandbox notice" });
          await expect(notice).toContainText(probe.connected ? "The local sandbox is unavailable" : "The local Runner cannot be reached");
          if (probe.capability?.detail || probe.reason) await expect(notice).toContainText(probe.capability?.detail || probe.reason!);
        }
        await expect(page.locator("form.composer textarea")).toBeEditable();
      });
      await journey.step("刷新后继续浏览", "会话仍可打开，计算状态与提示在刷新后继续保留。", async () => {
        await page.reload();
        await expect(page.getByRole("heading", { exact: true, name: fixture.session.title })).toBeVisible();
        await expect(page.getByText(`Local sandbox · ${compute}`, { exact: true })).toBeVisible();
      });
    } finally { await cleanupJourney(page, fixture); }
  });

  /**
   * E2E-META
   * Purpose: Surface sandbox failures separately from API connectivity, retain readable reasons, and recover after rechecking.
   * Steps:
   *   1. Open a Session with a simulated sandbox failure and inspect both independent status labels.
   *   2. Read the full reason and recheck control at desktop, low-height, narrow viewports and layout breakpoints.
   *   3. Recheck an older Runner with no capability, then a disconnected Runner, then an API failure.
   *   4. Repair the simulated sandbox and recheck to remove the notice and show ready.
   * Environment: Isolated API/Web stack; only the local execution-capability response is simulated in the browser.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; browser non-local requests blocked.
   * Credentials: E2E_API_TOKEN for isolated stack.
   * CostSideEffects: no external cost; temporary Project/Session deleted in finally.
   */
  test("沙箱不可用提示、状态区分与修复恢复", { tag: "@mocked" }, async ({ page, journey }) => {
    journey.scenario({ goal: "看到无法分析的具体原因，区分连接与计算状态，修复后重新确认就绪。", preconditions: ["真实隔离 API/Web；浏览器模拟本地能力故障与修复；不执行代码"] });
    const fixture = await createProjectAndSession(page, { projectName: `Compute recovery ${Date.now()}`, sessionTitle: "Repair sandbox readiness" });
    const detail = "bwrap: Creating new namespace failed: Operation not permitted. 当前主机不允许创建用户命名空间；请联系管理员检查沙箱配置。";
    let state: "sandbox" | "legacy" | "runner" | "api" | "ready" = "sandbox";
    const methods: string[] = [];
    await page.route("**/api/runners/local/execution-capability", async route => {
      methods.push(route.request().method());
      if (state === "api") return route.fulfill({ status: 503, json: { error: "API temporarily unavailable" } });
      const capability: RunnerExecutionCapability = { instanceId: "browser-fixture", checkedAt: new Date().toISOString(), sandbox: "bubblewrap",
        dependencyAvailable: true, sandboxUsable: state === "ready", ready: state === "ready", reason: state === "ready" ? "ready" : "sandbox-unusable", detail };
      await route.fulfill({ json: { runnerId: "local", connected: state !== "runner", ...(state === "runner" ? { reason: "Runner connection refused" } : state === "legacy" ? {} : { capability }) } });
    });
    const notice = page.getByRole("status", { name: "Local sandbox notice" });
    const recheck = page.getByRole("button", { name: "Recheck sandbox", exact: true });
    try {
      await journey.step("查看沙箱不可用原因", "API 已连接与本地沙箱不可用同时显示，完整原因直接出现在工作台。", async () => {
        await openProjectSession(page, fixture);
        await expect(page.getByText("API · Connected", { exact: true })).toBeVisible();
        await expect(page.getByText("Local sandbox · Unavailable", { exact: true })).toBeVisible();
        await expect(notice).toContainText(detail);
        await expect(notice).toContainText("The local sandbox is unavailable");
        // Direct host execution remains possible only through per-command approval.
        await expect(notice).toContainText("only if you approve it in the conversation, and it runs without sandbox isolation");
        await expect(notice).toContainText("scientific environments, model availability and remote Runners are checked separately");
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.locator(".compute.bad")).toBeVisible();
        await expect(page.locator(".connection.bad")).toHaveCount(0);
      });
      for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 600 }, { width: 390, height: 844 }]) {
        await journey.step(`在 ${viewport.width}×${viewport.height} 阅读提示`, "原因可换行阅读，重新检查可操作，状态文字不裁切且页面无水平溢出。", async () => {
          await page.setViewportSize(viewport);
          await expect(notice).toBeVisible();
          await expect(recheck).toBeVisible();
          await expect(page.getByText("Local sandbox · Unavailable", { exact: true })).toBeVisible();
          await expect(page.getByText("API · Connected", { exact: true })).toBeVisible();
          const status = await page.getByRole("status", { name: "API connection and local sandbox", exact: true }).boundingBox();
          const conversation = await page.locator("section.conversation").boundingBox();
          expect(status!.x + status!.width).toBeLessThanOrEqual(conversation!.x + conversation!.width);
          if (viewport.width <= 1024) {
            const heading = await notice.locator("strong").boundingBox();
            const navigation = await page.getByRole("button", { name: "Open navigation", exact: true }).boundingBox();
            expect(heading!.x).toBeGreaterThanOrEqual(navigation!.x + navigation!.width);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          expect(await notice.locator(".compute-notice-reason").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        });
      }
      await journey.step("跨布局断点调整窗口", "断点两侧都能完整读取两项状态，页面不产生水平溢出。", async () => {
        for (const width of [599, 600, 601, 899, 900, 901, 1023, 1024, 1025, 1179, 1180, 1181]) {
          await page.setViewportSize({ width, height: 844 });
          const status = page.getByRole("status", { name: "API connection and local sandbox", exact: true });
          await expect(status.getByText("API · Connected", { exact: true })).toBeVisible();
          await expect(status.getByText("Local sandbox · Unavailable", { exact: true })).toBeVisible();
          const bounds = await status.boundingBox();
          const conversation = await page.locator("section.conversation").boundingBox();
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(conversation!.x + conversation!.width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
        await page.setViewportSize({ width: 390, height: 844 });
      });
      await journey.step("在窄屏滚动到分析输入区", "故障提示保持可见，分析输入区和提交按钮可以完整滚动到视口内。", async () => {
        const run = page.getByRole("button", { name: "Run analysis", exact: true });
        await run.evaluate(element => element.scrollIntoView({ block: "center" }));
        await expect(run).toBeInViewport({ ratio: 1 });
        await expect(notice).toBeInViewport({ ratio: 1 });
      });
      await journey.step("依次检查能力未知、Runner 断开与 API 故障", "缺少能力数据时计算显示未知；Runner 断开时 API 仍已连接；API 故障后不保留就绪状态。", async () => {
        state = "legacy";
        await recheck.click();
        await expect(page.getByText("Local sandbox · Unknown", { exact: true })).toBeVisible();
        await expect(notice).toContainText("did not report sandbox readiness");
        state = "runner";
        await recheck.click();
        await expect(notice).toContainText("Runner connection refused");
        await expect(notice).toContainText("The local Runner cannot be reached");
        // An unreachable Runner cannot take direct execution either.
        await expect(notice).not.toContainText("approve it in the conversation");
        await expect(page.getByText("API · Connected", { exact: true })).toBeVisible();
        state = "api";
        await recheck.click();
        await expect(page.getByText("API · Unavailable", { exact: true })).toBeVisible();
        await expect(page.getByText("Local sandbox · Unknown", { exact: true })).toBeVisible();
      });
      await journey.step("修复沙箱后重新检查", "重新探测后本地沙箱显示就绪，故障提示消失，会话继续可浏览。", async () => {
        state = "ready";
        await recheck.click();
        await expect(page.getByText("Local sandbox · Ready", { exact: true })).toBeVisible();
        await expect(page.getByText("API · Connected", { exact: true })).toBeVisible();
        await expect(notice).toHaveCount(0);
        expect(methods).toContain("POST");
        await expect(page.locator("form.composer textarea")).toBeEditable();
      });
    } finally { await cleanupJourney(page, fixture); }
  });
});
