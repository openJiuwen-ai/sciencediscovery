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
import { cleanupJourney, createProjectAndSession, openProjectSession, type JourneyFixture } from "./helpers/journeys.ts";

test.describe("project panel collapse", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  test.use({ locale: "en-US" });

  for (const count of [1, 3]) {
    /**
     * E2E-META
     * Purpose: Collapsing Projects hides every row without changing the active Session.
     * Steps:
     *   1. Create one or three temporary Projects and open a Session.
     *   2. Collapse Projects and verify hidden rows and unchanged Session.
     *   3. Expand and verify all rows and the selected Project return.
     *   4. Open and cancel Add project while collapsed.
     * Environment: Isolated local stack at E2E_BASE_URL; English browser locale.
     * Type: mocked
     * LLM: none
     * WebSearch: none
     * PaperSources: none
     * MCP: none
     * OtherExternal: none — non-local browser requests are aborted.
     * Credentials: E2E_API_TOKEN for the isolated local API only.
     * CostSideEffects: no external cost; temporary Projects are deleted in finally.
     */
    test(`Projects collapse and restore with ${count} project(s)`, { tag: "@mocked" }, async ({ page, journey }) => {
      const fixtures: JourneyFixture[] = [];
      journey.scenario({
        goal: "Hide the Projects list, retain the active Session, and restore or add Projects.",
        preconditions: ["Isolated local stack; no model is required."],
      });
      await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
      const panel = page.locator("#projects-panel-content");
      const toggle = page.locator('[aria-controls="projects-panel-content"]');
      try {
        await journey.step("Open a prepared Session", `${count} Project rows are visible.`, async () => {
          for (let index = 0; index < count; index++) {
            fixtures.push(await createProjectAndSession(page, {
              projectName: `Collapse-${Date.now()}-${index}`,
              sessionTitle: `Collapse Session ${index}`,
            }));
          }
          // Keep the single-project case independent of other journeys' records.
          await page.route("**/api/projects", async route => {
            const response = await route.fetch();
            const projects = await response.json() as Array<{ id: string }>;
            await route.fulfill({ response, json: projects.filter(project => fixtures.some(fixture => fixture.project.id === project.id)) });
          });
          await openProjectSession(page, fixtures[0]!);
          await expect(panel.locator(".nav-resource")).toHaveCount(count);
        });
        const sessionUrl = page.url();
        await journey.step("Collapse Projects", "All Project rows disappear; the current Session stays open.", async () => {
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expect(panel).toHaveCount(0);
          await expect(page).toHaveURL(sessionUrl);
          await expect(page.getByRole("heading", { name: fixtures[0]!.session.title, exact: true })).toBeVisible();
          await toggle.focus();
          await page.keyboard.press("Tab");
          await expect(page.getByRole("button", { name: "Add project", exact: true })).toBeFocused();
        });
        await journey.step("Expand Projects", "All rows return with the same selected Project.", async () => {
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(panel.locator(".nav-resource")).toHaveCount(count);
          await expect(panel.locator(".nav-item.active")).toHaveText(fixtures[0]!.project.name);
          await expect(page).toHaveURL(sessionUrl);
        });
        await journey.step("Add a Project from the collapsed panel", "The list expands and the creation dialog opens; cancel keeps the current Session.", async () => {
          await toggle.click();
          await page.getByRole("button", { name: "Add project", exact: true }).click();
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expect(panel.locator(".nav-resource")).toHaveCount(count);
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await expect(page).toHaveURL(sessionUrl);
        });
      } finally {
        for (const fixture of fixtures.reverse()) await cleanupJourney(page, fixture);
      }
    });
  }
});
