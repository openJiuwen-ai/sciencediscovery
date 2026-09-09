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

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: The Workspace shows independent current Plans for the main Agent and multiple Subagents, and clearing one Plan removes only that card.
 * Steps:
 *   1. Prepare a local scripted model whose main Agent declares a Plan and delegates two sequential Subagents.
 *   2. Let each Subagent declare its own Plan, then inspect all three cards and the main Plan's step-state icons in Workspace Tasks.
 *   3. Let the main Agent clear its Plan and verify both Subagent cards remain while the main card disappears.
 *   4. Reload the Session and verify the same two-card projection is rebuilt from the persisted Run Event Stream.
 * Environment: Isolated local stack at E2E_BASE_URL with a journey-owned Project/Session.
 * Type: mocked
 * LLM: journey-owned OpenAI-compatible HTTP stub on 127.0.0.1; main/subagent routing uses the general-purpose preset system marker.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated local API only; the stub token has no external access.
 * CostSideEffects: no external cost; temporary model and Project records are deleted in finally.
 */
test("Workspace projects main and Subagent Plans independently", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  const stub = await scriptedModel([
    {
      arguments: {
        explanation: "Coordinate two independent evidence checks",
        plan: [
          { status: "completed", step: "Define the review scope" },
          { status: "in_progress", step: "Delegate evidence checks" },
          { status: "pending", step: "Synthesize findings" },
        ],
      },
      tool: "update_plan",
    },
    {
      arguments: {
        description: "Evidence check alpha",
        prompt: "Inspect evidence source alpha and report completion.",
        subagent_type: "general-purpose",
        timeout_seconds: 60,
      },
      tool: "task",
    },
    {
      arguments: {
        description: "Evidence check beta",
        prompt: "Inspect evidence source beta and report completion.",
        subagent_type: "general-purpose",
        timeout_seconds: 60,
      },
      tool: "task",
    },
    { arguments: { plan: [] }, delayMs: 12_000, tool: "update_plan" },
    { text: "Both delegated evidence checks are complete." },
  ], [
    {
      arguments: {
        explanation: "Inspect the delegated evidence source",
        plan: [{ status: "in_progress", step: "Inspect delegated evidence" }],
      },
      tool: "update_plan",
    },
    { text: "The delegated evidence check is complete." },
  ]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: {
      apiToken: stub.apiToken,
      baseUrl: stub.baseUrl,
      model: stub.model,
      name: `Plan workspace model ${Date.now()}`,
    },
    projectName: `Plan workspace ${Date.now()}`,
    sessionTitle: `Independent Plans ${Date.now()}`,
  });

  journey.scenario({
    goal: "A researcher can follow the main Agent and two delegated workers as separate Plans in the Workspace.",
    preconditions: [
      "An isolated local stack and journey-owned Project/Session are available",
      "A local scripted model declares one main Plan, two Subagent Plans, and then clears only the main Plan",
    ],
  });

  const workspace = page.locator("aside.workspace-panel");
  const tasks = workspace.locator("details.workspace-plan-section");
  const cards = tasks.locator("article.plan-card");
  let runId = "";
  const ensureWorkspaceVisible = async () => {
    if (!await workspace.count()) {
      await page.getByRole("button", { name: /^(Show workspace|显示工作区)$/ }).click();
    }
    await expect(workspace).toBeVisible();
  };

  try {
    await journey.step(
      "Run a main Plan with two delegated Plans",
      "Workspace Tasks shows three independent cards while the main Plan remains active.",
      async () => {
        await openProjectSession(page, fixture);
        await ensureWorkspaceVisible();
        runId = (await sendUserMessage(
          page,
          fixture.session.id,
          "Coordinate two independent evidence checks and track each Plan.",
        )).id;
        await expect(cards).toHaveCount(3, { timeout: 60_000 });
        await expect(cards.filter({ hasText: "Plan · main" })).toHaveCount(1);
        await expect(cards.filter({ hasText: "Plan · subagent:" })).toHaveCount(2);
        await expect(tasks.locator("summary .fold-meta")).toHaveText("1/5");

        const mainCard = cards.filter({ hasText: "Plan · main" });
        await mainCard.getByRole("button").click();
        await expect(mainCard.locator(".plan-item-status.completed")).toHaveCount(1);
        await expect(mainCard.locator(".plan-item-status.in_progress")).toHaveCount(1);
        await expect(mainCard.locator(".plan-item-status.pending")).toHaveCount(1);
      },
    );

    await journey.step(
      "Clear only the main Plan",
      "The main card disappears, while both Subagent cards and their aggregate remain visible.",
      async () => {
        await expect(cards).toHaveCount(2, { timeout: 30_000 });
        await expect(cards.filter({ hasText: "Plan · main" })).toHaveCount(0);
        await expect(cards.filter({ hasText: "Plan · subagent:" })).toHaveCount(2);
        await expect(tasks.locator("summary .fold-meta")).toHaveText("0/2");
      },
    );

    await journey.step(
      "Reload the completed Run",
      "The persisted event stream rebuilds the same two Subagent Plan cards without restoring the cleared main Plan.",
      async () => {
        expect(runId).toBeTruthy();
        expect((await waitForRunTerminal(page, fixture.session.id, runId)).status).toBe("completed");
        await page.reload();
        await ensureWorkspaceVisible();
        await expect(cards).toHaveCount(2);
        await expect(cards.filter({ hasText: "Plan · main" })).toHaveCount(0);
        await expect(cards.filter({ hasText: "Plan · subagent:" })).toHaveCount(2);
      },
    );
  } finally {
    await cleanupJourney(page, fixture).catch(() => undefined);
    await stub.stop();
  }
});
