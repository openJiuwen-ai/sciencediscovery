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
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel } from "./helpers/journeys.ts";

test.describe("Evolve initialization", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock"] }, () => {
  for (const locale of ["en", "zh-CN"] as const) {
    /**
     * E2E-META
     * Purpose: Evolve is visibly unavailable until explicit initialization, and failures can be retried without losing a chat draft.
     * Steps:
     *   1. Open a Session with a local fixture model and uninitialized Evolve status.
     *   2. Type an Evolve command; verify the disabled action and explicit download explanation.
     *   3. Initialize, observe a failure, and retry to reach readiness and algorithm selection.
     * Environment: Isolated local stack; browser status/init transport is stubbed; the separate ordinary-ST distribution journey verifies real downloads and installation.
     * Type: mocked
     * LLM: local scripted stub registered but never called
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none — non-local browser requests are aborted; no artifact downloads in this UI journey.
     * Credentials: E2E_API_TOKEN for the isolated local API only; synthetic local model token.
     * CostSideEffects: no external cost; temporary records and local stub are cleaned up in finally.
     */
    test(`explicit Init and retry preserve the draft (${locale})`, { tag: "@mocked" }, async ({ page, journey }) => {
      journey.scenario({ goal: "Understand why Evolve is unavailable, initialize it explicitly, and recover after a failed attempt.",
        preconditions: ["Isolated stack with a local model fixture. Status/init transport is controlled; real installation is covered separately in ST."] });
      const model = await scriptedModel([{ text: "No model call is expected." }]);
      const fixture = await createProjectAndSession(page, { projectName: `Evolve Init ${Date.now()}`, sessionTitle: "Initialize Evolve", model: { ...model, name: `Init fixture ${Date.now()}` } });
      let state = "not_initialized"; let attempts = 0;
      await page.addInitScript(value => localStorage.setItem("sciencediscovery-locale", value), locale);
      await page.route("**/api/evolve/status", route => route.fulfill({ json: { state, canInitialize: true } }));
      await page.route("**/api/evolve/init", async route => { attempts++; state = attempts === 1 ? "error" : "ready";
        await route.fulfill({ json: { state, canInitialize: true } }); });
      const composer = page.locator(".composer");
      const setup = composer.locator(".evolve-setup");
      const initLabel = locale === "en" ? "Init Evolve" : "初始化 Evolve";
      const draft = "/evolve-design improve the program and retain this draft";
      try {
        await journey.step("Open the workbench", "Ordinary chat remains available without Evolve initialization.", async () => {
          await openProjectSession(page, fixture);
          await composer.locator("textarea").fill("ordinary local chat draft");
          await expect(composer.locator('button[type="submit"]')).toBeEnabled();
          expect(attempts).toBe(0);
        });
        await journey.step("Request Evolve", "The command stays unsent, with an initialization explanation and a reachable action on a narrow screen.", async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await composer.locator("textarea").fill(draft);
          await expect(setup).toBeVisible();
          await expect(setup).toContainText("1 GiB");
          await expect(setup.getByRole("button", { name: initLabel, exact: true })).toBeEnabled();
          await expect(composer.locator('button[type="submit"]')).toBeDisabled();
          expect(attempts).toBe(0);
        });
        await journey.step("Initialize and inspect the failure", "A failed initialization leaves the draft intact and offers retry.", async () => {
          await setup.getByRole("button", { name: initLabel, exact: true }).click();
          await expect(setup.getByRole("status")).toContainText(locale === "en" ? "unavailable" : "暂不可用");
          await expect(composer.locator("textarea")).toHaveValue(draft);
          await expect(setup.getByRole("button", { name: initLabel, exact: true })).toBeEnabled();
        });
        await journey.step("Retry initialization", "Evolve becomes ready and the existing algorithm picker opens without sending the draft.", async () => {
          await page.setViewportSize({ width: 960, height: 720 });
          await setup.getByRole("button", { name: initLabel, exact: true }).click();
          await expect(setup).toHaveCount(0);
          await expect(composer).toContainText("PUCT");
          await expect(composer.locator("textarea")).toHaveValue(draft);
          await expect(composer.locator('button[type="submit"]')).toBeEnabled();
          await page.setViewportSize({ width: 1440, height: 900 });
          await expect(composer).toBeVisible();
          expect(attempts).toBe(2);
        });
      } finally { await cleanupJourney(page, fixture); await model.stop(); }
    });
  }
});
