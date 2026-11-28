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
 * Purpose: Assert the session menu's flyouts stay inside the window at narrow widths.
 * Steps:
 *   1. Open a mocked session at 1280, 1024 and 960 CSS pixels wide.
 *   2. Open 会话设置, then the 审查档位 and 专家 rows, and measure each flyout.
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

/**
 * 会话设置 opens its choices beside the row column. Beside is not always on
 * screen: the flyout is 300px wide, the 专家 catalog 380px, and the shell hides
 * horizontal overflow, so past a certain window width its right border and the
 * end of every line were clipped with no scrollbar to reach them (#1487).
 *
 * These cases measure the flyout's right edge against the window's, at the
 * widths where the old stylesheet put it outside — and at 1280, where it was
 * already inside, so the assertion is not passing on a different layout.
 */
import { expect, test, type Locator } from "@playwright/test";

import { TOKEN, TOKEN_STORAGE_KEY, installMockApi, makeSession } from "./fixtures.js";

/** The gap the layout keeps between a flyout's right edge and the window's. */
const MARGIN = 8;

/** How far the element's right edge sits from the window's right edge, in CSS
 *  pixels. Negative means it ends outside the window. */
async function rightGap(locator: Locator): Promise<number> {
  return locator.evaluate((element) => window.innerWidth - element.getBoundingClientRect().right);
}

for (const width of [1280, 1024, 960]) {
  test(`the session menu's flyouts end inside a ${width}px window`, async ({ page }) => {
    await page.setViewportSize({ height: 820, width });
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [TOKEN_STORAGE_KEY, TOKEN] as const,
    );
    await installMockApi(page, {
      sessions: [makeSession()],
      specialists: [
        { description: "把晶体结构问题拆成可检验的假设。", id: "specialist-1", name: "晶体专家" },
      ],
    });

    await page.goto("/");
    await expect(page.locator(".side-session-name", { hasText: "晶体结构分析" })).toBeVisible();

    await page.getByRole("button", { name: "会话设置" }).click();
    const menu = page.locator(".session-menu");

    // 审查档位: the 300px card.
    await menu.getByRole("button", { name: "审查档位" }).click();
    const review = page.locator(".session-menu-flyout");
    await expect(review).toBeVisible();
    expect(await rightGap(review)).toBeGreaterThanOrEqual(MARGIN);

    // 专家: the 380px catalog, anchored by its bottom edge.
    await menu.getByRole("button", { name: "专家" }).click();
    const experts = page.locator(".session-menu-flyout.is-experts");
    await expect(experts).toBeVisible();
    await expect(experts.getByRole("button", { name: "晶体专家" })).toBeVisible();
    expect(await rightGap(experts)).toBeGreaterThanOrEqual(MARGIN);

    // Both cards keep their own width: the fix slides them, it does not squeeze
    // the 380px catalog into the window at the expense of its lines.
    expect(Math.round((await experts.boundingBox())?.width ?? 0)).toBe(380);
  });
}
