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
import { cleanupJourney, requireFirstRunState, type JourneyFixture } from "./helpers/journeys.ts";

const languages = [
  { locale: "en", browserLocale: "en-US", configure: "Configure a model", create: "Create a Project", settings: "System configuration", registry: "Model registry", close: "Cancel and close", projectDialog: "Create Project", projectName: "Project name", cancel: "Cancel" },
  { locale: "zh-CN", browserLocale: "zh-CN", configure: "配置模型", create: "创建项目", settings: "系统设置", registry: "模型注册表", close: "取消并关闭", projectDialog: "创建项目", projectName: "项目名称", cancel: "取消" },
] as const;

const viewports = [
  { width: 1440, height: 900 },
  { width: 960, height: 600 },
  { width: 390, height: 844 },
];

for (const language of languages) {
  test.describe(`Empty-state onboarding ${language.locale}`, {
    tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"],
  }, () => {
    test.use({ locale: language.browserLocale });

    for (const viewport of viewports) {
      /**
       * E2E-META
       * Purpose: A first-time user can reach model settings and create their first Project directly from the empty-state steps, using pointer or keyboard.
       * Steps:
       *   1. Open an empty workbench in English or Chinese at desktop, low-height, or narrow width; the first two steps are accessible actions.
       *   2. Activate Configure a model with Enter; the model registry and connection wizard open directly.
       *   3. Close settings, reopen from the same step by pointer, and close again.
       *   4. Activate Create a Project with Space, then cancel without creating a Project.
       *   5. Reopen by pointer, create a Project, and verify the first Session and composer open and persist after reload.
       * Environment: Isolated local stack at E2E_BASE_URL with an empty Project/model catalog; viewport matrix at DPR 1.
       * Type: mocked
       * LLM: none — navigation and Project creation require no model call.
       * WebSearch: none
       * PaperSources: none
       * MCP: none
       * OtherExternal: none — non-local browser requests are aborted.
       * Credentials: E2E_API_TOKEN for the isolated local API only.
       * CostSideEffects: no external cost; the created Project is deleted in finally; reset requires E2E_ALLOW_STACK_RESET.
       */
      test(`First Project from actionable steps at ${viewport.width}x${viewport.height}`, { tag: "@mocked" }, async ({ journey, page }, testInfo) => {
        journey.scenario({
          goal: "首次使用者直接从空状态进入模型设置、取消后重开，再创建项目并进入可继续工作的首个会话。",
          preconditions: [
            "独立本地栈，空项目与模型目录；仅在明确拥有该栈时允许清理残留。",
            `界面语言 ${language.locale}，Chromium 视口 ${viewport.width}×${viewport.height}，DPR 1。`,
            "不调用模型或任何外部服务。",
          ],
        });
        await page.setViewportSize(viewport);
        await page.addInitScript((locale) => localStorage.setItem("sciencediscovery-locale", locale), language.locale);
        const steps = page.locator(".empty-steps");
        const configure = steps.getByRole("button", { name: language.configure, exact: true });
        const create = steps.getByRole("button", { name: language.create, exact: true });
        const settings = page.getByRole("dialog", { name: language.settings, exact: true });
        const dialog = page.getByRole("dialog", { name: language.projectDialog, exact: true });
        const closeSettings = () => settings.locator(".config-header").getByRole("button", { name: language.close, exact: true }).click();
        let fixture: JourneyFixture | undefined;

        try {
          await journey.step("首页直接提供两个上手入口", "配置模型与创建项目均为可见、可操作的按钮，说明完整，第三步仍为说明。", async () => {
            await requireFirstRunState(page, testInfo);
            await page.goto("/");
            await expect(steps.getByRole("listitem")).toHaveCount(3);
            await expect(steps.getByRole("button")).toHaveCount(2);
            await expect(configure).toBeVisible();
            await expect(create).toBeEnabled();
            await expect(configure).toHaveAccessibleDescription(/.+/);
            await expect(create).toHaveAccessibleDescription(/.+/);
            await expect(steps.getByRole("listitem").last().getByRole("button")).toHaveCount(0);
            await configure.focus();
            await page.keyboard.press("Tab");
            await expect(create).toBeFocused();
            const geometry = await steps.evaluate((element) => ({
              right: element.getBoundingClientRect().right,
              width: window.innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
            }));
            expect(geometry.right).toBeLessThanOrEqual(geometry.width);
            expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
          });

          await journey.step("用键盘直接打开模型设置", "Enter 打开模型注册表，并展示连接模型向导，无需再查找设置分组。", async () => {
            await configure.focus();
            await expect(configure).toBeFocused();
            await configure.press("Enter");
            await expect(settings.getByRole("heading", { name: language.registry, exact: true })).toBeVisible();
            await expect(settings.locator(".model-connect-wizard")).toBeVisible();
            await expect(page).toHaveURL((url) => url.pathname === "/settings/models");
          });

          await journey.step("关闭后仍可从卡片重新进入", "关闭设置返回空状态，点击配置模型卡片再次进入同一个模型注册表。", async () => {
            await closeSettings();
            await expect(settings).toBeHidden();
            await configure.click();
            await expect(settings.getByRole("heading", { name: language.registry, exact: true })).toBeVisible();
            await expect(settings.locator(".model-connect-wizard")).toBeVisible();
          });

          await journey.step("用键盘打开创建对话框并取消", "Space 打开现有创建项目对话框；填写名称后取消，空状态仍在。", async () => {
            await closeSettings();
            await create.focus();
            await expect(create).toBeFocused();
            await create.press("Space");
            await expect(dialog.getByLabel(language.projectName, { exact: true })).toBeVisible();
            await dialog.getByLabel(language.projectName, { exact: true }).fill("Cancelled project");
            await dialog.getByRole("button", { name: language.cancel, exact: true }).click();
            await expect(dialog).toBeHidden();
            await expect(create).toBeVisible();
          });

          await journey.step("点击卡片创建项目并继续首个会话", "项目创建成功，对话框关闭、空状态消失，首个会话与输入区自动打开；刷新后仍在该会话。", async () => {
            await create.click({ position: { x: 20, y: 20 } });
            const name = `Onboarding ${language.locale} ${viewport.width} ${Date.now()}`;
            await dialog.getByLabel(language.projectName, { exact: true }).fill(name);
            const response = page.waitForResponse((item) => item.request().method() === "POST"
              && new URL(item.url()).pathname === "/api/projects");
            await dialog.getByRole("button", { name: language.projectDialog, exact: true }).click();
            const created = await response;
            expect(created.ok()).toBe(true);
            const payload = await created.json() as { project: JourneyFixture["project"]; firstSession: JourneyFixture["session"] };
            fixture = { project: payload.project, session: payload.firstSession };
            await expect(dialog).toBeHidden();
            await expect(steps).toBeHidden();
            await expect(page.locator(".session-bar-project")).toHaveText(name);
            await expect(page.locator(".composer textarea")).toBeVisible();
            const sessionPath = `/projects/${fixture.project.id}/sessions/${fixture.session.id}`;
            await expect(page).toHaveURL((url) => url.pathname === sessionPath);
            await page.reload();
            await expect(page.locator(".session-bar-project")).toHaveText(name);
            await expect(page.locator(".composer textarea")).toBeVisible();
            await expect(page).toHaveURL((url) => url.pathname === sessionPath);
          });
        } finally {
          if (fixture) await cleanupJourney(page, fixture);
        }
      });
    }
  });
}
