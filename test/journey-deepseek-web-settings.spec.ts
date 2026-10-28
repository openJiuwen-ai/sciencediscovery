// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

test.describe("journey-deepseek-web-settings.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
/**
 * E2E-META
 * Purpose: Configure DeepSeek explicitly, persist its key without exposing it, and disable it again.
 * Steps:
 *   1. Open Web provider settings and enable DeepSeek Search and Fetch with a local dummy key.
 *   2. Save, reopen, and confirm the switches, fetch selection and write-only key state persist.
 *   3. At a narrow viewport disable DeepSeek and inspect the controls.
 *   4. Save the disabled state and verify it through the public settings API.
 * Environment: Isolated local API/Web stack at E2E_BASE_URL; global settings restored in finally.
 * Type: mocked
 * LLM: none
 * WebSearch: none; configuration only, no provider requests.
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; browser non-local requests blocked.
 * Credentials: E2E_API_TOKEN and a local dummy provider key only.
 * CostSideEffects: no external cost; temporary Project/Session and dummy key removed in finally.
 */
test("DeepSeek 设置可保存、关闭，密钥不回显", { tag: "@mocked" }, async ({ page, journey }) => {
  journey.scenario({ goal: "在 Web 设置中启用 DeepSeek，确认保存成功后再关闭，密钥保持不可读。", preconditions: ["隔离本地栈已启动；不调用模型或真实 Web provider"] });
  const headers = authorizationHeader();
  const endpoint = `${apiBaseUrl()}/api/web/settings`;
  const previous = await (await page.request.get(endpoint, { headers })).json();
  const { backend: _backend, providers: _providers, ...restore } = previous;
  const fixture = await createProjectAndSession(page, { projectName: `DeepSeek settings ${Date.now()}`, sessionTitle: "Configure web tools" });
  const dialog = page.getByRole("dialog", { name: "System configuration", exact: true });
  async function openWebSettings() {
    await page.getByRole("button", { name: /^System configuration/ }).click();
    await dialog.getByRole("navigation", { name: "Setting groups" }).getByRole("button", { name: /^Web providers/ }).click();
  }
  try {
    await journey.step("启用并保存 DeepSeek", "总开关、抓取选项与密钥输入可操作。", async () => {
      await openProjectSession(page, fixture);
      await openWebSettings();
      await dialog.getByLabel("Enable DeepSeek Search and Fetch", { exact: true }).check();
      const search = dialog.getByRole("checkbox", { name: /^DeepSeek ·/ });
      if (!await search.isChecked()) await search.check();
      await dialog.getByRole("combobox", { name: "Fetch provider", exact: true }).selectOption("deepseek");
      await dialog.getByLabel("DeepSeek API key", { exact: true }).fill("e2e-local-test-key");
    });
    await journey.step("重新打开核对配置", "DeepSeek 已启用，抓取选择和已保存密钥状态保留，密钥输入为空。", async () => {
      await dialog.getByRole("button", { name: "Save and close", exact: true }).click();
      await expect(dialog).toBeHidden();
      await openWebSettings();
      await dialog.getByLabel("Enable DeepSeek Search and Fetch", { exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByLabel("Enable DeepSeek Search and Fetch", { exact: true })).toBeChecked();
      await expect(dialog.getByRole("combobox", { name: "Fetch provider", exact: true })).toHaveValue("deepseek");
      await expect(dialog.getByLabel("DeepSeek API key", { exact: true })).toHaveValue("");
      await expect(dialog.getByRole("checkbox", { name: "DeepSeek · key saved", exact: true })).toBeChecked();
      const response = await (await page.request.get(endpoint, { headers })).json();
      expect(JSON.stringify(response)).not.toContain("e2e-local-test-key");
      await dialog.getByRole("combobox", { name: "Fetch provider", exact: true }).scrollIntoViewIfNeeded();
    });
    await journey.step("窄窗口关闭 DeepSeek", "开关在窄窗口可读，关闭后仍可操作。", async () => {
      await page.setViewportSize({ width: 600, height: 900 });
      const enabled = dialog.getByLabel("Enable DeepSeek Search and Fetch", { exact: true });
      await enabled.scrollIntoViewIfNeeded();
      await expect(enabled).toBeVisible();
      await enabled.uncheck();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    });
    await journey.step("保存关闭状态", "公开设置 API 确认 DeepSeek 已关闭。", async () => {
      await dialog.getByRole("button", { name: "Save and close", exact: true }).click();
      await expect(dialog).toBeHidden();
      expect((await (await page.request.get(endpoint, { headers })).json()).deepseekEnabled).toBe(false);
    });
  } finally {
    await page.request.put(endpoint, { headers, data: { ...restore, providerApiKeys: { deepseek: null } } });
    await cleanupJourney(page, fixture);
  }
});
});
