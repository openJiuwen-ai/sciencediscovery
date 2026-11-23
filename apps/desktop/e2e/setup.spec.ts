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

  // No model and no account: the entry page is the whole app, offering the
  // account path and the bring-your-own-model path.
  await expect(page.getByRole("heading", { name: "登录后继续" })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);

  await page.getByRole("tab", { name: "自定义模型" }).click();
  await expect(page.getByRole("heading", { name: "配置你的模型" })).toBeVisible();
  const enter = page.getByRole("button", { name: "保存并进入工作台" });
  await expect(page.getByRole("heading", { name: "配置你的模型" })).toBeVisible();

  await page.getByLabel("基础URL").fill("http://127.0.0.1:9999/v1");
  await page.getByPlaceholder("请输入 API key").fill("sk-e2e");
  await page.getByPlaceholder("例如 deepseek-chat").fill("demo-model");

  await page.getByRole("button", { name: "测试并继续" }).click();

  // The test wrote the provider and its profile; only then is the way in
  // offered.
  await expect(page.getByText("✓ 基础检查通过", { exact: false })).toBeVisible();
  await expect(enter).toBeVisible();
  expect(mock.state.models.map((entry) => entry.model)).toEqual(["demo-model"]);

  await enter.click();
  await expect(page.locator(".app-shell")).toBeVisible();
});
