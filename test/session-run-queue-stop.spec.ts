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

import { expect, test, type Page } from "@playwright/test";

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Add project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await expect(dialog).toBeHidden();
}

async function createSession(page: Page, name: string) {
  await page.getByRole("button", { name: "Add session" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Session" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Session name").fill(name);
  await dialog.getByRole("button", { name: "Create Session" }).click();
  await expect(dialog).toBeHidden();
}

async function selectHangingModel(page: Page) {
  const value = await page.getByLabel("Model for this task").evaluate((select) => {
    const match = [...(select as HTMLSelectElement).options].find((option) => option.text.includes("hang-model"));
    return match?.value;
  });
  expect(value, "preconfigured hanging model is required").toBeTruthy();
  await page.getByLabel("Model for this task").selectOption(value as string);
}

function runButton(page: Page) {
  return page.getByRole("button", { name: "Run analysis" });
}

test("running Session keeps Stop visible while the next prompt can be queued", async ({ page }) => {
  const projectName = `Queue Stop E2E ${Date.now()}`;
  await page.goto("/");
  await createProject(page, projectName);
  await createSession(page, "Queue and stop");
  await selectHangingModel(page);

  await page.locator(".composer textarea").fill("first prompt");
  await runButton(page).click();
  await expect(page.getByRole("button", { name: "Stop the current run" })).toBeVisible();

  await page.locator(".composer textarea").fill("second prompt");
  await expect(page.getByRole("button", { name: "Add to queue" })).toBeEnabled();
});
