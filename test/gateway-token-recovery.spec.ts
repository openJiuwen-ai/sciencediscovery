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

import { expect, test, type Locator, type Page } from "@playwright/test";

import { BROWSER_TOKEN_STORAGE_KEY, requireApiToken } from "./e2e-auth.js";

/**
 * Recovering from a rejected access token.
 *
 * The stack generates its access token on first start, so a browser that has
 * never been given one is rejected and must be handed the Connection settings.
 * Every startup request fails at once under that condition, and error
 * notifications stay until dismissed — so the notification column must not be
 * able to grow over the dialog footer the user needs to click, including after
 * the user saves a wrong token first.
 *
 * The access token comes from the shared `E2E_API_TOKEN` wiring like every other
 * spec; a missing one already failed the run in the global setup.
 */
const WRONG_TOKEN = "e2e-wrong-token";

const connectionDialog = (page: Page): Locator => page.locator("section.system-config-dialog[role='dialog']");
const saveAndClose = (page: Page): Locator => page.getByRole("button", { name: "Save and close" });
const toasts = (page: Page): Locator => page.locator(".toast-viewport .toast");

/** What the user's pointer would actually reach at the button's centre. */
async function saveButtonIsReachable(page: Page): Promise<boolean> {
  const box = await saveAndClose(page).boundingBox();
  if (!box) return false;
  return await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return target?.closest("button") !== null && target?.closest(".toast-viewport") === null;
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

async function saveToken(page: Page, token: string): Promise<void> {
  await page.getByLabel("Local API token").fill(token);
  await saveAndClose(page).click({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  // English keeps the selectors stable wherever this runs. The suite seeds the
  // access token into every context; this is the one spec that must start from
  // the real cold-start state, so it clears that key again on every navigation.
  await page.addInitScript((tokenKey) => {
    window.localStorage.setItem("sciencediscovery-locale", "en");
    window.localStorage.removeItem(tokenKey);
  }, BROWSER_TOKEN_STORAGE_KEY);
});

test("a cold start with no token opens Connection settings without burying its footer", async ({ page }) => {
  await page.goto("/");

  await expect(connectionDialog(page)).toBeVisible();
  await expect(page.getByText("Access token rejected")).toBeVisible();
  // Many requests fail with the same answer; they must read as one condition.
  await expect(toasts(page).filter({ hasText: "Unauthorized" })).toHaveCount(1);
  expect(await saveButtonIsReachable(page)).toBe(true);
});

test("a wrong token then the right one recovers without clearing notifications", async ({ page }) => {
  await page.goto("/");
  await expect(connectionDialog(page)).toBeVisible();
  const initialToasts = await toasts(page).count();

  await saveToken(page, WRONG_TOKEN);

  // The wrong token is rejected too: the dialog comes back and says why.
  await expect(connectionDialog(page)).toBeVisible();
  await expect(page.getByText("Access token rejected")).toBeVisible();
  // Another round of failures must not add another round of notifications.
  await expect(toasts(page)).toHaveCount(initialToasts);
  await expect(toasts(page).filter({ hasText: "Unauthorized" })).toHaveCount(1);
  expect(await saveButtonIsReachable(page)).toBe(true);

  // The whole point: correcting the token works with the notifications still on
  // screen, with no manual clean-up in between.
  await saveToken(page, requireApiToken());

  await expect(connectionDialog(page)).toBeHidden();
  await expect(page.getByText("Access token rejected")).toBeHidden();
});

test("the recovery dialog stays operable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(connectionDialog(page)).toBeVisible();

  await saveToken(page, WRONG_TOKEN);

  await expect(connectionDialog(page)).toBeVisible();
  expect(await saveButtonIsReachable(page)).toBe(true);

  await saveToken(page, requireApiToken());

  await expect(connectionDialog(page)).toBeHidden();
});
