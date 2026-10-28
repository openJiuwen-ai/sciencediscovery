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
 * E2E-META
 * Purpose: The first-run wizard against a real endpoint: 测试并继续 must reach
 *          the provider before 开始使用 exists, and the shell opens afterwards.
 * Steps:
 *   1. Require an installation with no model profiles.
 *   2. Enter the real base URL, key and model in the wizard.
 *   3. Press 测试并继续 and wait for the real success reading.
 *   4. Press 开始使用 and wait for the shell.
 * Environment: A throwaway stack selected by E2E_BASE_URL (empty model catalog),
 *              plus the desktop Vite entry on 4176. This test writes the first
 *              model and makes it the default, so it must not target a stack
 *              whose data someone wants to keep.
 * Type: real
 * LLM: Real OpenAI-compatible endpoint; no stub or judge.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: none
 * OtherExternal: Configured model endpoint only.
 * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
 * CostSideEffects: One model probe and a lasting default profile on the
 *                  throwaway stack.
 */
import { expect, test } from "@playwright/test";

import { REAL_TAGS, api, requireEnv, requireStack, seedToken } from "./support.js";

test.beforeEach(async ({ page }, info) => {
  requireEnv(info, "E2E_API_TOKEN", "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  await requireStack(info);
  await seedToken(page);
});

test("the first-run wizard tests a real provider before unlocking the workspace", { tag: [...REAL_TAGS] }, async ({ page }, info) => {
  const models = await api<unknown[]>(page, "/api/models");
  if (models.length > 0) {
    info.skip(true, "needs an installation with no model profiles; point E2E_BASE_URL at a fresh stack");
  }

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "选择一个模型提供方" })).toBeVisible();
  const finish = page.getByRole("button", { name: "开始使用" });
  await expect(finish).toHaveCount(0);

  await page.getByLabel("基础URL").fill(process.env.E2E_LLM_BASE_URL ?? "");
  await page.getByPlaceholder("请输入 API key").fill(process.env.E2E_LLM_TOKEN ?? "");
  await page.getByPlaceholder("例如 deepseek-chat").fill(process.env.E2E_LLM_MODEL ?? "");

  await page.getByRole("button", { name: "测试并继续" }).click();

  await expect(page.getByText("✓ 连接成功", { exact: false })).toBeVisible({ timeout: 60_000 });
  await expect(finish).toBeVisible();

  await finish.click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.getByText("科研会话", { exact: true })).toBeVisible();
});
