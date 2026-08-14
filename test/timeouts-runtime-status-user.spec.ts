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

import { expect, test } from "@playwright/test";

const SCREENSHOTS = "screenshots";

test("用户视角：默认超时策略与 Runtime Status 可读性", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

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

  await configuration.getByRole("button", { name: "Done" }).click();
});

test("Kernel Teardown 场景 — BLOCKED", async () => {
  test.skip(true, "构造 persistent kernel 需要跨 API/Runner 的长时间运行与 kernel 保持会话，现有 E2E 工具链未暴露一键入口；本轮标记为 BLOCKED 并在报告中说明原因。");
});
