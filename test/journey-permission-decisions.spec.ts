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
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, sessionExecutionRuns, waitForRunTerminal } from "./helpers/journeys.ts";

for (const decision of ["Allow once", "Allow same type", "Deny"] as const) {
  /**
   * E2E-META
   * Purpose: A researcher understands approval scope and sees the promised execution or denial outcome.
   * Steps:
   *   1. Request workspace code execution and read the three decision explanations while paused.
   *   2. Read the explanations and reach all actions at intermediate and narrow viewport sizes.
   *   3. Decide, check whether another command asks again, and verify execution or agent-visible denial.
   * Environment: Isolated local API/Runner/JiuwenSwarm stack; Ask approval mode.
   * Type: mocked
   * LLM: Journey-owned scripted model on 127.0.0.1; no live model.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none; commands only print markers in the offline sandbox.
   * Credentials: E2E_API_TOKEN for the isolated stack only.
   * CostSideEffects: Temporary local Project/model removed in finally; no paid calls.
   */
  test(`researcher understands and chooses ${decision.toLowerCase()} for workspace code`, {
    tag: ["@mocked", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"],
  }, async ({ page, journey }) => {
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en-US"));
    const stub = await scriptedModel([
      { tool: "run_shell", arguments: { command: "printf 'approval-first\\n'" } },
      ...(decision === "Deny" ? [] : [{ tool: "run_shell", arguments: { command: "printf 'approval-second\\n'" } }]),
      { text: decision === "Deny" ? "The command was skipped because permission was denied." : "Both approved commands completed." },
    ], undefined, { captureContext: true, waitForShellCompletion: decision !== "Deny" });
    const fixture = await createProjectAndSession(page, {
      approvalMode: "ask_for_dangerous", model: { ...stub, name: `Approval wording ${Date.now()}` },
      projectName: `Approval wording ${Date.now()}`, sessionTitle: "Understand code approval",
    });
    const get = async (path: string) => {
      const response = await page.request.get(`${apiBaseUrl()}${path}`, { headers: authorizationHeader() });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const card = page.locator("article.permission-card").filter({ has: page.locator(".permission-decision-actions") }).first();
    let runId = "";
    journey.scenario({
      goal: "Understand what each approval choice permits before deciding whether workspace code may run.",
      preconditions: ["Isolated stack", "Ask approval mode", "Local scripted model and offline marker commands"],
    });
    try {
      await journey.step("1. Request a calculation and read the paused approval", "The card explains waiting, one request, other scripts in this Session, and agent-visible denial without opening details.", async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openProjectSession(page, fixture);
        runId = (await sendUserMessage(page, fixture.session.id, "Run two small workspace commands, asking for permission as needed.")).id;
        await expect(card).toBeVisible();
        await expect(card.locator(".permission-decision-help")).toContainText("Waiting for your decision before this operation can proceed.");
        await expect(card.getByRole("button", { name: "Allow once", exact: true })).toHaveAccessibleDescription("Allow only this request, without saving permission for future requests.");
        await expect(card.getByRole("button", { name: "Allow same type", exact: true })).toHaveAccessibleDescription("Allow pending and future workspace code execution in this Session without asking again, including other scripts and commands.");
        await expect(card.getByRole("button", { name: "Deny", exact: true })).toHaveAccessibleDescription("Skip this operation and send the denial to the agent.");
        expect(await sessionExecutionRuns(page, fixture.session.id)).toHaveLength(0);
        await expect(card.locator(".approval-mode-toggle")).toHaveCount(0);
      });
      for (const viewport of [{ width: 960, height: 600 }, { width: 390, height: 844 }]) {
        await journey.step(`2. Read the card at ${viewport.width} × ${viewport.height}`, "Each explanation can be scrolled into view and all three actions remain available; hiding the workspace gives the narrow conversation more reading space.", async () => {
          await page.setViewportSize(viewport);
          for (const description of await card.locator(".permission-decision-help dd").all()) {
            await description.scrollIntoViewIfNeeded();
            await expect(description).toBeInViewport();
          }
          if (viewport.width === 390) {
            await page.getByRole("button", { name: "Hide workspace", exact: true }).click();
            await card.scrollIntoViewIfNeeded();
          }
          for (const button of ["Allow once", "Allow same type", "Deny"]) {
            await expect(card.getByRole("button", { name: button, exact: true })).toBeVisible();
          }
          expect(await card.locator(".permission-decision-help").evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
        });
      }
      await journey.step(`3. Choose ${decision} and inspect the outcome`, "Once asks again for the next command, matching allows both, and denial skips execution and reaches the agent; Session approval mode stays Ask.", async () => {
        await card.getByRole("button", { name: decision, exact: true }).click();
        if (decision === "Allow once") {
          await expect(card).toContainText("approval-second");
          await card.getByRole("button", { name: "Allow once", exact: true }).click();
        }
        expect((await waitForRunTerminal(page, fixture.session.id, runId)).status).toBe("completed");
        const requests = await get(`/api/permission-requests?sessionId=${fixture.session.id}`);
        expect(requests).toHaveLength(decision === "Allow once" ? 2 : 1);
        expect(requests.every((request: { state: string }) => request.state === (decision === "Deny" ? "denied" : "allowed"))).toBeTruthy();
        const executions = await sessionExecutionRuns(page, fixture.session.id);
        expect(executions).toHaveLength(decision === "Deny" ? 0 : 2);
        for (const execution of executions) {
          expect(execution.status).toBe("succeeded");
          expect(execution.exitCode).toBe(0);
        }
        if (decision === "Deny") {
          expect(stub.calls.flatMap(call => call.toolResults ?? []).join("\n")).toMatch(/denied|拒绝/i);
          await expect(page.getByText("The command was skipped because permission was denied.", { exact: true })).toBeVisible();
        }
        expect((await get(`/api/sessions/${fixture.session.id}`)).approvalMode).toBe("ask_for_dangerous");
      });
    } finally {
      await cleanupJourney(page, fixture);
      await stub.stop();
    }
  });
}
