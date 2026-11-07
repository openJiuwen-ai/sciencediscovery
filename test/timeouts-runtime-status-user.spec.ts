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

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("timeouts-runtime-status-user.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@sandbox:bubblewrap"] }, () => {

const SCREENSHOTS = "screenshots";

/**
 * E2E-META
 * Purpose: 用户能在系统设置中读到默认超时策略与 Runtime Status 空态，且对话框可正常关闭。
 * Steps:
 *   1. 打开系统设置 → Timeouts。
 *   2. 断言 Agent idle timeout 默认 240 秒，其余四项默认 Unlimited。
 *   3. 打开 Runtime status，断言空态说明 Runner 健康且无执行。
 *   4. 通过标题栏 X 关闭对话框，确认其可访问名与底部按钮一致。
 * Environment: 隔离本地栈；没有活跃运行。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 只读本地设置页。
 * Credentials: 隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none
 */
test("用户视角：默认超时策略与 Runtime Status 可读性", { tag: "@mocked" }, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();

  // 1. 系统设置 → Timeouts：验证默认值
  await page.getByRole("button", { name: "System configuration" }).click();
  const configuration = page.getByRole("dialog", { name: "System configuration" });
  await configuration.getByRole("button", { name: "Timeouts" }).click();
  await expect(configuration.getByRole("heading", { name: "Timeouts" })).toBeVisible();

  // Agent 无响应默认 240 秒
  const idleInput = configuration.getByLabel("Agent idle timeout in seconds");
  await expect(idleInput).toHaveValue("240");

  // 其余四项默认 Unlimited
  for (const label of ["Agent turn", "Runner execution", "Kernel idle", "Permission wait"]) {
    const unlimited = configuration.locator("fieldset").filter({ hasText: label }).getByLabel("Unlimited");
    await expect(unlimited).toBeChecked();
  }
  await page.screenshot({ path: `${SCREENSHOTS}/timeouts-defaults.png` });

  // 2. Runtime Status 空态可读性
  await configuration.getByRole("button", { name: "Runtime status" }).click();
  await expect(configuration.getByRole("heading", { name: "Runtime status" })).toBeVisible();
  await expect(configuration.getByText("Runner is healthy; no execution is active.")).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOTS}/runtime-status-empty.png` });

  // The header's X carries the same accessible name as the footer button.
  await configuration.getByRole("button", { name: "Cancel and close" }).last().click();
});

// Kernel Teardown 场景仍无 E2E 入口：构造 persistent kernel 需要跨 API/Runner
// 的长时间运行与 kernel 保持会话，现有工具链没有一键入口，因此不编入可执行
// 用例，避免共享计划里出现一个永远只报 skip 的身份。
});
