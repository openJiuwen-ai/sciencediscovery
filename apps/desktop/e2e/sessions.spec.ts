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
 * The two writes a reader makes on the Session itself: rename and delete.
 * Both are proved against the mock's state and then against a reload, so the
 * assertions cannot be satisfied by local React state alone.
 */
import { expect, test } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a title renamed in the bar is written through and survives a reload", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");

  await page.locator(".task-head-title").dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("会话名称");
  await field.fill("钙钛矿带隙");
  await field.press("Enter");

  await expect(dialog).toBeHidden();
  // The list follows the write immediately. The header reads `detail.title`,
  // which no current action refreshes after a rename, so the reload below is
  // where the bar is checked.
  await expect(page.locator(".side-session-name", { hasText: "钙钛矿带隙" })).toBeVisible();
  await expect.poll(() => mock.state.sessions[0]?.title).toBe("钙钛矿带隙");
  expect(
    mock.calls.some(
      (call) =>
        call.method === "PATCH" &&
        call.path === "/api/sessions/session-1" &&
        call.body?.includes("钙钛矿带隙") === true,
    ),
  ).toBe(true);

  await page.reload();

  await expect(page.locator(".task-head-title")).toHaveText("钙钛矿带隙");
});

test("deleting the open Session asks first, then returns to a draft", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();

  await page.getByRole("button", { name: "会话菜单" }).click();
  // Click the menu's left edge: the column forms a stacking context, so the
  // part of the menu that overhangs the task pane is painted under it (a
  // known defect, reported separately). The item itself is reachable.
  await page.getByRole("menuitem", { name: "删除" }).click({ position: { x: 10, y: 10 } });

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The consequence is spelled out, not just the verb.
  await expect(dialog.getByText("连同它的工作区数据一起清掉", { exact: false })).toBeVisible();
  // The footer's 取消; the header's × carries the same accessible name.
  await dialog.locator(".secondary-button").click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  expect(mock.state.sessions).toHaveLength(1);

  await page.getByRole("button", { name: "会话菜单" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click({ position: { x: 10, y: 10 } });
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();

  // The draft left behind has no title until its first message, so the bar
  // says the same 未命名会话 the sidebar uses for a Session the server has not
  // named.
  await expect(page.locator(".task-head-title")).toHaveText("未命名会话");
  await expect(page.getByText("暂无会话", { exact: true })).toBeVisible();
  await expect.poll(() => mock.state.sessions.length).toBe(0);
  expect(
    mock.calls.some((call) => call.method === "DELETE" && call.path === "/api/sessions/session-1"),
  ).toBe(true);

  await page.reload();

  // The reload resumes nothing, because the Session is gone on the server too.
  await expect(page.getByText("暂无会话", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ScienceDiscovery" })).toBeVisible();
});
