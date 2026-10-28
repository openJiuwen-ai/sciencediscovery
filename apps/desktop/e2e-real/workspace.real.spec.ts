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
 * Purpose: A file chosen in the desktop composer is stored by the real service,
 *          listed from the real workspace and previewed with its real bytes.
 * Steps:
 *   1. Create an owned Session.
 *   2. Upload a CSV through the composer's picker; the upload opens the panel.
 *   3. Select the file in the 工作区 tab and read the preview.
 *   4. Confirm the service lists the same path.
 * Environment: Isolated product stack selected by E2E_BASE_URL, plus the
 *              desktop Vite entry on 4176.
 * Type: real
 * LLM: Real endpoint registered for the Session; this journey does not call it.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: none
 * OtherExternal: Local API and workspace volume only.
 * Credentials: E2E_API_TOKEN; E2E_MODEL_ID, or E2E_LLM_BASE_URL/E2E_LLM_MODEL/
 *              E2E_LLM_TOKEN.
 * CostSideEffects: No model call; owned records removed in finally.
 */
import { expect, test } from "@playwright/test";

import {
  REAL_TAGS,
  api,
  cleanupFixture,
  createFixture,
  openSession,
  requireEnv,
  requireModelSource,
  requireStack,
  seedToken,
  type RealFixture,
} from "./support.js";

test.beforeEach(async ({ page }, info) => {
  requireEnv(info, "E2E_API_TOKEN");
  requireModelSource(info);
  await requireStack(info);
  await seedToken(page);
});

test("an uploaded file is stored, listed and previewed from the real workspace", { tag: [...REAL_TAGS] }, async ({ page }) => {
  let fixture: RealFixture | undefined;
  try {
    fixture = await createFixture(page);
    await openSession(page, fixture);

    const marker = `row-${Date.now()}`;
    const name = `desktop-real-${marker}.csv`;

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "上传文件" }).click();
    await (await chooserPromise).setFiles({
      buffer: Buffer.from(`id,value\n1,${marker}\n`),
      mimeType: "text/csv",
      name,
    });

    await expect(page.getByText(`已上传 ${name}`, { exact: false })).toBeVisible();

    // A successful upload opens the panel on its 工作区 tab, so the test does
    // not press the toggle: that button is already gone once the panel is open.
    await expect(page.getByRole("tab", { name: "工作区" })).toBeVisible();
    const row = page.locator(".panel-list-row", { hasText: name });
    await expect(row.first()).toBeVisible();
    await row.first().click();

    await expect(page.locator(".doc-body")).toContainText(marker, { timeout: 30_000 });

    const files = await api<Array<{ path: string }>>(
      page,
      `/api/sessions/${encodeURIComponent(fixture.session.id)}/files`,
    );
    expect(files.some((file) => file.path === name)).toBe(true);
  } finally {
    await cleanupFixture(fixture);
  }
});
