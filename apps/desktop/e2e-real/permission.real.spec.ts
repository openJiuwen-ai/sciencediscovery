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
 * Purpose: A real tool call that needs approval stops the Run, the desktop card
 *          answers it, and the same Run continues to a real answer.
 * Steps:
 *   1. Create an owned Session with approvalMode=ask_for_dangerous and upload a
 *      file whose marker is not in the prompt.
 *   2. Ask the real model to read it with run_shell.
 *   3. Answer the permission card with 仅允许一次 and wait for completion.
 *   4. Require the marker in the assistant answer: only a finished tool call can
 *      have supplied it.
 * Environment: Isolated product stack selected by E2E_BASE_URL, plus the
 *              desktop Vite entry on 4176.
 * Type: real
 * LLM: Real OpenAI-compatible endpoint; no stub or judge.
 * WebSearch: none requested
 * PaperSources: none
 * MCP: none
 * OtherExternal: Configured model endpoint and the local Runner only.
 * Credentials: E2E_API_TOKEN; E2E_MODEL_ID, or E2E_LLM_BASE_URL/E2E_LLM_MODEL/
 *              E2E_LLM_TOKEN.
 * CostSideEffects: Billable model calls; owned records removed in finally.
 */
import { expect, test } from "@playwright/test";

import {
  API_ORIGIN,
  REAL_TAGS,
  cleanupFixture,
  createFixture,
  openSession,
  requireEnv,
  requireModelSource,
  requireStack,
  seedToken,
  sendMessage,
  waitForRun,
  type RealFixture,
} from "./support.js";

test.beforeEach(async ({ page }, info) => {
  requireEnv(info, "E2E_API_TOKEN");
  requireModelSource(info);
  await requireStack(info);
  await seedToken(page);
});

test("approving a real tool call lets the same run finish", { tag: [...REAL_TAGS] }, async ({ page }) => {
  let fixture: RealFixture | undefined;
  try {
    fixture = await createFixture(page, { approvalMode: "ask_for_dangerous" });

    // The marker lives in the workspace file, never in the prompt, so a final
    // answer that contains it can only come from a completed tool call.
    const marker = `permission-${Date.now()}`;
    const upload = await page.request.post(
      `${API_ORIGIN}/api/sessions/${encodeURIComponent(fixture.session.id)}/workspace/upload`,
      {
        headers: {
          authorization: `Bearer ${process.env.E2E_API_TOKEN ?? ""}`,
          connection: "close",
        },
        multipart: {
          files: { buffer: Buffer.from(`${marker}\n`), mimeType: "text/plain", name: "permission-input.txt" },
        },
      },
    );
    expect(upload.status()).toBe(201);

    await openSession(page, fixture);
    const run = await sendMessage(
      page,
      fixture.session.id,
      "Use run_shell to run `cat permission-input.txt` in the session workspace, then report the exact contents. Keep the answer brief.",
    );

    const card = page.locator(".permission-card");
    await expect(card.first()).toBeVisible({ timeout: 90_000 });
    await expect(card.first()).toContainText("需要权限");
    await card.first().getByRole("button", { name: "仅允许一次" }).click();

    const terminal = await waitForRun(page, fixture.session.id, run.id);
    expect(terminal.status).toBe("completed");
    await expect(page.locator(".message.assistant").last()).toContainText(marker, { timeout: 60_000 });
  } finally {
    await cleanupFixture(fixture);
  }
});
