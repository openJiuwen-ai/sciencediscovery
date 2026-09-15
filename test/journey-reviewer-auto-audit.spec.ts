// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A delivered report is automatically reviewed without blocking the researcher, and the completed review is visible in the Session.
 * Steps:
 *   1. Enable Reviewer Specialist in an isolated Session.
 *   2. Deliver a Markdown report and wait for the main run to finish.
 *   3. Observe the independent automatic audit complete and expose its read-only result.
 * Environment: Isolated API/Runner with its own ports and data directory.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible stub only.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN
 * CostSideEffects: Creates and deletes one isolated Project/Session; no external calls.
 */
test("研究员交付报告后可看到独立完成的自动审核", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(120_000);
  journey.scenario({
    goal: "研究员交付一份报告后，主任务立即完成；Reviewer Specialist 在后台完成只读 Quick 审核并显示结果。",
    preconditions: ["隔离 API 与 Runner 已启动", "本地模型 stub 不访问网络", "Reviewer Specialist 已启用"],
  });
  const stub = await scriptedModel([
    { arguments: { command: "mkdir -p results && printf '# Report\\n\\nA concise result.\\n' > results/report.md" }, tool: "run_shell" },
    { arguments: { path: "results/report.md" }, tool: "declare_artifact" },
    { text: "The report is ready." },
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Reviewer audit ${Date.now()}` },
    projectName: `Reviewer auto audit ${Date.now()}`,
    sessionTitle: "Automatic review",
  });
  try {
    await journey.step("启用自动审核并进入会话", "右侧显示 Reviewer Specialist 控制卡，自动审核处于开启状态。", async () => {
      const response = await page.request.put(`${apiBaseUrl()}/api/reviewer-specialist/settings`, {
        data: { enabled: true }, headers: authorizationHeader(),
      });
      expect(response.ok()).toBeTruthy();
      await openProjectSession(page, fixture);
      await expect(page.locator(".reviewer-control-card")).toBeVisible();
    });
    await journey.step("交付报告而不中断主任务", "主任务正常完成，报告出现在产物区。", async () => {
      const run = await sendUserMessage(page, fixture.session.id, "Deliver a short Markdown report.");
      expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
      await expect(page.locator(".artifact-tree")).toContainText("report.md");
    });
    await journey.step("查看自动审核的只读结果", "后台审核任务完成，时间线显示 Reviewer Specialist 的只读审核记录。", async () => {
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/reviewer-audit-tasks`, { headers: authorizationHeader() });
        const tasks = await response.json() as Array<{ status: string }>;
        return tasks.at(-1)?.status;
      }).toBe("completed");
      const feedback = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/review-feedback`, { headers: authorizationHeader() });
      expect(feedback.ok()).toBeTruthy();
      expect((await feedback.json() as Array<{ content: string }>).at(-1)?.content).toContain("Reviewer Specialist feedback");
      await expect(page.locator(".reviewer-specialist-card").last()).toContainText("Reviewer Specialist");
    });
  } finally {
    await page.request.put(`${apiBaseUrl()}/api/reviewer-specialist/settings`, { data: { enabled: false }, headers: authorizationHeader() }).catch(() => undefined);
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
