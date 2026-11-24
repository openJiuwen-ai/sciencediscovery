/**
 * E2E-META
 * Purpose: Exercise the Desktop setup journey against the deterministic API fixture.
 * Steps:
 *   1. Open the Desktop browser entry and drive the user-facing interaction.
 *   2. Assert the resulting UI state and fixture-side request or persistence effect.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none; model behavior is deterministic fixture data.
 * WebSearch: none
 * PaperSources: none
 * MCP: deterministic fixture responses only where the journey requires them.
 * OtherExternal: none
 * Credentials: none
 * CostSideEffects: none
 */
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
/**
 * The first run with no model: the entry gate offers the bring-your-own-model
 * path, and the workspace does not open until that model has been tested.
 */
import { expect, test } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a workspace with no model opens the gate, and the shell waits for a tested model", async ({ page }) => {
  const mock = await installMockApi(page, { models: [], sessions: [] });

  await page.goto("/");

  // No model and no account: the entry page is the whole app. Step one is the
  // HUAWEI sign-in; skipping it leads to the model page, which cannot be
  // skipped, and the shell does not exist behind either until a model is tested.
  await expect(page.getByRole("heading", { name: "账号登录" })).toBeVisible();
  await expect(page.getByText("使用华为账号登录成功后即可获得积分", { exact: false })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);

  await page.getByRole("button", { name: "暂不登录，配置自定义模型" }).click();
  await expect(page.getByRole("heading", { name: "自定义模型配置" })).toBeVisible();
  const enter = page.getByRole("button", { name: "保存并进入工作台" });
  await expect(page.getByRole("heading", { name: "自定义模型配置" })).toBeVisible();
  // The model step is mandatory: no skip, no tabs back to the sign-in step.
  await expect(page.getByRole("button", { name: "暂不登录，配置自定义模型" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "自定义模型" })).toHaveCount(0);

  await page.getByLabel("基础URL").fill("http://127.0.0.1:9999/v1");
  await page.getByPlaceholder("请输入 API key").fill("sk-e2e");
  await page.getByPlaceholder("例如 deepseek-chat").fill("demo-model");

  await page.getByRole("button", { name: "测试并继续" }).click();

  // The test wrote the provider and its profile; only then is the way in
  // offered.
  await expect(page.getByText("✓ 基础检查通过", { exact: false })).toBeVisible();
  await expect(enter).toBeVisible();
  expect(mock.state.models.map((entry) => entry.model)).toEqual(["demo-model"]);
  const connectivityTests = () => mock.calls.filter(
    (call) => call.method === "POST" && /\/api\/models\/[^/]+\/test$/u.test(call.path),
  );
  expect(connectivityTests()).toHaveLength(1);

  await enter.click();
  await expect(page.locator(".app-shell")).toBeVisible();
  // The profile became the default, so the composer names it; the workspace is
  // the shell with its session list, not an empty page behind a spinner.
  expect(connectivityTests()).toHaveLength(1);
  await expect(page.getByText("科研会话", { exact: true })).toBeVisible();
  await expect(page.getByText("ScienceDiscovery", { exact: true })).toBeVisible();
  await expect(page.getByText("自定义网关", { exact: true })).toBeVisible();
  expect(mock.state.overrides.modelId).toBe("model-1");
});
