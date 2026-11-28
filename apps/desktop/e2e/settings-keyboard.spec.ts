/**
 * E2E-META
 * Purpose: Assert that the Desktop settings surface holds the keyboard the way its backdrop holds the pointer.
 * Steps:
 *   1. Open 设置 from the rail and read where the keyboard is: the panel itself, then its first control.
 *   2. Walk Tab across the whole surface, sixty presses, and check the focus never leaves the panel.
 *   3. Press Escape and check the focus returns to the control that opened it.
 *   4. Open 添加模型 over the panel and walk twenty Tabs: the focus stays inside the panel and reaches the nested dialog.
 *   5. Check the backdrop starts at the rail, the rail stays clickable, and the page behind is covered.
 *   6. Open the capability drawer inside 新增专家 and walk Tab from its 确定: the focus stays in the drawer.
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
 * 设置 covers the page and swallows every click, so the pointer can only reach
 * the surface itself. The keyboard used to be free to leave: opening it left
 * `document.activeElement` on the rail's 设置 button, the first 23 Tabs walked
 * the page the backdrop was hiding, and on the 47th the focus fell to `BODY`
 * and came round to that page again — a dialog a keyboard could walk out of.
 *
 * The counts are the measurement in #1485. What these cases assert is the
 * shape of it rather than the number: where the focus is on open, that no Tab
 * leaves the panel, and that Escape hands the focus back to the rail.
 */
import { expect, test, type Page } from "@playwright/test";

import { installMockApi, TOKEN, TOKEN_STORAGE_KEY } from "./fixtures.js";

/** Where the keyboard is, described without holding on to a handle that a
 *  re-render would invalidate. */
async function focused(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return { inDialog: false, isPanel: false, stop: null, key: "none" };
    return {
      inDialog: element.closest(".config-panel") !== null,
      isPanel: element.classList.contains("config-panel"),
      // `markStops` numbers every control in the panel, so two stops can be
      // told apart without depending on their labels.
      stop: element.getAttribute("data-tab-stop"),
      key: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? element.tagName,
    };
  });
}

/** Numbers the controls inside the panel, in document order. Only an identity
 *  for the assertions: nothing about tab order or visibility is decided here. */
async function markStops(page: Page) {
  await page.evaluate(() => {
    const panel = document.querySelector(".config-panel");
    if (!panel) return;
    panel.querySelectorAll("button, input, textarea, select, a[href], summary, [tabindex]").forEach((element, index) => {
      element.setAttribute("data-tab-stop", String(index));
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [TOKEN_STORAGE_KEY, TOKEN] as const,
  );
});

test("打开设置后键盘在对话框里，一次 Tab 也不会落到被遮住的页面上", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await markStops(page);

  // The surface takes the focus itself, the way 导入会话 and 我要反馈 already do
  // (#1485): what a reader hears announced is the dialog, not the rail button
  // they just left, and Tab continues from inside it.
  const opened = await focused(page);
  expect(opened.isPanel, `focus after opening stayed on ${opened.key}`).toBe(true);
  expect(opened.inDialog).toBe(true);

  await page.keyboard.press("Tab");
  const first = await focused(page);
  expect(first.inDialog, `the first Tab went to ${first.key} instead of into the dialog`).toBe(true);
  expect(first.isPanel).toBe(false);
  expect(first.stop, `the first Tab landed on ${first.key}, which is not a control in the panel`).not.toBeNull();
});

test("Tab 走到面板末尾会绕回起点，焦点始终不出对话框", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await markStops(page);

  // The last stop is found from the boundary, not from a hard-coded label:
  // Shift+Tab off the panel lands on it.
  await page.evaluate(() => (document.querySelector(".config-panel") as HTMLElement | null)?.focus());
  await page.keyboard.press("Shift+Tab");
  const last = await focused(page);
  expect(last.inDialog, `Shift+Tab off the panel went to ${last.key}`).toBe(true);
  expect(last.stop).not.toBeNull();

  await page.keyboard.press("Tab");
  const wrapped = await focused(page);
  expect(wrapped.inDialog).toBe(true);
  expect(wrapped.stop, `Tab at the last stop (${last.key}) did not wrap to the first`).not.toBe(last.stop);

  await page.keyboard.press("Shift+Tab");
  const back = await focused(page);
  expect(back.inDialog).toBe(true);
  expect(back.stop, "Shift+Tab at the first stop did not wrap back to the last").toBe(last.stop);

  // What #1485 measured was a count — 23 Tabs through the page behind, the
  // 47th to `BODY`. Sixty presses is past both numbers, and the panel holds
  // the focus for every one of them.
  for (let press = 1; press <= 60; press += 1) {
    await page.keyboard.press("Tab");
    const step = await focused(page);
    expect(step.inDialog, `Tab ${press} left the dialog for ${step.key}`).toBe(true);
  }
});

test("Escape 关闭设置后焦点回到打开它的「设置」按钮", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");

  // Opened from the keyboard, and the focus is put inside the panel by hand
  // before Escape: a case that only opened by click would pass on a build that
  // never moves the focus at all, because the click leaves it on 设置 already.
  await page.locator('[data-guide="settings"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await page.locator(".config-panel .settings-nav-head button").first().focus();
  const inside = await focused(page);
  expect(inside.inDialog, `the focus was not in the dialog before Escape (${inside.key})`).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator(".config-panel")).toHaveCount(0);

  // Not the composer, which is where the focus used to fall: the reader is put
  // back where they were, so the next Tab continues from the rail.
  const returned = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return { guide: element?.dataset.guide ?? null, text: element?.textContent?.trim() ?? null };
  });
  expect(returned.guide, `focus after Escape went to ${returned.text}`).toBe("settings");
});

test("嵌套的添加模型对话框里 Tab 也不会走到被遮住的页面上", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();

  await page.locator(".settings-nav-scroll").getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(page.locator(".settings-modal")).toBeVisible();
  await markStops(page);

  // 添加模型 draws inside the panel and moves no focus when it opens, so this
  // walk starts on the button that opened it. The review measured Tab 14
  // reaching `BODY` on this flow before the trap stopped standing aside; twenty
  // presses is past that, and the walk has to stay inside the panel throughout.
  let reachedModal = false;
  for (let press = 1; press <= 20; press += 1) {
    await page.keyboard.press("Tab");
    const step = await focused(page);
    expect(step.inDialog, `Tab ${press} left the dialog for ${step.key}`).toBe(true);
    const inModal = await page.evaluate(() => document.activeElement?.closest(".settings-modal") !== null);
    if (inModal) reachedModal = true;
  }
  expect(reachedModal, "the walk never reached a control of the 添加模型 dialog").toBe(true);
});

test("背板盖住页面但留出侧栏：鼠标的出口在侧栏，键盘的出口在 Escape", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();

  // The pointer half of the same contract, stated so the two are read together
  // and so nobody later "fixes" the half that is already deliberate: the
  // backdrop starts where the rail ends, because the rail is how a mouse
  // leaves this surface. The keyboard leaves with Escape, which is the case
  // above — it does not tab out to the rail.
  const layout = await page.evaluate(() => {
    const backdrop = document.querySelector(".config-backdrop") as HTMLElement;
    const opener = (document.querySelector('[data-guide="settings"]') as HTMLElement).getBoundingClientRect();
    const rail = (document.querySelector(".rail") as HTMLElement).getBoundingClientRect();
    const box = backdrop.getBoundingClientRect();
    const hit = (x: number, y: number) => document.elementFromPoint(x, y);
    return {
      backdropStartsAtRail: Math.round(box.left) === Math.round(rail.right),
      railStillClickable: Boolean(hit(opener.x + opener.width / 2, opener.y + opener.height / 2)?.closest(".rail")),
      pageBehindCovered: Boolean(hit(box.left + 4, window.innerHeight - 12)?.closest(".config-backdrop")),
    };
  });
  expect(layout.backdropStartsAtRail, "背板应当从侧栏右缘开始").toBe(true);
  expect(layout.railStillClickable, "侧栏是鼠标离开设置的出口，背板不该盖住它").toBe(true);
  expect(layout.pageBehindCovered, "设置后面的页面应当点不到").toBe(true);
});

test("技能抽屉自己折返：Tab 从抽屉的「确定」不会落到它背后的表单", async ({ page }) => {
  await installMockApi(page, { sessions: [] });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();

  await page.locator(".settings-nav-scroll").getByRole("button", { name: "专家", exact: true }).click();
  await page.getByRole("button", { name: "新增专家", exact: true }).click();
  await expect(page.locator(".specialist-subpage")).toBeVisible();

  // 指定可用能力 makes the 配置技能 button appear, and that button opens the
  // capability drawer. 确定 is the last control of the drawer *and* of the panel,
  // which is the exact point where the two traps used to disagree: the panel's
  // wrap ran first and sent the focus to the form behind the drawer.
  await page.getByRole("radio", { name: /指定可用能力/ }).click();
  await page.getByRole("button", { name: /配置技能/ }).click();
  const drawer = page.locator(".settings-modal.specialist-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "确定", exact: true }).focus();

  const start = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return { inDrawer: element?.closest(".specialist-drawer") !== null, key: element?.textContent?.trim().slice(0, 20) ?? "none" };
  });
  expect(start.inDrawer, `the drawer's last control was not focused (${start.key})`).toBe(true);

  for (let press = 1; press <= 12; press += 1) {
    await page.keyboard.press("Tab");
    const step = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        inDrawer: element?.closest(".specialist-drawer") !== null,
        inPanel: element?.closest(".config-panel") !== null,
        key: element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 20) ?? "none",
      };
    });
    expect(step.inDrawer, `Tab ${press} left the drawer for ${step.key} (still in the panel: ${step.inPanel})`).toBe(true);
  }
});
