/**
 * E2E-META
 * Purpose: Exercise the Desktop guide journey against the deterministic API fixture.
 * Steps:
 *   1. Open the Desktop browser entry and drive the user-facing interaction.
 *   2. Assert the resulting UI state and fixture-side request or persistence effect.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none; model behavior is deterministic fixture data.
 * WebSearch: none
 * PaperSources: none
 * MCP: deterministic fixture responses only where the journey requires them.
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
 * The first-run guide.
 *
 * Three things here need a browser rather than a static render: the ring has
 * to be drawn around the element the card names, the panel has to actually
 * open for the card that explains it, and the whole thing has to stay gone
 * after a reload. The copy itself is pinned by the unit tests.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CREATED_AT,
  GUIDE_STORAGE_KEY,
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
} from "./fixtures.js";

const GUIDE = "新手引导";

function guideCard(page: Page): Locator {
  return page.getByRole("dialog", { name: GUIDE });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("a new user is walked through the composer, 设置 and the panel, once", async ({ page }) => {
  await installMockApi(page, { guideSeen: false });
  await page.goto("/");

  const card = guideCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText("第 1 / 3 步");
  await expect(card).toContainText("对话框");

  // The ring frames the composer rather than merely being on screen: a
  // spotlight in the wrong place is worse than none, because it points.
  const spot = await page.locator(".tour-spotlight").boundingBox();
  const composer = await page.locator('[data-guide="composer"]').boundingBox();
  expect(spot).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(spot!.x).toBeLessThanOrEqual(composer!.x);
  expect(spot!.y).toBeLessThanOrEqual(composer!.y);
  expect(spot!.x + spot!.width).toBeGreaterThanOrEqual(composer!.x + composer!.width);
  expect(spot!.y + spot!.height).toBeGreaterThanOrEqual(composer!.y + composer!.height);

  await card.getByRole("button", { name: "下一步" }).click();
  await expect(card).toContainText("第 2 / 3 步");
  await expect(card).toContainText("设置");

  // The panel starts collapsed; the card that explains it opens it, and 上一步
  // puts it away again.
  const shell = page.locator(".app-shell");
  await expect(shell).toHaveClass(/workspace-hidden/);
  await card.getByRole("button", { name: "下一步" }).click();
  await expect(card).toContainText("第 3 / 3 步");
  await expect(card).toContainText("右侧栏");
  await expect(shell).not.toHaveClass(/workspace-hidden/);

  await card.getByRole("button", { name: "上一步" }).click();
  await expect(card).toContainText("第 2 / 3 步");
  await expect(shell).toHaveClass(/workspace-hidden/);

  await card.getByRole("button", { name: "下一步" }).click();
  await card.getByRole("button", { name: "开始使用" }).click();
  await expect(card).toHaveCount(0);
  // Reading three cards does not leave the window rearranged.
  await expect(shell).toHaveClass(/workspace-hidden/);

  // Read once is read for good.
  await page.reload();
  await expect(guideCard(page)).toHaveCount(0);
});

test("跳过 counts as having read it", async ({ page }) => {
  await installMockApi(page, { guideSeen: false });
  await page.goto("/");

  const card = guideCard(page);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "跳过" }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), GUIDE_STORAGE_KEY))
    .toBe("1");

  await page.reload();
  await expect(guideCard(page)).toHaveCount(0);
});

test("Escape ends it too, and the panel it opened goes back", async ({ page }) => {
  await installMockApi(page, { guideSeen: false });
  await page.goto("/");

  const card = guideCard(page);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "下一步" }).click();
  await card.getByRole("button", { name: "下一步" }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/workspace-hidden/);

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveClass(/workspace-hidden/);
});

test("the composer it points at is the welcome page's, not a transcript's", async ({ page }) => {
  const mock = await installMockApi(page, {
    guideSeen: false,
    sessions: [
      makeSession({
        messages: [{ content: "晶体结构分析", createdAt: CREATED_AT, id: "message-1", role: "user" }],
      }),
    ],
  });
  await page.goto("/");

  // Boot resumes the Session the sidebar lists, which would leave the composer
  // pinned to the bottom of its transcript. The tour is about the page a
  // conversation starts on, so it is shown over that one instead.
  const card = guideCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText("第 1 / 3 步");
  await expect(page.locator(".composer")).toHaveClass(/is-landing/);
  await expect(page.locator(".message.user")).toHaveCount(0);

  // Reaching the welcome page is not a new Session: nothing was written.
  expect(mock.state.sessions).toHaveLength(1);

  // The tour is for someone who has not started yet, so that is where it
  // leaves them — the Session is still in the sidebar, one click away.
  await card.getByRole("button", { name: "跳过" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".composer")).toHaveClass(/is-landing/);
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  expect(mock.state.sessions).toHaveLength(1);
});

test("设置 › 通用 replays it for someone who dismissed it", async ({ page }) => {
  await installMockApi(page, { sessions: [makeSession()] });
  await page.goto("/");

  // A returning user: the guide is not over the page at all.
  await expect(guideCard(page)).toHaveCount(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "重新查看" }).click();

  // The settings surface closes first: the cards point at the page behind it.
  await expect(settings).toHaveCount(0);
  const card = guideCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText("第 1 / 3 步");

  await card.getByRole("button", { name: "跳过" }).click();
  await expect(card).toHaveCount(0);
});
