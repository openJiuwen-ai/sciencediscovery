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

import { expect, type Page } from "@playwright/test";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
  type JourneyFixture,
} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("issue-77-wake-notice.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

test.use({ locale: "zh-CN" });

/**
 * E2E-META
 * Purpose: After background work finishes, a user sees a quiet runtime notice instead of a message they never typed.
 * Steps:
 *   1. Run one shell-backed request so a background Execution completes and the runtime wakes the Agent on its own.
 *   2. Read the conversation: the wake is a runtime notice, and no bubble is attributed to the researcher.
 *   3. Read the notice as a summary of what finished, with the execution reachable from it.
 * Environment: Isolated production API/Web at E2E_BASE_URL; Project/Session created over API; zh-CN browser locale.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; one deterministic user turn plus the runtime's own wake turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — the shell runs inside the local sandbox.
 * Credentials: E2E_API_TOKEN for the isolated stack.
 * CostSideEffects: local Project/Session records, cleaned in finally; no cost.
 */
test("后台执行完成后显示运行时提示，而不是伪装成用户消息", { tag: "@mocked" }, async ({ journey, page, playwright }) => {
  journey.scenario({
    goal: "用户跑完一个后台任务后回到对话页，应当看到一条克制的运行时提示，而不是一条自己从没输入过的消息。",
    preconditions: ["隔离 Web/API 已启动", "模型由本旅程自带的 HTTP 桩驱动"],
  });
  const marker = `WAKE-${Date.now()}`;
  const stub = await scriptedModel([
    [
      { arguments: { background: true, command: `printf '%s' '${marker}' > wake.txt` }, tool: "run_shell" },
      { text: `后台任务已提交，标记为 ${marker}。` },
    ],
  ]);
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Runtime notice model ${Date.now()}` },
      // Project and Session names must not share a substring: the sidebar is
      // navigated by visible text and would match both entries.
      projectName: `Runtime notice ${Date.now()}`,
      sessionTitle: "Wake notice",
    });

    await journey.step("跑一个后台任务并等它完成", "回合结束后，运行时自己发起一个新回合来消费执行结果。", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openProjectSession(page, fixture!);
      const run = await sendUserMessage(page, fixture!.session.id, "提交一个后台任务，然后结束本轮。");
      await waitForRunTerminal(page, fixture!.session.id, run.id);
      await expect.poll(async () => (await runs(page, fixture!.session.id))
        .some((candidate) => candidate.automaticWake && candidate.status === "completed"),
      { message: "the runtime should wake itself once the Execution completes", timeout: 60_000 }).toBe(true);
    });

    await journey.step("对话页把唤醒记成运行时提示", "提示是一条系统记录；没有任何一条消息被算在研究者名下，也看不到内部提示词。", async () => {
      // The reported symptom is what a user sees on returning to the
      // conversation, so the journey reads the persisted transcript.
      await page.reload();
      await expect(page.getByRole("heading", { exact: true, name: "Wake notice" })).toBeVisible();
      const notice = page.getByLabel("运行时提示");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText(/已同步 \d+ 项后台执行结果/);
      // The defect this journey guards: the wake used to be persisted as a
      // `role=user` message, so it rendered with the researcher's avatar.
      await expect(page.locator(".message.user")).toHaveCount(1);
      await expect(page.locator(".message.user")).not.toContainText("[Execution notifications]");
      // The model-facing text is diagnostic data, not conversation content.
      await expect(page.locator("body")).not.toContainText("[Execution notifications]");
    });

    await journey.step("提示本身说明了完成了什么", "提示列出这次执行的 Runner、Agent 与结果，并提供打开执行记录的入口。", async () => {
      const notice = page.getByLabel("运行时提示");
      await expect(notice).toContainText("1 项完成");
      await expect(notice).toContainText("local 上的执行 · 主 Agent");
      await expect(notice.getByRole("button", { name: "查看执行记录" })).toBeVisible();
    });
  } finally {
    const api = await playwright.request.newContext({ baseURL: apiBaseUrl(), extraHTTPHeaders: authorizationHeader() });
    try {
      if (fixture) {
        // Close the wake gate before deleting: a Session that can still start
        // runs on its own keeps its Project deletion waiting behind them, and
        // the next journey expects an empty workbench.
        await api.post(`/api/sessions/${encodeURIComponent(fixture.session.id)}/runs/current/cancel`, { data: {} })
          .catch(() => undefined);
        await cleanupJourney(page, fixture);
        await expect.poll(async () => {
          const response = await api.get("/api/projects");
          if (!response.ok()) return true;
          const projects = await response.json() as Array<{ id: string }>;
          return projects.some((project) => project.id === fixture!.project.id);
        }, { message: "the Project should be gone before the next journey starts", timeout: 30_000 }).toBe(false);
      }
    } finally { await api.dispose(); }
    await stub.stop();
  }
});

async function runs(page: Page, sessionId: string): Promise<Array<{ automaticWake?: boolean; status: string }>> {
  const response = await page.request.fetch(`${apiBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}/runs`,
    { headers: authorizationHeader() });
  expect(response.ok()).toBe(true);
  return await response.json() as Array<{ automaticWake?: boolean; status: string }>;
}

});
