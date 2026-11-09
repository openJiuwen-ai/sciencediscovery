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
 * The writes a reader makes on the Session itself — create, rename, delete —
 * and when the sidebar admits one exists. Each is proved against the mock's
 * state and mostly against a reload, so the assertions cannot be satisfied by
 * local React state alone.
 */
import { expect, test } from "@playwright/test";

import {
  CREATED_AT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type ReplayRecord,
} from "./fixtures.js";

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
  // Both places that print the name follow the write immediately: the row,
  // and the bar over the conversation the row just renamed. The bar reads the
  // open Session's own record, so it has to hear the reply too.
  await expect(page.locator(".side-session-name", { hasText: "钙钛矿带隙" })).toBeVisible();
  await expect(page.locator(".task-head-title")).toHaveText("钙钛矿带隙");
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

test("a Session cannot be renamed to the sentinel that means it has no name", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  const name = page.locator(".side-session-name", { hasText: "晶体结构分析" });
  await name.dblclick();
  const field = page.locator(".side-rename-input");
  await field.fill("Untitled session");
  await field.press("Enter");

  // The service stores that title for a Session nobody has named, and the
  // column reads it as "no conversation yet". A conversation that took it as
  // a name would leave the sidebar and 会话 with its messages intact, so
  // the rename keeps the name it had and writes nothing.
  await expect(name).toHaveText("晶体结构分析");
  expect(mock.state.sessions[0]?.title).toBe("晶体结构分析");
  expect(mock.calls.some((call) => call.method === "PATCH")).toBe(false);
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

test("新建会话 writes no row until the first message names it", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-session-name")).toHaveCount(1);

  await page.getByRole("button", { name: "新建会话", exact: true }).click();

  // The Session exists on the server — the composer writes into it — but the
  // column lists conversations, and this one has nothing in it yet. A row here
  // would be a page the user has not said anything on.
  await expect.poll(() => mock.state.sessions.length).toBe(2);
  await expect(page.locator(".task-head-title")).toHaveText("未命名会话");
  await expect(page.locator(".side-session-name")).toHaveCount(1);

  await page.locator("#composer-textarea").fill("请分析这个晶体结构");
  await page.locator("#composer-textarea").press("Enter");

  // The first message names the Session, and the row arrives with it.
  await expect(page.locator(".side-session-name")).toHaveCount(2);
  await expect(
    page.locator(".side-session-name", { hasText: "请分析这个晶体结构" }),
  ).toBeVisible();
});

test("the first message names the bar as soon as it names the sidebar row", async ({ page }) => {
  // The read-back that follows a run is held open, so the bar can only show
  // the new name if it took it from the `session.updated` the service
  // publishes ahead of the run. Waiting for the read would leave the bar
  // saying 未命名会话 for as long as the answer streams.
  const mock = await installMockApi(page, {
    hold: { method: "GET", path: "/api/sessions/session-2" },
    sessions: [makeSession()],
  });
  await page.goto("/");
  // Boot resumes the Session the workspace already had; the click has to land
  // after that, or the resume's own open replaces the draft it makes.
  await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(page.locator(".task-head-title")).toHaveText("未命名会话");

  await page.locator("#composer-textarea").fill("请分析这个晶体结构");
  await page.locator("#composer-textarea").press("Enter");

  await expect(page.locator(".side-session-name", { hasText: "请分析这个晶体结构" })).toBeVisible();
  await expect(page.locator(".task-head-title")).toHaveText("请分析这个晶体结构");

  // The held read still lands, and what it brings agrees with the bar.
  mock.release();
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await expect(page.locator(".message.assistant")).toContainText("晶格常数是 5.43 Å。");
  await expect(page.locator(".task-head-title")).toHaveText("请分析这个晶体结构");
});

test("a run's replayed record cannot undo a newer name", async ({ page }) => {
  // Followed from cursor 0, an unfinished run replays every event it has
  // already written — including the `session.updated` that named the Session
  // before the reader renamed it. Coming back mid-run therefore puts an older
  // copy of the record in front of a page that has just read a newer one, and
  // taking it would send the bar back to the old name while the sidebar row,
  // read fresh, keeps the new one. The event is held open until the spec is
  // looking, so the assertions cannot be satisfied by the replay never having
  // arrived.
  const runs: ReplayRecord[] = [];
  const mock = await installMockApi(page, {
    hold: { method: "GET", path: /\/runs\/run-1\/events$/ },
    runsBySession: { "session-1": runs },
    sessions: [
      makeSession(),
      makeSession({ id: "session-2", title: "另一个会话", updatedAt: CREATED_AT }),
    ],
  });
  await page.goto("/");
  await expect(page.locator(".task-head-title")).toHaveText("晶体结构分析");

  await page.locator(".task-head-title").dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("会话名称");
  await field.fill("钙钛矿带隙");
  await field.press("Enter");
  await expect(page.locator(".task-head-title")).toHaveText("钙钛矿带隙");

  // The run was already going when the name was changed, so its log still
  // holds the record written before it — the old name, and the permission the
  // Session had then.
  runs.push({
    events: [
      { session: { ...makeSession(), approvalMode: "always_allow" }, type: "session.updated" },
      { model: { name: "Qwen Max" }, runId: "run-1", settings: {}, type: "run.started" },
      { responseId: "response-1", turn: 1, type: "assistant.response.started" },
      { delta: "旧运行仍在继续", responseId: "response-1", turn: 1, type: "assistant.delta" },
    ],
    run: {
      createdAt: CREATED_AT,
      id: "run-1",
      prompt: "分析晶体结构",
      queueOrder: 0,
      sessionId: "session-1",
      status: "running",
    },
  });

  await page.locator(".side-session-name", { hasText: "另一个会话" }).click();
  await expect(page.locator(".task-head-title")).toHaveText("另一个会话");
  await page.locator(".side-session-name", { hasText: "钙钛矿带隙" }).click();
  // The read this open makes already carries the new name; the replay is what
  // is still in flight.
  await expect(page.locator(".task-head-title")).toHaveText("钙钛矿带隙");

  mock.release();
  await expect(page.locator(".message.assistant")).toContainText("旧运行仍在继续");
  // The replay landed and changed nothing it was not entitled to change.
  await expect(page.locator(".task-head-title")).toHaveText("钙钛矿带隙");
  await expect(page.locator(".side-session-name", { hasText: "钙钛矿带隙" })).toBeVisible();

  // The composer's permission row reads the same record: the replay carried the
  // older 完全访问 with the older name, and neither may land.
  await page.getByRole("button", { name: "会话设置" }).click();
  await expect(
    page.getByRole("button", { name: /权限模式/u }).locator(".session-menu-value"),
  ).toHaveText("询问");
});

test("a draft left in one Project is not carried to the next", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-session-name")).toHaveCount(1);

  // A Session made and left empty stays where it was made: on the server, in
  // its Project, and out of the sidebar until something is said in it.
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect.poll(() => mock.state.sessions.length).toBe(2);

  await page.getByRole("button", { name: "新建项目" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("项目名称").fill("钙钛矿");
  await dialog.getByRole("button", { name: "确认" }).click();

  // A new Project opens on its own empty Session, and neither Project lists a
  // row for a conversation nobody has had.
  await expect(page.locator(".side-project-toggle", { hasText: "钙钛矿" })).toBeVisible();
  await expect(page.locator(".task-head-title")).toHaveText("未命名会话");
  await expect(page.locator(".side-session-name")).toHaveCount(1);
  await expect.poll(() => mock.state.sessions.length).toBe(3);
});
