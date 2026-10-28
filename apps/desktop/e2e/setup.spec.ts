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

/**
 * The first run: no model, so the wizard is the whole app. This is the only
 * path by which a new install becomes usable, and the order of its steps — a
 * recorded directory, a passing environment check, then a tested provider — is
 * the guard rail.
 */
import { expect, test } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a workspace with no model cannot be used until the wizard's test passes", async ({ page }) => {
  const mock = await installMockApi(page, { models: [], sessions: [] });

  await page.goto("/");

  // Step one records where the user's data goes; it does not move anything.
  await expect(page.getByRole("heading", { name: "配置你的研究工作区" })).toBeVisible();
  // Nothing of the shell exists behind the wizard.
  await expect(page.locator(".app-shell")).toHaveCount(0);
  const finish = page.getByRole("button", { name: "开始使用" });
  await expect(finish).toHaveCount(0);
  await page.getByLabel("工作区目录").fill("/home/e2e/workspace");
  await page.getByRole("button", { name: "下一步" }).click();

  // Step two is the environment check; in a browser it reads the service the
  // page is already talking to.
  await expect(page.getByRole("heading", { name: "环境已就绪" })).toBeVisible();
  await expect(page.getByText("本地 API 服务", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一步：配置模型" }).click();

  // Step three is the provider, and it is the step that unlocks the app.
  await expect(page.getByRole("heading", { name: "选择一个模型提供方" })).toBeVisible();
  await expect(finish).toHaveCount(0);

  await page.getByLabel("基础URL").fill("http://127.0.0.1:9999/v1");
  await page.getByPlaceholder("请输入 API key").fill("sk-e2e");
  await page.getByPlaceholder("例如 deepseek-chat").fill("demo-model");

  await page.getByRole("button", { name: "测试并继续" }).click();

  // The test wrote the provider and its profile, and only then did the
  // continuation appear.
  await expect(page.getByText("✓ 连接成功", { exact: false })).toBeVisible();
  await expect(finish).toBeVisible();
  expect(mock.state.models.map((entry) => entry.model)).toEqual(["demo-model"]);

  await finish.click();

  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByText("科研会话", { exact: true })).toBeVisible();
  await expect(page.getByText("ScienceDiscovery", { exact: true })).toBeVisible();
  // The new profile became the default, so the composer names it rather than
  // claiming no model is configured.
  await expect(page.getByText("自定义网关", { exact: true })).toBeVisible();
  expect(mock.state.overrides.modelId).toBe("model-1");
});
