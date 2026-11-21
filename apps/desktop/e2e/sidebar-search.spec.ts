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
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  CREATED_AT,
  DEFAULT_PROJECT,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
} from "./fixtures.js";

/** The opt-in capture hook used by `research-package.spec.ts`: a run with
 *  `REVIEW_SCREENSHOTS_DIR` set writes the reviewer-facing PNGs, and an
 *  ordinary run only asserts the state. */
const REVIEW_SCREENSHOTS_DIR = process.env.REVIEW_SCREENSHOTS_DIR;

async function capture(page: Page, name: string): Promise<void> {
  if (!REVIEW_SCREENSHOTS_DIR) return;
  await mkdir(REVIEW_SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(REVIEW_SCREENSHOTS_DIR, `${name}.png`), animations: "disabled" });
}

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
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await capture(page, "sidebar-search-empty");

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
  await capture(page, "sidebar-search-grouped");

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
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await capture(page, "sidebar-filter-running");

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
  await expect(field).toHaveAttribute("placeholder", "Search");
  expect(await field.evaluate((input: HTMLInputElement) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = getComputedStyle(input).font;
    return context.measureText(input.placeholder).width <= input.clientWidth;
  })).toBe(true);
});

test("the field is one word, has no caption and follows the session-row rhythm", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMockApi(page, { sessions: [makeSession({ id: "i1", projectId: "inbox-1", title: "会话一" })] });
  await page.goto("/");
  const field = page.locator(".side-search-input");
  await expect(field).toBeVisible();

  // The field says only what it is; the accessible name carries the scope and
  // the `kbd` chip carries the shortcut, so there is no caption or tooltip.
  await expect(field).toHaveAttribute("placeholder", "搜索");
  await expect(field).not.toHaveAttribute("title", /./);
  await expect(page.locator(".side-search-hint")).toHaveCount(0);

  const geometry = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const fieldBox = box(".side-search-field");
    const importBox = box(".side-import-button");
    const newTaskBox = box(".side-new");
    return {
      buttons: importBox.top - newTaskBox.bottom,
      fieldHeight: fieldBox.height,
      gapAbove: fieldBox.top - importBox.bottom,
      inset: fieldBox.left - importBox.left,
      width: importBox.width - fieldBox.width,
    };
  });
  // The 36 px row height, the rows' 12 px horizontal inset, and the same
  // vertical gap the two buttons above it use (the column gap plus the 2 px
  // `.side-new` margin), so the block is not a third spacing rhythm.
  expect(geometry.fieldHeight).toBe(36);
  expect(Math.round(geometry.inset)).toBe(12);
  expect(Math.round(geometry.width)).toBe(24);
  expect(Math.round(geometry.buttons)).toBe(20);
  expect(Math.round(geometry.gapAbove)).toBe(Math.round(geometry.buttons));
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
    const detail = getComputedStyle(document.querySelector(".side-search-result-detail")!).color;
    const selected = getComputedStyle(document.querySelector(".side-search-result.is-selected")!);
    const pill = getComputedStyle(document.querySelector(".side-search-archived")!);
    return {
      archived: ratio(pill.color, pill.backgroundColor),
      bar: selected.boxShadow.includes("25, 25, 25"),
      detail: ratio(detail, selected.backgroundColor),
      focus: ratio(getComputedStyle(document.querySelector(".side-search-field")!).borderTopColor, "rgb(255, 255, 255)"),
    };
  });
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
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await capture(page, "sidebar-search-no-results");
});

test("仅当前项目 keeps only the open Project's rows and leaves the other fold reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMockApi(page, {
    projects: [
      { ...DEFAULT_PROJECT, id: "project-1", name: "脓毒症研究" },
      { ...DEFAULT_PROJECT, id: "project-2", name: "晶体结构研究" },
    ],
    sessions: [
      makeSession({ id: "s1", projectId: "project-1", title: "本项目的会话" }),
      makeSession({ id: "s2", projectId: "project-2", title: "别的项目的会话" }),
    ],
  });
  await page.goto("/");

  await page.locator(".side-session-name", { hasText: "本项目的会话" }).click();
  await expect(page.locator(".task-head-title")).toHaveText("本项目的会话");
  await page.getByRole("button", { name: "仅当前项目" }).click();

  await expect(page.getByRole("button", { name: "仅当前项目" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".side-session-name", { hasText: "本项目的会话" })).toBeVisible();
  await expect(page.locator(".side-session-name", { hasText: "别的项目的会话" })).toHaveCount(0);
  // The filter scopes rows, not navigation: the other Project is still there.
  await expect(page.locator(".side-project-toggle", { hasText: "晶体结构研究" })).toBeVisible();
  await capture(page, "sidebar-filter-current-project");
});

test("有产物 keeps the Session that wrote an output, in the English locale", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
  await installMockApi(page, {
    artifactsBySession: {
      i1: [{
        artifact: {
          createdAt: CREATED_AT,
          createdInSessionId: "i1",
          createdInSessionTitle: "Session with artifact",
          currentVersion: 1,
          id: "artifact-1",
          kind: "report",
          logicalName: "report.pdf",
          name: "report.pdf",
          origin: "server_generated",
          projectId: "inbox-1",
          sessionId: "i1",
          updatedAt: CREATED_AT,
        },
        version: { id: "version-1" },
      }],
    },
    sessions: [
      makeSession({ id: "i1", projectId: "inbox-1", title: "Session with artifact" }),
      makeSession({ id: "i2", projectId: "inbox-1", title: "Session without artifact" }),
    ],
  });
  await page.goto("/");

  const withArtifact = page.locator(".side-session-name", { hasText: "Session with artifact" });
  const withoutArtifact = page.locator(".side-session-name", { hasText: "Session without artifact" });
  await expect(withArtifact).toBeVisible();
  await expect(withoutArtifact).toBeVisible();

  await page.getByRole("button", { name: "Has artifacts" }).click();

  await expect(page.getByRole("button", { name: "Has artifacts" })).toHaveAttribute("aria-pressed", "true");
  await expect(withArtifact).toBeVisible();
  await expect(withoutArtifact).toHaveCount(0);
  await expect(page.getByLabel("Time range")).toBeVisible();
  await capture(page, "sidebar-filter-has-artifacts-en");
});

test("the today window hides a Session last active before the local day", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const now = new Date().toISOString();
  const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await installMockApi(page, {
    sessions: [
      makeSession({ createdAt: now, id: "i1", projectId: "inbox-1", title: "今天的会话", updatedAt: now }),
      makeSession({ createdAt: older, id: "i2", projectId: "inbox-1", title: "十天前的会话", updatedAt: older }),
    ],
  });
  await page.goto("/");

  const today = page.locator(".side-session-name", { hasText: "今天的会话" });
  const beforeToday = page.locator(".side-session-name", { hasText: "十天前的会话" });
  await expect(today).toBeVisible();
  await expect(beforeToday).toBeVisible();

  await page.getByLabel("时间范围").selectOption("today");

  await expect(today).toBeVisible();
  await expect(beforeToday).toHaveCount(0);
  await expect(page.getByLabel("时间范围")).toHaveValue("today");
  await capture(page, "sidebar-filter-today");
});

test("an English search failure offers Retry outside the listbox and recovers", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
  await installMockApi(page, { searchResults: SEARCH_RESULTS });
  let fail = true;
  await page.route("**/api/search**", route => fail
    ? route.fulfill({ status: 503, json: { error: "Search service unavailable" } })
    : route.fallback());
  await page.goto("/");

  const field = page.locator(".side-search-input");
  await expect(field).toHaveAttribute("placeholder", "Search");
  await page.keyboard.press("Control+k");
  await field.fill("archive");

  const error = page.locator(".side-search-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("Search failed");
  const retry = error.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await capture(page, "sidebar-search-failed-en");

  fail = false;
  await retry.click();
  await expect(page.locator('.side-search-results [role="option"]')).toHaveCount(3);
  await expect(field).toHaveAttribute("aria-expanded", "true");
});

test("a failed filter read says the result is unknown and Retry recovers the rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMockApi(page, {
    runsBySession: {
      i1: [{ events: [], run: { createdAt: CREATED_AT, id: "run-1", queueOrder: 0, status: "running" } }],
    },
    sessions: [
      makeSession({ id: "i1", projectId: "inbox-1", title: "运行中的会话" }),
      makeSession({ id: "i2", projectId: "inbox-1", title: "已完成的会话" }),
    ],
  });
  let fail = true;
  await page.route("**/api/sessions/*/runs", route => fail
    ? route.fulfill({ status: 503, json: { error: "运行状态暂不可用" } })
    : route.fallback());
  await page.goto("/");

  const running = page.locator(".side-session-name", { hasText: "运行中的会话" });
  const finished = page.locator(".side-session-name", { hasText: "已完成的会话" });
  await expect(running).toBeVisible();
  await expect(finished).toBeVisible();

  await page.getByRole("button", { name: "仅运行中" }).click();

  const failed = page.locator(".side-filters-failed");
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("运行状态或产物读取失败");
  const retry = failed.getByRole("button", { name: "重试" });
  await expect(retry).toBeVisible();
  // Unknown is not the same answer as "none".
  await expect(page.locator(".side-empty", { hasText: "暂时无法判断" })).toBeVisible();
  await capture(page, "sidebar-filter-failed");

  fail = false;
  await retry.click();
  await expect(running).toBeVisible();
  await expect(finished).toHaveCount(0);
});

test("仅当前项目 in the English locale keeps only the open Project's rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
  await installMockApi(page, {
    projects: [
      { ...DEFAULT_PROJECT, id: "project-1", name: "Sepsis study" },
      { ...DEFAULT_PROJECT, id: "project-2", name: "Crystal study" },
    ],
    sessions: [
      makeSession({ id: "s1", projectId: "project-1", title: "Session in this project" }),
      makeSession({ id: "s2", projectId: "project-2", title: "Session in the other project" }),
    ],
  });
  await page.goto("/");

  await page.locator(".side-session-name", { hasText: "Session in this project" }).click();
  await expect(page.locator(".task-head-title")).toHaveText("Session in this project");
  await page.getByRole("button", { name: "Current project" }).click();

  await expect(page.getByRole("button", { name: "Current project" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".side-session-name", { hasText: "Session in this project" })).toBeVisible();
  await expect(page.locator(".side-session-name", { hasText: "Session in the other project" })).toHaveCount(0);
  // The filter scopes rows, not navigation: the other Project is still there.
  await expect(page.locator(".side-project-toggle", { hasText: "Crystal study" })).toBeVisible();
  await capture(page, "sidebar-filter-current-project-en");
});

test("the today window in the English locale hides a Session last active before the local day", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
  const now = new Date().toISOString();
  const older = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await installMockApi(page, {
    sessions: [
      makeSession({ createdAt: now, id: "i1", projectId: "inbox-1", title: "Session from today", updatedAt: now }),
      makeSession({ createdAt: older, id: "i2", projectId: "inbox-1", title: "Session from ten days ago", updatedAt: older }),
    ],
  });
  await page.goto("/");

  const today = page.locator(".side-session-name", { hasText: "Session from today" });
  const beforeToday = page.locator(".side-session-name", { hasText: "Session from ten days ago" });
  await expect(today).toBeVisible();
  await expect(beforeToday).toBeVisible();

  await page.getByLabel("Time range").selectOption("today");

  await expect(page.getByLabel("Time range")).toHaveValue("today");
  await expect(today).toBeVisible();
  await expect(beforeToday).toHaveCount(0);
  await capture(page, "sidebar-filter-today-en");
});

test("a failed filter read in the English locale says unknown and offers Retry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("sciencediscovery-desktop:locale", "en"));
  await installMockApi(page, {
    runsBySession: {
      i1: [{ events: [], run: { createdAt: CREATED_AT, id: "run-1", queueOrder: 0, status: "running" } }],
    },
    sessions: [
      makeSession({ id: "i1", projectId: "inbox-1", title: "Running session" }),
      makeSession({ id: "i2", projectId: "inbox-1", title: "Finished session" }),
    ],
  });
  let fail = true;
  await page.route("**/api/sessions/*/runs", route => fail
    ? route.fulfill({ status: 503, json: { error: "Run state unavailable" } })
    : route.fallback());
  await page.goto("/");

  const running = page.locator(".side-session-name", { hasText: "Running session" });
  const finished = page.locator(".side-session-name", { hasText: "Finished session" });
  await expect(running).toBeVisible();
  await expect(finished).toBeVisible();

  await page.getByRole("button", { name: "Running", exact: true }).click();

  const failed = page.locator(".side-filters-failed");
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("Run or artifact data could not be read");
  const retry = failed.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  // Unknown is not the same answer as "none".
  await expect(page.locator(".side-empty", { hasText: "Could not read the filter data" })).toBeVisible();
  await capture(page, "sidebar-filter-failed-en");

  fail = false;
  await retry.click();
  await expect(running).toBeVisible();
  await expect(finished).toHaveCount(0);
});
