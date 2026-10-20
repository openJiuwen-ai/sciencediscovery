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
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-sidebar-drawer.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@arch:arm64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

/**
 * E2E-META
 * Purpose: Below ~1024px the sidebar collapses into a drawer so the conversation and composer stay in the first screen; above ~1024px the sidebar stays resident.
 * Steps:
 *   1. Prepare a Project/Session with a scripted model and one completed exchange.
 *   2. At a ~900px viewport the sidebar is off-canvas and the session bar and composer sit inside the first screen.
 *   3. Open the drawer to reach Projects, Sessions, search and System configuration; picking the Session closes the drawer.
 *   4. Reopen the drawer and close it with Escape.
 *   5. At a ~1280px viewport the sidebar is resident in the grid again and the drawer chrome is gone.
 * Environment: Isolated local stack at E2E_BASE_URL with a journey-owned Project/Session.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; no live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; temporary model and Project records are deleted in finally.
 */
test("窄屏侧栏收成抽屉，对话和输入框留在第一屏", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "一位研究员在约 900px 宽的窗口里使用 ScienceDiscovery：对话和输入框留在第一屏，项目、会话、搜索和系统设置仍能从抽屉里打开。",
    preconditions: ["隔离本地栈已启动", "模型由旅程自带的本地 stub 驱动，不访问外部服务"],
  });

  const stub = await scriptedModel([{ text: "Layout check exchange completed." }]);
  const fixture = await createProjectAndSession(page, {
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Drawer ${Date.now()}` },
    projectName: `Drawer Project ${Date.now()}`,
    sessionTitle: `Drawer Session ${Date.now()}`,
  });

  try {
    await journey.step("准备一段有内容的会话", "进入会话并发出请求，运行完成后消息列表里有真实内容。", async () => {
      await openProjectSession(page, fixture);
      const run = await sendUserMessage(page, fixture.session.id, "Say hello so the conversation has content.");
      expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
    });

    const sidebar = page.locator("#app-sidebar");
    const toggle = page.getByRole("button", { name: "Open navigation" });
    const composer = page.locator("form.composer");

    await journey.step("约 900px 宽时对话和输入框留在第一屏", "侧栏不再堆在上半屏；会话栏、消息和输入框都在第一屏内，页面没有横向溢出。", async () => {
      await page.setViewportSize({ width: 900, height: 800 });
      await expect(sidebar).toBeHidden();
      await expect(toggle).toBeVisible();
      await expect(page.locator(".session-bar")).toBeInViewport();
      await expect(composer).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });

    await journey.step("抽屉里仍能到达项目、会话、搜索和系统设置", "打开抽屉后四类入口都可见；从抽屉点选会话后抽屉关闭并回到对话。", async () => {
      await toggle.click();
      const drawer = page.getByRole("dialog", { name: "Workbench navigation" });
      await expect(drawer).toBeVisible();
      await expect(drawer.locator("#projects-panel-content button.nav-item").filter({ hasText: fixture.project.name })).toBeVisible();
      await expect(drawer.locator("#sessions-panel-content button.nav-item").filter({ hasText: fixture.session.title })).toBeVisible();
      await expect(drawer.getByRole("button", { name: /Search/ })).toBeVisible();
      await expect(drawer.getByRole("button", { name: /System configuration/ })).toBeVisible();
      await drawer.locator("#sessions-panel-content button.nav-item").filter({ hasText: fixture.session.title }).click();
      await expect(sidebar).toBeHidden();
      await expect(composer).toBeInViewport();
    });

    await journey.step("Esc 可以关闭抽屉", "再次打开抽屉后按 Esc，抽屉关闭，焦点回到打开按钮。", async () => {
      await toggle.click();
      await expect(page.getByRole("dialog", { name: "Workbench navigation" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sidebar).toBeHidden();
      await expect(toggle).toBeFocused();
    });

    await journey.step("约 1280px 宽时侧栏保持常驻", "侧栏回到网格第一列，会话栏位于其右侧，输入框仍在第一屏。", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(toggle).toBeHidden();
      await expect(sidebar).toBeVisible();
      const sidebarBox = await sidebar.boundingBox();
      const barBox = await page.locator(".session-bar").boundingBox();
      if (!sidebarBox || !barBox) throw new Error("Sidebar and session bar must have measurable geometry");
      expect(sidebarBox.x).toBe(0);
      expect(sidebarBox.width).toBeGreaterThanOrEqual(240);
      expect(barBox.x).toBeGreaterThanOrEqual(sidebarBox.width - 1);
      await expect(composer).toBeInViewport();
    });
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

});
