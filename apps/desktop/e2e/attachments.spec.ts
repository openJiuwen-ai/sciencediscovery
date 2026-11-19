/**
 * E2E-META
 * Purpose: Exercise the Desktop attachments journey against the deterministic API fixture.
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
 * The files the composer is holding: the cards above the input, what each one
 * says about its upload, and the two ways a card leaves the tray — its own ×,
 * or the menu a long press on that × opens.
 */
import { expect, test, type Page } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/** Choose files through the composer's own button, the way a user does. */
async function choose(page: Page, names: string[]): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传文件" }).click();
  await (await chooser).setFiles(names.map((name) => ({
    buffer: Buffer.from("a,b\n1,2\n"),
    mimeType: name.endsWith(".png") ? "image/png" : "text/csv",
    name,
  })));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("each chosen file is a card above the input, with its type and size", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await choose(page, ["data.csv", "报告.pdf", "截图.png"]);

  const cards = page.locator(".attach-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.locator(".attach-name")).toHaveText(["data.csv", "报告.pdf", "截图.png"]);
  await expect(cards.locator(".attach-meta")).toHaveText(["CSV 8B", "PDF 8B", "PNG 8B"]);
  // Above the input, and inside the composer: the tray is part of what the turn
  // will carry rather than a list somewhere else on the page.
  const trayAboveInput = await page.evaluate(() => {
    const tray = document.querySelector(".attach-tray");
    const input = document.querySelector(".composer-input");
    return tray !== null && input !== null
      && Boolean(tray.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(trayAboveInput).toBe(true);
});

test("a file the route refuses is a failed card, and 重试 sends it again", async ({ page }) => {
  const mock = await installMockApi(page, {
    sessions: [],
    uploadRejects: ["broken.csv"],
  });
  await page.goto("/");

  await choose(page, ["broken.csv", "ok.csv"]);

  const broken = page.locator(".attach-card.is-failed");
  await expect(broken).toHaveCount(1);
  await expect(broken.locator(".attach-name")).toHaveText("broken.csv");
  await expect(broken.locator(".attach-meta")).toContainText("上传失败");
  await expect(page.locator(".attach-card.is-uploaded")).toHaveCount(1);

  // The route's refusal is also the reason the toast gives, once per file.
  await expect(page.locator(".toast.toast-error")).toContainText("broken.csv：refused by the fixture");

  mock.state.uploadRejects = [];
  await broken.getByRole("button", { name: "重试" }).click();

  await expect(page.locator(".attach-card.is-failed")).toHaveCount(0);
  await expect(page.locator(".attach-card.is-uploaded")).toHaveCount(2);
  expect(mock.state.files.map((file) => (file as { path: string }).path)).toEqual(["ok.csv", "broken.csv"]);
});

test("a card's × takes it out of the tray and leaves the uploaded file alone", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await choose(page, ["keep.csv", "remove.csv", "keep2.csv"]);
  await expect(page.locator(".attach-card")).toHaveCount(3);

  await page.getByRole("button", { name: "移除 remove.csv" }).click();

  await expect(page.locator(".attach-card")).toHaveCount(2);
  await expect(page.locator(".attach-name")).toHaveText(["keep.csv", "keep2.csv"]);
  // The card was the turn's plan, not the file: the workspace keeps it.
  expect(mock.state.files.map((file) => (file as { path: string }).path)).toEqual([
    "keep.csv",
    "remove.csv",
    "keep2.csv",
  ]);
});

test("a long press on a card's × offers 删除 and 清空附件", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await choose(page, ["one.csv", "two.csv"]);
  // Settled before the press: the card is re-rendered when its upload lands, and
  // a press that starts mid-render is a press on a node that is going away.
  await expect(page.locator(".attach-card.is-uploaded")).toHaveCount(2);
  const remove = page.getByRole("button", { name: "移除 one.csv" });

  // The press itself: a click would have deleted the card, so the menu is what
  // a press that is held answers.
  await remove.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();

  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["删除", "清空附件"]);

  await menu.getByRole("menuitem", { name: "清空附件" }).click();

  await expect(page.locator(".attach-card")).toHaveCount(0);
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
});

test("删除 in that menu takes only the card it was opened on", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await choose(page, ["one.csv", "two.csv"]);
  await expect(page.locator(".attach-card.is-uploaded")).toHaveCount(2);
  const remove = page.getByRole("button", { name: "移除 one.csv" });
  await remove.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();

  await page.locator(".ctx-menu").getByRole("menuitem", { name: "删除" }).click();

  await expect(page.locator(".attach-name")).toHaveText(["two.csv"]);
});

test("a selection over the ceiling says so and keeps the first 20", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await choose(page, Array.from({ length: 21 }, (_, index) => `file-${index + 1}.csv`));

  // The notice first: it is raised as the selection is cut, and 20 uploads take
  // long enough that a notice checked after them could already be gone.
  await expect(page.locator(".toast.toast-error")).toContainText("单次对话最多上传20个附件。");
  await expect(page.locator(".attach-card")).toHaveCount(20);
  await expect(page.locator(".attach-card").last().locator(".attach-name")).toHaveText("file-20.csv");
});

test("sending the turn clears the cards, and only the cards", async ({ page }) => {
  const mock = await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await choose(page, ["data.csv"]);
  await expect(page.locator(".attach-card.is-uploaded")).toHaveCount(1);

  await page.locator("#composer-textarea").fill("用这份数据画一张图");
  await page.locator("#composer-textarea").press("Enter");

  await expect(page.locator(".message.user")).toContainText("用这份数据画一张图");
  await expect(page.locator(".attach-card")).toHaveCount(0);
  expect(mock.state.files).toHaveLength(1);
});
