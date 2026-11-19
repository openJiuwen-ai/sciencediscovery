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
 * #1251's sidebar journey in a real browser, against the mock API: the search
 * field groups the workbench answer and opens a Session with the keyboard, and
 * the filter row narrows the loaded list and survives a reload.
 */
import { expect, test } from "@playwright/test";

import {
  CREATED_AT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
} from "./fixtures.js";

const SEARCH_RESULTS = [
  {
    detail: "Project",
    id: "project:project-1",
    kind: "project",
    label: "脓毒症研究",
    projectId: "project-1",
    projectName: "脓毒症研究",
  },
  {
    archived: true,
    detail: "脓毒症研究 · Archived",
    id: "session:session-2",
    kind: "session",
    label: "归档会话",
    projectId: "project-1",
    projectName: "脓毒症研究",
    sessionId: "session-2",
  },
  {
    detail: "脓毒症研究 / 归档会话",
    id: "artifact:a1",
    kind: "artifact",
    label: "report.pdf",
    path: "report.pdf",
    projectId: "project-1",
    projectName: "脓毒症研究",
    sessionId: "session-2",
    sessionTitle: "归档会话",
  },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("Ctrl+K searches, groups by kind and opens the archived Session with the keyboard", async ({ page }) => {
  const mock = await installMockApi(page, {
    searchResults: SEARCH_RESULTS,
    sessions: [
      makeSession(),
      makeSession({ archivedAt: CREATED_AT, id: "session-2", title: "归档会话" }),
    ],
  });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  // The shortcut listener is attached by the mounted field's effect; pressing
  // before the sidebar has rendered would test the browser, not the app.
  await expect(field).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(field).toBeFocused();

  await field.fill("归档");
  const headings = page.locator(".side-search-group-label");
  await expect(headings).toHaveCount(3);
  await expect(headings.nth(0)).toContainText("项目");
  await expect(headings.nth(1)).toContainText("会话");
  await expect(headings.nth(2)).toContainText("产物");
  // The archived Session says so, and its project context is visible.
  await expect(page.locator(".side-search-archived")).toHaveText("已归档");
  await expect(page.locator(".side-search-result")).toHaveCount(3);

  expect(mock.calls.some((call) => call.method === "GET" && call.path === "/api/search")).toBe(true);

  // The first row is the Project; Down selects the archived Session, Enter
  // opens it and puts the search away.
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(page.locator(".task-head-title")).toHaveText("归档会话");
  await expect(page.locator(".side-search-results")).toHaveCount(0);
});

test("Escape closes the results and restores the list", async ({ page }) => {
  await installMockApi(page, { searchResults: SEARCH_RESULTS });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();

  await page.keyboard.press("Control+k");
  await field.fill("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);
  await expect(page.locator(".side-scroll")).toBeHidden();

  await field.press("Escape");
  await expect(page.locator(".side-search-results")).toHaveCount(0);
  await expect(page.locator(".side-scroll")).toBeVisible();
  await expect(field).toHaveValue("");
});

test("仅运行中 narrows the session list and survives a reload", async ({ page }) => {
  await installMockApi(page, {
    runsBySession: {
      i1: [{ events: [], run: { createdAt: CREATED_AT, id: "run-1", queueOrder: 0, status: "running" } }],
    },
    sessions: [
      makeSession({ id: "i1", projectId: "inbox-1", title: "运行中的会话" }),
      makeSession({ id: "i2", projectId: "inbox-1", title: "已完成的会话" }),
    ],
  });
  await page.goto("/");

  const running = page.locator(".side-session-name", { hasText: "运行中的会话" });
  const finished = page.locator(".side-session-name", { hasText: "已完成的会话" });
  await expect(running).toBeVisible();
  await expect(finished).toBeVisible();

  await page.getByRole("button", { name: "仅运行中" }).click();
  await expect(running).toBeVisible();
  await expect(finished).toHaveCount(0);

  await page.reload();
  await expect(running).toBeVisible();
  await expect(finished).toHaveCount(0);

  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(finished).toBeVisible();
});

/** A page of Session results, for the panel's scroll and truncation cases. */
function manyResults(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    detail: "脓毒症研究",
    id: `session:s${index + 1}`,
    kind: "session",
    label: `会话 ${index + 1}`,
    projectId: "project-1",
    projectName: "脓毒症研究",
    sessionId: `s${index + 1}`,
  }));
}

test("the selected row is scrolled into view as the arrow keys move", async ({ page }) => {
  await installMockApi(page, { searchResults: manyResults(30) });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("会话");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(30);

  for (let index = 0; index < 20; index += 1) await field.press("ArrowDown");

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector(".side-search-results")!;
    const active = document.querySelector('[role="option"][aria-selected="true"]')!;
    const panelBox = panel.getBoundingClientRect();
    const activeBox = active.getBoundingClientRect();
    return {
      bottom: activeBox.bottom,
      panelBottom: panelBox.bottom,
      panelTop: panelBox.top,
      scrollTop: panel.scrollTop,
      top: activeBox.top,
    };
  });
  expect(geometry.scrollTop).toBeGreaterThan(0);
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.panelTop - 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.panelBottom + 1);
});

test("IME composition keeps the arrows and Escape for the candidate window", async ({ page }) => {
  await installMockApi(page, {
    searchResults: [
      { detail: "x", id: "session:s1", kind: "session", label: "第一个", projectId: "project-1", projectName: "脓毒症研究", sessionId: "s1" },
      { detail: "x", id: "session:s2", kind: "session", label: "第二个", projectId: "project-1", projectName: "脓毒症研究", sessionId: "s2" },
    ],
  });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("会话");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(2);
  const first = await page.locator('.side-search-results [role="option"][aria-selected="true"]').getAttribute("id");

  await field.evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, isComposing: true, key: "ArrowDown" }));
  });
  await expect(page.locator('.side-search-results [role="option"][aria-selected="true"]')).toHaveAttribute("id", first!);

  await field.evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, isComposing: true, key: "Escape" }));
  });
  await expect(field).toHaveValue("会话");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(2);

  // Once the composition ends the same keys act again.
  await field.press("ArrowDown");
  await expect(page.locator('.side-search-results [role="option"][aria-selected="true"]')).not.toHaveAttribute("id", first!);
});

test("Ctrl+K stays out of an aria-modal dialog and out of a rename field", async ({ page }) => {
  await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");
  await expect(page.locator(".side-session-name")).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.locator(".side-search-input")).not.toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // A rename field commits on blur: Ctrl+K must not move focus out of it.
  await page.locator(".side-session-name").first().dblclick();
  const rename = page.locator(".side-rename-input");
  await expect(rename).toBeVisible();
  await rename.fill("改到一半");
  await page.keyboard.press("Control+k");
  await expect(rename).toBeVisible();
  await expect(rename).toHaveValue("改到一半");
  await expect(page.locator(".side-search-input")).not.toBeFocused();
  await rename.press("Escape");
  await expect(page.locator(".side-session-name")).toHaveText("晶体结构分析");
});

test("a click outside closes the stale result view", async ({ page }) => {
  await installMockApi(page, { searchResults: SEARCH_RESULTS });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);

  await page.locator(".task-head-title").click();
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(0);
  await expect(field).toHaveValue("");
  await expect(page.locator(".side-scroll")).toBeVisible();
});

test("inbox artifacts and archived inbox Sessions are searchable", async ({ page }) => {
  await installMockApi(page, {
    artifactsBySession: {
      "inbox-1": [{
        artifact: {
          createdAt: CREATED_AT,
          createdInSessionId: "inbox-1",
          createdInSessionTitle: "晶体结构分析",
          currentVersion: 1,
          id: "artifact-9",
          kind: "report",
          logicalName: "晶体报告.pdf",
          name: "晶体报告.pdf",
          origin: "server_generated",
          projectId: "inbox-1",
          sessionId: "inbox-1",
          updatedAt: CREATED_AT,
        },
        version: { id: "version-9" },
      }],
    },
    searchResults: [],
    sessions: [
      makeSession({ id: "inbox-1", projectId: "inbox-1", title: "晶体结构分析" }),
      makeSession({ archivedAt: CREATED_AT, id: "inbox-2", projectId: "inbox-1", title: "归档晶体会话" }),
    ],
  });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");

  await field.fill("晶体报告");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(1);
  await expect(page.locator('.side-search-results [role="option"]')).toContainText("晶体报告.pdf");

  await field.fill("归档晶体");
  await expect(page.locator('.side-search-results [role="option"]')).toContainText("归档晶体会话");
  await expect(page.locator(".side-search-archived")).toHaveText("已归档");
});

test("the truncation notice wraps without overlapping the first group", async ({ page }) => {
  await installMockApi(page, {
    searchHasMore: true,
    searchResults: manyResults(250),
    // The server's maximum page plus a larger total: the notice wraps in the
    // 296 px column and must grow its row, not paint over the first heading.
    searchTotal: 123456,
  });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("会话");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(250);

  const notice = page.locator(".side-search-more");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("123456");
  const geometry = await page.evaluate(() => {
    const noticeBox = document.querySelector(".side-search-more")!.getBoundingClientRect();
    const statusBox = document.querySelector(".side-search-status")!.getBoundingClientRect();
    const groupBox = document.querySelector(".side-search-group-label")!.getBoundingClientRect();
    return {
      groupTop: groupBox.top,
      noticeBottom: noticeBox.bottom,
      noticeHeight: noticeBox.height,
      statusHeight: statusBox.height,
    };
  });
  // The two-line notice grows the status row instead of painting over the
  // first group heading.
  expect(geometry.noticeHeight).toBeGreaterThan(16);
  expect(geometry.statusHeight).toBeGreaterThanOrEqual(geometry.noticeHeight);
  expect(geometry.noticeBottom).toBeLessThanOrEqual(geometry.groupTop + 0.5);
  expect(await notice.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  })).toBe(true);
});

test("the search exposes combobox semantics and options are not tab stops", async ({ page }) => {
  await installMockApi(page, { searchResults: SEARCH_RESULTS });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);

  await expect(field).toHaveAttribute("role", "combobox");
  await expect(field).toHaveAttribute("aria-haspopup", "listbox");
  await expect(field).toHaveAttribute("aria-expanded", "true");
  const controls = await field.getAttribute("aria-controls");
  expect(controls).not.toBeNull();
  await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute("role", "listbox");
  const active = await field.getAttribute("aria-activedescendant");
  expect(active).not.toBeNull();
  await expect(page.locator(`[id="${active}"]`)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.side-search-group[role="group"]')).toHaveCount(3);
  await expect(page.locator(".side-search-status[aria-live='polite']")).toBeVisible();
  expect(await page.evaluate(() =>
    Array.from(document.querySelectorAll('.side-search-results [role="option"]')).every((option) => (option as HTMLElement).tabIndex === -1),
  )).toBe(true);
});

test("the English placeholder fits the 296 px field", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
  await installMockApi(page);
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Search names and titles");
  expect(await field.evaluate((input: HTMLInputElement) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = getComputedStyle(input).font;
    return context.measureText(input.placeholder).width <= input.clientWidth;
  })).toBe(true);
});

test("arrows and Escape keep working after focus leaves the field", async ({ page }) => {
  await installMockApi(page, {
    searchResults: [
      { detail: "x", id: "session:s1", kind: "session", label: "第一个", projectId: "project-1", projectName: "脓毒症研究", sessionId: "s1" },
      { detail: "x", id: "session:s2", kind: "session", label: "第二个", projectId: "project-1", projectName: "脓毒症研究", sessionId: "s2" },
    ],
  });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("会话");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(2);

  // Tab leaves the combobox for the clear button; the panel stays the active
  // surface, so the arrows and Escape still belong to it.
  await page.keyboard.press("Tab");
  await expect(field).not.toBeFocused();
  const first = await page.locator('.side-search-results [role="option"][aria-selected="true"]').getAttribute("id");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('.side-search-results [role="option"][aria-selected="true"]')).not.toHaveAttribute("id", first!);

  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(0);
  await expect(field).toBeFocused();
});

test("secondary text, the archived pill and the selected marker meet AA contrast", async ({ page }) => {
  await installMockApi(page, { searchResults: SEARCH_RESULTS });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);
  await field.press("ArrowDown");
  await field.press("ArrowUp");
  await field.focus();

  const measured = await page.evaluate(() => {
    const rgb = (value: string) => ((value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number));
    const luminance = (color: number[]) => color.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (first: string, second: string) => {
      const values = [luminance(rgb(first)), luminance(rgb(second))].sort((left, right) => right - left);
      return (values[0]! + 0.05) / (values[1]! + 0.05);
    };
    const sidebar = getComputedStyle(document.querySelector(".sidebar")!).backgroundColor;
    const hint = getComputedStyle(document.querySelector(".side-search-hint")!).color;
    const detail = getComputedStyle(document.querySelector(".side-search-result-detail")!).color;
    const selected = getComputedStyle(document.querySelector(".side-search-result.is-selected")!);
    const pill = getComputedStyle(document.querySelector(".side-search-archived")!);
    return {
      archived: ratio(pill.color, pill.backgroundColor),
      bar: selected.boxShadow.includes("25, 25, 25"),
      detail: ratio(detail, selected.backgroundColor),
      focus: ratio(getComputedStyle(document.querySelector(".side-search-field")!).borderTopColor, "rgb(255, 255, 255)"),
      hint: ratio(hint, sidebar),
    };
  });
  expect(measured.hint).toBeGreaterThanOrEqual(4.5);
  expect(measured.detail).toBeGreaterThanOrEqual(4.5);
  expect(measured.archived).toBeGreaterThanOrEqual(4.5);
  expect(measured.focus).toBeGreaterThanOrEqual(3);
  expect(measured.bar).toBe(true);
});

test("Escape closes an open dialog before the search panel", async ({ page }) => {
  await installMockApi(page, { searchResults: SEARCH_RESULTS });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);

  // Focus a control behind the results and activate it with the keyboard, so
  // the query is still open when the dialog appears.
  await page.getByRole("button", { name: "设置", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue("归档");
  const selected = await page.locator('.side-search-results [role="option"][aria-selected="true"]').getAttribute("id");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('.side-search-results [role="option"][aria-selected="true"]')).toHaveAttribute("id", selected!);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(field).toHaveValue("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);

});

test("Ctrl+K does not enter the new-project dialog", async ({ page }) => {
  await installMockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "新建项目" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel("项目名称");
  await name.fill("半截项目名");

  await page.keyboard.press("Control+k");
  await expect(page.locator(".side-search-input")).not.toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue("半截项目名");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Ctrl+K does not enter the first-run Guide", async ({ page }) => {
  await installMockApi(page, { guideSeen: false });
  await page.goto("/");
  const guide = page.locator(".tour-card");
  await expect(guide).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(page.locator(".side-search-input")).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
});

test("the composer keeps its arrows, Escape and Ctrl+K", async ({ page }) => {
  await installMockApi(page, { searchResults: SEARCH_RESULTS, sessions: [makeSession()] });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("归档");
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);

  const composer = page.locator("#composer-textarea");
  await expect(composer).toBeVisible();
  await composer.focus();
  await composer.fill("第一行\n第二行");
  const before = await composer.evaluate((element) => (element as HTMLTextAreaElement).selectionStart);
  await composer.press("ArrowUp");
  const after = await composer.evaluate((element) => (element as HTMLTextAreaElement).selectionStart);
  expect(after).toBeLessThan(before);
  await composer.press("Escape");
  await expect(field).toHaveValue("归档");
  await expect(composer).toBeFocused();
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);

  // Contract AC3: the shortcut focuses search from the composer too, while
  // the composer keeps its own Arrow/Escape behaviour above.
  await page.keyboard.press("Control+k");
  await expect(field).toBeFocused();
  await expect(composer).not.toBeFocused();
});

test("the empty result puts the full sentence as the block title", async ({ page }) => {
  await installMockApi(page, { searchResults: [] });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();
  await page.keyboard.press("Control+k");
  await field.fill("没有这个会话");

  const title = page.locator(".side-search-empty-title");
  const body = page.locator(".side-search-empty .side-search-note");
  await expect(title).toHaveText("没有匹配的会话、项目或产物");
  await expect(page.locator(".side-search-status")).toContainText("无结果");
  await expect(page.getByText("没有匹配的会话、项目或产物", { exact: true })).toHaveCount(1);
  const type = await page.evaluate(() => {
    const titleStyle = getComputedStyle(document.querySelector(".side-search-empty-title")!);
    const bodyStyle = getComputedStyle(document.querySelector(".side-search-empty .side-search-note")!);
    return { body: parseFloat(bodyStyle.fontSize), title: parseFloat(titleStyle.fontSize), weight: Number(titleStyle.fontWeight) };
  });
  expect(type.title).toBeGreaterThanOrEqual(type.body);
  expect(type.weight).toBeGreaterThanOrEqual(600);
});
