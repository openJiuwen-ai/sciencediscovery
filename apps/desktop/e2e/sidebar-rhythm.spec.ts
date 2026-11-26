/**
 * E2E-META
 * Purpose: Prove the column's top three rows keep one rhythm: 搜索 sits as far under 导入会话 as 导入会话 sits under 新建会话.
 * Steps:
 *   1. Open the Desktop browser entry on the mocked API.
 *   2. Measure the bounding boxes of 新建会话, 导入会话 and 搜索.
 *   3. Open the field and measure its own distance from 导入会话.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none; model behavior is deterministic fixture data.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: none
 * CostSideEffects: none
 */
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
 * The column's top rows are one group, so the distance between them is one
 * number. The column spaces its sections 18px apart; 新建会话 and 导入会话 sit
 * 2px apart inside their own container, and 搜索 is the third row of that
 * group rather than a section of its own. This measures the boxes in a real
 * browser, because the distance is produced by three rules in two files and a
 * later edit to any of them (the container's gap, the column's gap, or the
 * negative margin that cancels it) would leave the static tests green.
 */
import { expect, test } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

const LOCALE_KEY = "sciencediscovery-desktop:locale";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([tokenKey, token, localeKey]) => {
      localStorage.setItem(tokenKey, token);
      localStorage.setItem(localeKey, "zh-CN");
    },
    [TOKEN_STORAGE_KEY, TOKEN, LOCALE_KEY] as const,
  );
});

test("搜索 sits in the same rhythm as 新建会话 and 导入会话", async ({ page }) => {
  await installMockApi(page, {
    projects: [{ createdAt: "2026-10-01T00:00:00.000Z", id: "project-1", name: "默认项目" }],
    sessions: [makeSession({ id: "session-a", projectId: "project-1", title: "probe run a" })],
  });
  await page.goto("/");

  const row = async (name: string) => {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, `${name} has a box`).not.toBeNull();
    return box!;
  };
  const gap = (above: { y: number; height: number }, below: { y: number }) =>
    Math.round(below.y - (above.y + above.height));

  const newTask = await row("新建会话");
  const importRow = await row("导入会话");
  const searchRow = await row("搜索");

  const withinGroup = gap(newTask, importRow);
  expect(withinGroup).toBe(2);
  expect(gap(importRow, searchRow), "搜索 is the group's third row").toBe(withinGroup);

  // The row becomes the field in place, so the field inherits that distance.
  await page.locator(".side-search-entry").click();
  const field = await page.locator(".side-search-field").boundingBox();
  expect(field, "the field replaced the row").not.toBeNull();
  expect(
    Math.round(field!.y - (importRow.y + importRow.height)),
    "the opened field sits where the row sat",
  ).toBe(withinGroup);
});
