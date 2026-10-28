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
 * Which settings survive leaving the dialog — and, for the one that lives on
 * the server, leaving the page. The default model is the representative case:
 * it is written through `PUT /api/settings`, read back by the next boot, and
 * has a visible mark on the row it applies to.
 */
import { expect, test } from "@playwright/test";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  type ModelRecord,
} from "./fixtures.js";

const MODELS: ModelRecord[] = [
  { id: "model-1", model: "qwen-max", name: "Qwen Max", providerId: "provider-1" },
  { id: "model-2", model: "qwen2.5-72b", name: "Qwen2.5", providerId: "provider-1" },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a default model chosen in 设置 is still the default after a reload", async ({ page }) => {
  const mock = await installMockApi(page, { models: MODELS, sessions: [] });
  await page.goto("/");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTitle("模型档案与服务商凭据").click();

  const rows = dialog.locator(".model-row");
  await expect(rows).toHaveCount(2);
  const second = rows.filter({ hasText: "Qwen2.5" });
  await expect(second.locator(".settings-tag")).toHaveCount(0);

  await second.getByRole("button", { name: "设为主模型" }).click();

  await expect(second.locator(".settings-tag")).toHaveText("主模型");
  await expect
    .poll(() => mock.state.overrides.modelId)
    .toBe("model-2");
  expect(
    mock.calls.some(
      (call) =>
        call.method === "PUT" &&
        call.path === "/api/settings" &&
        call.body?.includes('"modelId":"model-2"') === true,
    ),
  ).toBe(true);

  // The surface has no close control of its own; Escape is the keyboard's way
  // out, and the rail's 会话 the pointer's.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.reload();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const reopened = page.getByRole("dialog");
  await reopened.getByTitle("模型档案与服务商凭据").click();
  await expect(reopened.locator(".model-row").filter({ hasText: "Qwen2.5" }).locator(".settings-tag")).toHaveText(
    "主模型",
  );
  await expect(
    reopened.locator(".model-row").filter({ hasText: "Qwen Max" }).getByRole("button", { name: "设为主模型" }),
  ).toBeVisible();
});

test("the interface language is applied at once and remembered on this device", async ({ page }) => {
  await installMockApi(page, { models: MODELS, sessions: [] });
  await page.goto("/");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  // The page draws its own list rather than a native select: the trigger shows
  // only the language in force, and the other choice lives in the menu.
  await expect(dialog.getByRole("button", { name: "界面语言" })).toHaveText("简体中文");
  await dialog.getByRole("button", { name: "界面语言" }).click();
  // The menu is portalled to the body so the pane's scroll cannot clip it.
  await page.getByRole("option", { name: "English" }).click();

  // The whole tree re-renders, dialog included, without a save button.
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("sciencediscovery-desktop:locale")))
    .toBe("en");

  // One Escape leaves the settings surface; the page behind it is already in
  // English, which is what proves the choice was applied rather than stored.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
  await expect(page.getByText("Research sessions", { exact: true })).toBeVisible();

  await page.reload();

  await expect(page.getByText("Research sessions", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
