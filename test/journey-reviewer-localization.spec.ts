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

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-reviewer-localization.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: A Chinese-language researcher can operate Reviewer Specialist without translating its product name.
 * Steps:
 *   1. Open a Chinese-language Session with Reviewer Specialist enabled.
 *   2. Confirm the Reviewer control card uses Chinese controls while retaining the Reviewer Specialist name.
 *   3. Change the per-Session review level and confirm the selected value remains visible in Chinese.
 * Environment: Isolated API/Runner with its own ports and data directory; Reviewer Specialist is enabled through the supported settings API during setup.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: Creates and deletes one isolated Project/Session; temporarily enables Reviewer Specialist in the isolated catalog.
 */
test("中文界面保留 Reviewer Specialist 名称并本地化审核控制项", { tag: "@mocked" }, async ({ journey, page }) => {
  journey.scenario({
    goal: "研究者在中文界面中配置 Reviewer Specialist 的自动审核和审核级别。",
    preconditions: ["隔离 API 与 Runner 已启动", "浏览器界面语言为 zh-CN", "Reviewer Specialist 已在隔离环境启用"],
  });
  await page.addInitScript(() => window.localStorage.setItem("sciencediscovery-locale", "zh-CN"));
  const fixture = await createProjectAndSession(page, {
    projectName: `Reviewer localization ${Date.now()}`,
    sessionTitle: "Reviewer 中文化",
  });

  try {
    await journey.step(
      "启用 Reviewer Specialist 并进入中文会话",
      "会话右侧出现 Reviewer Specialist 控制卡，产品名称保持英文。",
      async () => {
        const response = await page.request.put(`${apiBaseUrl()}/api/reviewer-specialist/settings`, {
          data: { enabled: true },
          headers: authorizationHeader(),
        });
        expect(response.ok()).toBeTruthy();
        await openProjectSession(page, fixture);
        await page.locator(".workspace-fold").filter({ hasText: "Reviewer Specialist" }).locator("summary").click();
        await expect(page.locator(".reviewer-control-card")).toContainText("Reviewer Specialist");
      },
    );

    await journey.step(
      "查看中文审核控制项",
      "自动审查、级别、快速/深入档位和运行审查按钮显示中文。",
      async () => {
        const card = page.locator(".reviewer-control-card");
        await expect(card).toContainText("内置专家");
        await expect(card).toContainText("自动审查");
        await expect(card).toContainText("级别");
        await expect(card.getByRole("button", { name: "运行审查", exact: true })).toBeVisible();
        await expect(card.locator("select option")).toHaveText(["快速", "深入"]);
      },
    );

    await journey.step(
      "切换为深度审核",
      "审核级别更新后，选择框继续显示中文“深入”。",
      async () => {
        const level = page.locator(".reviewer-control-card select");
        await level.selectOption("deep");
        await expect(level).toHaveValue("deep");
        await expect(level.locator("option:checked")).toHaveText("深入");
      },
    );
  } finally {
    await page.request.put(`${apiBaseUrl()}/api/reviewer-specialist/settings`, {
      data: { enabled: false },
      headers: authorizationHeader(),
    }).catch(() => undefined);
    await cleanupJourney(page, fixture);
  }
});

});
