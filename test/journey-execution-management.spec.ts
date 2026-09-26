// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect, type Locator } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-execution-management.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

/**
 * Open everything the activity panel keeps folded.
 *
 * Executions, transfers and reminders are three sibling folds, each closed
 * until its own summary is clicked, and inside them every task is a fold of
 * its own that is expanded only while that task is running. Reading any detail
 * of a task that is not running therefore takes two clicks, not none.
 */
async function expandRecords(panel: Locator): Promise<void> {
  for (const selector of ["details.workspace-fold", "details.workspace-fold details.process-record"]) {
    const folds = panel.locator(selector);
    for (let index = 0; index < await folds.count(); index += 1) {
      const fold = folds.nth(index);
      if (await fold.getAttribute("open") === null) await fold.locator(":scope > summary").click();
    }
  }
}

/**
 * E2E-META
 * Purpose: A user observes and manages background execution, transfers and one-time reminders in the Session panel.
 * Steps:
 *   1. Open Session activity and read identities and committed transfer progress.
 *   2. Read logs while execution remains running, then explicitly cancel execution and reminder.
 *   3. Inspect the same controls in a narrow viewport and the empty Session state.
 *   4. See the scope of resuming a stopped child and verify that the action clears its stopped control.
 * Environment: Isolated production API/Web at E2E_BASE_URL; Session created over API; activity responses mocked locally.
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; no remote requests or processes.
 * Credentials: E2E_API_TOKEN for isolated stack.
 * CostSideEffects: local Session records, cleaned in finally; no cost.
 */
test("执行日志、取消与一次性提醒可管理", { tag: "@mocked" }, async ({ journey, page }) => {
  journey.scenario({ goal: "用户在模型空闲时仍能查后台任务日志，查看逐文件复制结果，并明确取消执行或提醒。", preconditions: ["隔离 Web/API 已启动", "运行状态由浏览器本地路由模拟；真实后台执行另有生产 API 旅程"] });
  const fixture = await createProjectAndSession(page, { projectName: `Activity ${Date.now()}`, sessionTitle: "Execution management" });
  const activity = { executions: [{ id: "execution-1", agentId: "main", runnerId: "local", workspaceId: "ws_main_local", state: "running", provenance: "pending" }],
    transfers: [{ id: "transfer-1", sourceWorkspaceId: "ws_child_remote", targetWorkspaceId: "ws_main_local", state: "partial", files: [{ sourcePath: "result.txt", targetPath: "result.txt" }, { sourcePath: "missing.txt", targetPath: "missing.txt" }],
      progress: [{ targetPath: "result.txt", state: "completed", bytes: 42 }], error: "One file was unavailable; committed files were retained." }],
    timers: [{ id: "timer-1", agentId: "main", message: "Inspect training output", dueAt: Date.now() + 60000, state: "pending" }],
    agents: [] as Array<{ agentId: string; stopped: boolean }> };
  let logsRead = false;
  await page.route(`**/api/sessions/${fixture.session.id}/agent-activity**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/logs")) { logsRead = true; await route.fulfill({ json: { chunks: [{ text: "epoch 4/10 · still running" }] } }); }
    else if (path.endsWith("/executions/execution-1/cancel")) { activity.executions[0]!.state = "cancelled"; await route.fulfill({ json: {} }); }
    else if (path.endsWith("/timers/timer-1/cancel")) { activity.timers[0]!.state = "cancelled"; await route.fulfill({ json: {} }); }
    else await route.fulfill({ json: activity });
  });
  await page.route(`**/api/sessions/${fixture.session.id}/subagents/child/resume`, async (route) => {
    activity.agents[0]!.stopped = false;
    await route.fulfill({ json: { resumed: true } });
  });
  try {
    await journey.step("查看执行与复制状态", "执行显示 Runner、Agent 和 Workspace；部分复制显示已提交文件数，不误报全部成功。", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openProjectSession(page, fixture);
      const panel = page.getByLabel("Executions and reminders");
      await expandRecords(panel);
      await expect(panel.getByText("local · main", { exact: true })).toBeVisible();
      await expect(panel.getByText("1/2 files committed", { exact: true })).toBeVisible();
      await expect(panel.getByRole("alert")).toContainText("committed files were retained");
    });
    await journey.step("查日志后显式取消",
      "读日志不停止任务；取消执行与取消提醒分别改变对应状态，记录随即收起，标题行写明已取消。", async () => {
      const panel = page.getByLabel("Executions and reminders");
      await panel.getByRole("button", { name: "View logs" }).click();
      await expect(panel.getByLabel("Execution logs")).toContainText("epoch 4/10");
      expect(logsRead).toBe(true); expect(activity.executions[0]!.state).toBe("running");
      // A record is expanded for as long as its task runs and folds itself
      // away once the task reaches a terminal state, so what a user reads
      // after cancelling is the summary line, not the button inside it.
      const summary = (contains: string) => panel.locator("details.process-record > summary")
        .filter({ hasText: contains });
      await panel.getByRole("button", { name: "Cancel execution" }).click();
      await expect(summary("local · main")).toContainText("cancelled");
      await panel.getByRole("button", { name: "Cancel reminder" }).click();
      await expect(summary("Inspect training output")).toContainText("cancelled");
    });
    await journey.step("窄视口和空状态", "标识与操作可读，无水平溢出；任务清空后三个折叠区一起消失，面板不再占位。", async () => {
      await page.setViewportSize({ width: 1000, height: 900 });
      const panel = page.getByLabel("Executions and reminders");
      await panel.scrollIntoViewIfNeeded();
      await expandRecords(panel);
      await expect(panel.getByRole("button", { name: "View logs" })).toBeVisible();
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      activity.executions.length = 0; activity.transfers.length = 0; activity.timers.length = 0;
      // Each fold renders only while its list is non-empty, so an idle Session
      // shows no fold at all rather than a fold reading zero.
      await expect(panel.locator("details.workspace-fold")).toHaveCount(0);
    });
    await journey.step("恢复子代理前看清会话影响", "提示说明会话停止时，恢复子代理也会让主代理和其他未单独停止的代理继续；操作后恢复按钮消失。", async () => {
      activity.agents.push({ agentId: "subagent:child", stopped: true });
      const panel = page.getByLabel("Executions and reminders");
      await expect(panel.getByText(/Main and other subagents that were not stopped individually can continue/)).toBeVisible();
      await panel.getByRole("button", { name: "Resume subagent:child" }).click();
      await expect(panel.getByRole("button", { name: "Resume subagent:child" })).toHaveCount(0);
    });
  } finally { await cleanupJourney(page, fixture); }
});

});
