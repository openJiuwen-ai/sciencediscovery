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
 * Purpose: The desktop turn against a real model: submit, stream, persist; and
 *          the Stop button ending a live run rather than only sending a request.
 * Steps:
 *   1. Create an owned Project/Session pointed at the real endpoint.
 *   2. Submit a marker prompt and wait for the persisted Run and the answer.
 *   3. Submit an intentionally long prompt, press Stop, and wait for the
 *      persisted Run to become `cancelled`.
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
 * CostSideEffects: Billable model calls; owned records removed in finally.
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

test("a real model answer streams into the turn and is persisted", { tag: [...REAL_TAGS] }, async ({ page }) => {
  let fixture: RealFixture | undefined;
  try {
    fixture = await createFixture(page);
    await openSession(page, fixture);

    const marker = `PONG-${Date.now()}`;
    const run = await sendMessage(page, fixture.session.id, `Reply with exactly ${marker} and nothing else.`);
    const terminal = await waitForRun(page, fixture.session.id, run.id);

    expect(terminal.status).toBe("completed");
    await expect(page.locator(".message.assistant").last()).toContainText(marker, { timeout: 60_000 });

    const detail = await api<{ messages: Array<{ content: string; role: string }> }>(
      page,
      `/api/sessions/${encodeURIComponent(fixture.session.id)}`,
    );
    expect(detail.messages.some((message) => message.role === "assistant" && message.content.includes(marker))).toBe(true);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Stop ends the live run, and the service records it as cancelled", { tag: [...REAL_TAGS] }, async ({ page }) => {
  let fixture: RealFixture | undefined;
  try {
    fixture = await createFixture(page, { approvalMode: "always_allow" });
    await openSession(page, fixture);

    // Long enough that the answer cannot land before Stop is pressed. The
    // assertion is on the persisted Run, not on the button disappearing.
    const run = await sendMessage(
      page,
      fixture.session.id,
      "Write the integers from 1 to 5000, one per line, without commentary.",
    );

    const stop = page.getByRole("button", { name: "停止" });
    await expect(stop).toBeVisible({ timeout: 60_000 });
    await stop.click();

    const terminal = await waitForRun(page, fixture.session.id, run.id);
    expect(terminal.status).toBe("cancelled");
  } finally {
    await cleanupFixture(fixture);
  }
});
