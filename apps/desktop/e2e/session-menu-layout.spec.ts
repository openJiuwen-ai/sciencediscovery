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
 * E2E-META
 * Purpose: Keep 会话设置's two flyouts inside the window at the widths where the fixed-width cards used to be clipped (#1487).
 * Steps:
 *   1. Open 审查档位 and 专家 in a mocked desktop session at 960×720 and 1024×720.
 *   2. Measure each card against the window, the panel and its own right border and row text.
 *   3. Resize an open 专家 card and prove it is measured again.
 * Environment: Isolated Desktop Vite app with deterministic local API mocks.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: fixture access token only
 * CostSideEffects: isolated browser state only
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  TOKEN,
  TOKEN_STORAGE_KEY,
  installMockApi,
  makeSession,
  type JsonRecord,
} from "./fixtures.js";

const EXPERTS: JsonRecord[] = [
  { description: "读晶体结构", enabled: true, id: "crystal", name: "晶体专家" },
  { description: "Searches the literature", enabled: true, id: "literature", name: "文献专家" },
];

/** The window margin every card has to keep (#1487). */
const MARGIN = 8;
/** The hairline between the row column and its card. */
const GAP = 4;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

async function boot(page: Page, width: number): Promise<{ mock: Awaited<ReturnType<typeof installMockApi>>; menu: Locator }> {
  await page.setViewportSize({ height: 720, width });
  const mock = await installMockApi(page, { sessions: [makeSession()], specialists: EXPERTS });
  await page.goto("/");
  await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();
  await page.getByRole("button", { name: "会话设置" }).click();
  const menu = page.locator(".session-menu");
  await expect(menu).toBeVisible();
  return { menu, mock };
}

/**
 * The card's box, its painted right border, and whether the text rows stay
 * inside it. A bounding box alone cannot tell a card that is laid out in the
 * window from one an ancestor's overflow has cut: the clipped part keeps its
 * box but stops being painted and hit-testable, which is what the bug lost —
 * the 1px right border and the end of every row (#1487).
 */
async function inspectCard(card: Locator): Promise<{
  box: { bottom: number; height: number; left: number; right: number; top: number; width: number };
  border: { color: string; style: string; width: string };
  rightEdgeIsPainted: boolean;
  textInside: { text: string; left: number; right: number; width: number; inside: boolean }[];
  innerWidth: number;
}> {
  return card.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const rightEdge = document.elementFromPoint(box.right - 1, box.top + box.height / 2);
    const texts = [...node.querySelectorAll(".session-flyout-label, .session-flyout-desc, .expert-name, .expert-desc")]
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => {
        const text = element.getBoundingClientRect();
        return {
          inside: text.left >= box.left && text.right <= box.right && text.width > 0,
          left: text.left,
          right: text.right,
          text: (element.textContent ?? "").trim(),
          width: text.width,
        };
      });
    return {
      border: {
        color: style.borderRightColor,
        style: style.borderRightStyle,
        width: style.borderRightWidth,
      },
      box: { bottom: box.bottom, height: box.height, left: box.left, right: box.right, top: box.top, width: box.width },
      innerWidth: window.innerWidth,
      rightEdgeIsPainted: rightEdge !== null && (rightEdge === node || node.contains(rightEdge)),
      textInside: texts,
    };
  });
}

/**
 * The whole assertion for one open card: it keeps the window margin, it is
 * flipped to the panel's left rather than drawn over the rows, and its right
 * border and row text are actually painted.
 */
async function expectCardBesidePanel(page: Page, card: Locator, panel: Locator): Promise<void> {
  await expect(card).toBeVisible();
  const cardBox = await card.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const width = viewport!.width;

  // Inside the window, and not on top of the rows the reader just opened.
  // These are the numbers the old absolute placement failed: 731 + 300 = 1031
  // at 1024, and 589 + 380 = 969 at 960.
  expect(cardBox!.x).toBeGreaterThanOrEqual(MARGIN);
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(width - MARGIN);
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(panelBox!.x - GAP + 0.01);
  expect(cardBox!.y).toBeGreaterThanOrEqual(MARGIN);

  const painted = await inspectCard(card);
  expect(painted.innerWidth).toBe(width);
  // A 1px solid border in the design's hairline colour is drawn on the edge
  // that used to fall outside the window.
  expect(painted.border).toEqual({ color: "rgb(236, 236, 236)", style: "solid", width: "1px" });
  // Hit-testing honours ancestor clipping, so this is only true when the right
  // edge is really on screen rather than laid out past an overflow box.
  expect(painted.rightEdgeIsPainted).toBe(true);
  // Every row's words are inside the card, and at least one of them proves the
  // rows are not empty placeholders.
  expect(painted.textInside.length).toBeGreaterThan(0);
  expect(painted.textInside.filter((row) => row.text !== "")).not.toHaveLength(0);
  expect(painted.textInside.filter((row) => !row.inside)).toEqual([]);
}

for (const width of [960, 1024]) {
  test(`both session-settings cards stay inside a ${width}px window`, async ({ page }) => {
    const { menu } = await boot(page, width);

    // 审查档位: 300px, anchored by the panel's top edge.
    await menu.getByRole("button", { name: "审查档位" }).click();
    const levelCard = page.locator(".session-menu-flyout").filter({ hasText: "快速" });
    await expect(levelCard).toBeVisible();
    await expectCardBesidePanel(page, levelCard, page.locator(".session-menu-panel"));
    await expect(levelCard.locator(".session-flyout-label")).toHaveText(["快速", "深度"]);
    await menu.getByRole("button", { name: "审查档位" }).click();
    await expect(page.locator(".session-menu-flyout")).toHaveCount(0);

    // 专家: 380px, anchored by the panel's bottom edge.
    await menu.getByRole("button", { name: "专家" }).click();
    const expertCard = page.locator(".session-menu-flyout.is-experts");
    await expect(expertCard).toBeVisible();
    await expectCardBesidePanel(page, expertCard, page.locator(".session-menu-panel"));
    await expect(expertCard.locator(".expert-name")).toContainText(["无", "晶体专家", "文献专家"]);
  });
}

test("a window resize measures the open card again instead of leaving it clipped", async ({ page }) => {
  const { menu } = await boot(page, 1280);
  await menu.getByRole("button", { name: "专家" }).click();
  const card = page.locator(".session-menu-flyout.is-experts");
  await expect(card).toBeVisible();

  // Wide enough to keep the preferred side: right of the panel.
  const wide = await card.boundingBox();
  const panelWide = await page.locator(".session-menu-panel").boundingBox();
  expect(wide!.x).toBeGreaterThan(panelWide!.x + panelWide!.width);
  expect(wide!.x + wide!.width).toBeLessThanOrEqual(1280 - MARGIN);

  await page.setViewportSize({ height: 720, width: 960 });
  const panel = page.locator(".session-menu-panel");
  // The listener measures again: the card moves to the panel's left, where the
  // wider panel left no room for the preferred side.
  await expect.poll(async () => {
    const [box, nextPanel] = await Promise.all([card.boundingBox(), panel.boundingBox()]);
    return box !== null && nextPanel !== null && box.x + box.width <= nextPanel.x - GAP + 0.01;
  }).toBe(true);
  await expectCardBesidePanel(page, card, panel);
});

test("a row in the portalled 专家 card still selects the expert", async ({ page }) => {
  const { menu, mock } = await boot(page, 960);
  await menu.getByRole("button", { name: "专家" }).click();
  const card = page.locator(".session-menu-flyout.is-experts");
  await expect(card).toBeVisible();

  // The card is outside the menu's DOM subtree; a press on it must be the
  // menu's own, or the outside-press dismissal would unmount it before the
  // click lands.
  await card.locator(".expert-row", { hasText: "晶体专家" }).click();
  await expect(page.locator(".session-menu")).toHaveCount(0);
  await expect
    .poll(() => mock.state.sessions[0]?.specialistId)
    .toBe("crystal");

  await page.getByRole("button", { name: "会话设置" }).click();
  await expect(page.locator(".session-menu").getByRole("button", { name: "专家" })).toContainText("晶体专家");
});
