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
 * Purpose: 设置 › 模型's 测试连接 reaches the configured real endpoint and
 *          reports its real latency, not a stubbed verdict.
 * Steps:
 *   1. Register an owned model profile from E2E_LLM_*, or reuse E2E_MODEL_ID.
 *   2. Open 设置 › 模型 and click that row's 测试连接.
 *   3. Require the success reading in the row; a provider that exhausts the
 *      probe's synthetic output budget skips as inconclusive.
 * Environment: Isolated product stack selected by E2E_BASE_URL, plus the
 *              desktop Vite entry on 4176.
 * Type: real
 * LLM: Real OpenAI-compatible endpoint; no stub or judge.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: none
 * OtherExternal: Configured model endpoint only.
 * Credentials: E2E_API_TOKEN; E2E_MODEL_ID, or E2E_LLM_BASE_URL/E2E_LLM_MODEL/
 *              E2E_LLM_TOKEN.
 * CostSideEffects: One minimal model probe; an owned profile is removed.
 */
import { expect, test } from "@playwright/test";

import {
  REAL_TAGS,
  api,
  requireEnv,
  requireModelSource,
  requireStack,
  resolveModel,
  seedToken,
} from "./support.js";

test.beforeEach(async ({ page }, info) => {
  requireEnv(info, "E2E_API_TOKEN");
  requireModelSource(info);
  await requireStack(info);
  await seedToken(page);
});

test("a model profile is tested against the real endpoint", { tag: [...REAL_TAGS] }, async ({ page }) => {
  const { model: profile, owned } = await resolveModel(page, `Desktop probe ${Date.now()}`);

  try {
    await page.goto("/");

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTitle("模型档案与服务商凭据").click();

    const row = dialog.locator(".model-row").filter({ hasText: profile.name });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "测试连接" }).click();

    // 测试连接 writes the profile before probing it, so the row is the same
    // one the API will use for a real request.
    const probe = row.locator(".model-row-probe");
    await expect(probe).toContainText(/✓ 可用|Basic reply was truncated at the synthetic output limit/, { timeout: 60_000 });
    // The probe asks for a very short reply. A reasoning model can spend that
    // budget on reasoning and come back with `finish_reason: length`; the
    // product then says support is inconclusive. The endpoint answered, but
    // this case cannot prove availability with such a model, so it skips
    // rather than calling the product broken.
    if ((await probe.textContent())?.includes("synthetic output limit")) {
      test.skip(true, `${profile.name} exhausts the probe's synthetic output budget; support is inconclusive`);
    }
  } finally {
    if (owned) {
      await api(page, `/api/models/${encodeURIComponent(profile.id)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }
});
