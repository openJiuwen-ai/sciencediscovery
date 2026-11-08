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
 * The two writes a reader makes on a Project: rename and delete. A Project is
 * the user's own container, so it takes the same gestures a Session does — a
 * double-click on its name, a `⋯` menu — and the same gate before it goes.
 * Both writes are proved against the mock's state and against a reload, so
 * neither can pass on local React state alone.
 */
import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";

import { DEFAULT_PROJECT, TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a Project renamed by double-clicking its name is written through", async ({ page }) => {
  const mock = await installMockApi(page, { projects: [DEFAULT_PROJECT] });
  await page.goto("/");

  const fold = page.locator(".side-project-toggle", { hasText: "默认项目" });
  await expect(fold).toBeVisible();

  await fold.dblclick();
  const field = page.locator(".side-rename-input");
  await expect(field).toBeVisible();
  await field.fill("脓毒症研究");
  await field.press("Enter");

  // The column shows the server's answer, not the typed text, so a refusal
  // would leave the old name in place.
  await expect(page.locator(".side-project-toggle .label")).toHaveText("脓毒症研究");
  await expect.poll(() => mock.state.projects[0]?.name).toBe("脓毒症研究");
  expect(
    mock.calls.some(
      (call) =>
        call.method === "PATCH" &&
        call.path === "/api/projects/project-1" &&
        call.body?.includes("脓毒症研究") === true,
    ),
  ).toBe(true);

  await page.reload();

  await expect(page.locator(".side-project-toggle .label")).toHaveText("脓毒症研究");
});

test("a Project name too long for the column ends in … and still leaves room for its controls", async ({ page }) => {
  const name = "超长项目名称".repeat(12);
  await installMockApi(page, { projects: [{ ...DEFAULT_PROJECT, name }] });
  await page.goto("/");

  const row = page.locator(".side-row.side-project");
  const label = row.locator(".side-project-toggle .label");
  await expect(label).toBeVisible();

  // The name is clipped inside its own label, not laid out past the row: a
  // button's automatic minimum size is the whole name, which is how the fold
  // used to grow wider than the column and carry its `+` and `⋯` out of view.
  const clip = await label.evaluate((node) => ({
    ellipsis: getComputedStyle(node).textOverflow === "ellipsis",
    truncated: node.scrollWidth > node.clientWidth,
  }));
  assert.deepEqual(clip, { ellipsis: true, truncated: true });

  const add = page.getByRole("button", { name: `在「${name}」中新建会话` });
  const menu = page.getByRole("button", { name: "项目菜单" });
  // At rest the fold is quiet, like a Session row.
  await expect(add).toBeHidden();
  await expect(menu).toBeHidden();

  // Hovering brings both back, inside the row rather than beyond the column,
  // which clips its horizontal overflow.
  await row.hover();
  const rowBox = await row.boundingBox();
  assert.ok(rowBox, "the Project row has no box");
  for (const control of [add, menu]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    assert.ok(box, "a Project control has no box");
    assert.ok(
      box.x >= rowBox.x && box.x + box.width <= rowBox.x + rowBox.width + 1,
      "a Project control escaped its row",
    );
  }
});

test("deleting a Project asks first, then removes its fold", async ({ page }) => {
  const mock = await installMockApi(page, { projects: [DEFAULT_PROJECT] });
  await page.goto("/");

  // The fold's controls only take up space while the row is hovered or holds
  // the open Session; hovering is what a reader does to find them.
  await page.locator(".side-row.side-project").hover();
  await page.getByRole("button", { name: "项目菜单" }).click();
  // Click the menu's left edge: the column forms a stacking context, so the
  // part of the menu that overhangs the task pane is painted under it.
  await page.getByRole("menuitem", { name: "删除" }).click({ position: { x: 10, y: 10 } });

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // A Project takes its Sessions and their workspaces with it, and the body
  // says so before anything is written.
  await expect(
    dialog.getByText("删除项目「默认项目」会连同它下面的所有会话", { exact: false }),
  ).toBeVisible();

  await dialog.locator(".secondary-button").click();
  await expect(dialog).toBeHidden();
  expect(mock.state.projects).toHaveLength(1);

  // Dismissing the dialog moves the pointer off the row, which hides the
  // controls with it.
  await page.locator(".side-row.side-project").hover();
  await page.getByRole("button", { name: "项目菜单" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click({ position: { x: 10, y: 10 } });
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();

  await expect(page.locator(".side-project-toggle")).toHaveCount(0);
  await expect(page.getByText("还没有项目", { exact: true })).toBeVisible();
  await expect.poll(() => mock.state.projects.length).toBe(0);
  expect(
    mock.calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.path === "/api/projects/project-1" &&
        call.body?.includes("project-1") === true,
    ),
  ).toBe(true);

  await page.reload();

  await expect(page.getByText("还没有项目", { exact: true })).toBeVisible();
});

test("deleting the Project of the open Session leaves a draft in the inbox", async ({ page }) => {
  const mock = await installMockApi(page, {
    projects: [DEFAULT_PROJECT],
    sessions: [makeSession()],
  });
  await page.goto("/");

  // Open the Project's Session, so the conversation on screen is one the
  // delete is about to remove.
  await page.locator(".side-session-name", { hasText: "晶体结构分析" }).click();
  await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");

  await page.locator(".side-row.side-project").hover();
  await page.getByRole("button", { name: "项目菜单" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click({ position: { x: 10, y: 10 } });
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();

  // A draft, not a conversation that no longer exists: the bar is nameless and
  // the column has nothing left to list.
  await expect(page.locator(".task-head-title")).toHaveText("未命名会话");
  await expect(page.getByText("还没有会话", { exact: true })).toBeVisible();
  await expect.poll(() => mock.state.sessions.length).toBe(0);
});
