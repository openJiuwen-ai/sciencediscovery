// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Sandbox network settings recommend only the current execution tool at desktop and narrow widths.
 * Steps:
 *   1. Open system settings from an isolated Session and inspect sandbox network guidance.
 *   2. Narrow the viewport and confirm the same guidance and controls remain readable.
 * Environment: Isolated local API/Web stack at E2E_BASE_URL; no managed environments required.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; browser non-local requests are blocked.
 * Credentials: E2E_API_TOKEN for the isolated stack only.
 * CostSideEffects: no external cost; temporary Project/Session removed in finally.
 */
test("沙箱网络设置只推荐当前 Shell 工具", { tag: "@mocked" }, async ({ page, journey }) => {
  journey.scenario({ goal: "查看 Shell 命令的联网设置，不被已删除的工具名误导。", preconditions: ["隔离本地栈已启动；不执行命令或调用模型"] });
  const fixture = await createProjectAndSession(page, { projectName: `Network guidance ${Date.now()}`, sessionTitle: "Network guidance" });
  try {
    const dialog = page.getByRole("dialog", { name: "System configuration", exact: true });
    await journey.step("打开沙箱网络设置", "设置说明只提 run_shell，仍显示联网模式和安全边界。", async () => {
      await openProjectSession(page, fixture);
      await page.getByRole("button", { name: /^System configuration/ }).click();
      await dialog.getByRole("navigation", { name: "Setting groups" }).getByRole("button", { name: /^Sandbox network/ }).click();
      await expect(dialog.getByRole("heading", { name: "Sandbox network access" })).toBeVisible();
      await expect(dialog).toContainText("run_shell");
      await expect(dialog).not.toContainText(/run_python|run_r\b/);
      await expect(dialog).toContainText("TLS is not inspected");
    });
    await journey.step("缩窄设置窗口", "窄窗口仍能读到 Shell 说明，页面没有水平溢出。", async () => {
      await page.setViewportSize({ width: 600, height: 900 });
      await expect(dialog.getByText(/Controls whether commands run by/)).toBeVisible();
      await expect(dialog).not.toContainText(/run_python|run_r\b/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  } finally {
    await cleanupJourney(page, fixture);
  }
});
