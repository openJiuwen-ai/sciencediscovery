// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import { expect } from "@playwright/test";

import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-reviewer-auto-audit.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

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
  test.setTimeout(180_000);
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
      // The controls live in a workspace fold, collapsed like its neighbours,
      // so a user opens the disclosure before reading them. Asserting the card
      // straight after entering the Session finds it in the DOM but hidden.
      const fold = page.locator("details.workspace-fold").filter({ hasText: "Reviewer Specialist" });
      await fold.locator("summary").click();
      await expect(fold.locator(".reviewer-control-card")).toBeVisible();
    });
    await journey.step("交付报告而不中断主任务", "主任务正常完成，报告出现在产物区。", async () => {
      const run = await sendUserMessage(page, fixture.session.id, "Deliver a short Markdown report.");
      expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
      // `.artifact-tree` is the recursive tree container, so `results/report.md`
      // alone produces one per level, and the Workspace-files tree renders more
      // of them. Assert on the Artifacts fold: that is the 产物区 this step is
      // about, and it is a single element.
      await expect(page.locator(".artifact-catalog-section")).toContainText("report.md");
    });
    await journey.step("查看自动审核的只读结果", "后台审核任务完成，时间线显示 Reviewer Specialist 的只读审核记录。", async () => {
      // An automatic Quick audit deliberately stays queued for
      // QUICK_BATCH_QUIET_MS (60 s, audit-coordinator.ts) so a burst of
      // artifacts becomes one audit. The wait must outlast that window: the
      // default 10 s poll expires while the product is behaving correctly.
      let auditTask: { id: string; status: string } | undefined;
      await expect.poll(async () => {
        const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/reviewer-audit-tasks`, { headers: authorizationHeader() });
        auditTask = (await response.json() as Array<{ id: string; status: string }>).at(-1);
        return auditTask?.status;
      }, { timeout: 90_000 }).toBe("completed");
      const feedback = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/review-feedback`, { headers: authorizationHeader() });
      expect(feedback.ok()).toBeTruthy();
      // A `ReviewFeedback` record carries findings, a policy and a handoff
      // status — it has no `content` string. "Reviewer Specialist feedback" is
      // the header the *run context* builds out of these records when the lead
      // Agent next reads them, so asserting it here read `undefined` off every
      // record the audit has ever written. Assert the handoff itself instead:
      // the completed task produced a read-only record that is ready for the
      // lead Agent and points back at the reviews it came from.
      const records = await feedback.json() as Array<{
        policy: string; reviewIds: string[]; status: string; taskId: string;
      }>;
      expect(records.at(-1)).toMatchObject({ policy: "record", status: "ready", taskId: auditTask!.id });
      expect(records.at(-1)!.reviewIds.length).toBeGreaterThan(0);
      // The card names the Artifact it reviewed and the level it ran at; the
      // words "Reviewer Specialist" appear nowhere in it, so the timeline is
      // identified by what the record is about rather than by a brand string.
      const auditCard = page.locator(".reviewer-specialist-card").last();
      await expect(auditCard).toContainText("results/report.md");
      await expect(auditCard).toContainText("Quick");
    });
  } finally {
    await page.request.put(`${apiBaseUrl()}/api/reviewer-specialist/settings`, { data: { enabled: false }, headers: authorizationHeader() }).catch(() => undefined);
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});

});
