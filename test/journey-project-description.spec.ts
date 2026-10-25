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

import type { CreateProjectResponse, Project } from "@sciencediscovery/schema";
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, type JourneyFixture } from "./helpers/journeys.ts";

test.describe("project research description", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  test.use({ locale: "en-US" });

  /**
   * E2E-META
   * Purpose: Read, edit and clear a Project's research description through Project settings without changing other Project data.
   * Steps:
   *   1. Create two Projects through Add project, one with a description and one without, and read the first description in Project settings.
   *   2. At a narrow viewport, cancel a long draft and confirm the saved description remains.
   *   3. Simulate a failed save, retain the draft, retry successfully and reload the settings to verify persistence.
   *   4. Clear with empty and whitespace values and reload; the description is absent from the payload and preview, and unrelated fields and Project B are unchanged.
   * Environment: Isolated API/Web and Runner at E2E_BASE_URL; English browser locale; no Agent execution or model required.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — non-local browser requests are aborted; one local PATCH failure is injected.
   * Credentials: E2E_API_TOKEN for the isolated local API only.
   * CostSideEffects: no external cost; both Projects and their Sessions are deleted in finally.
   */
  test("Read, revise and clear research descriptions in Project settings", { tag: "@mocked" }, async ({ page, journey }) => {
    journey.scenario({
      goal: "Keep a Project's research description visible and editable after creation, independently of other settings and Projects.",
      preconditions: ["Isolated API/Web and Runner; no model or Agent turn is needed."],
    });
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    const fixtures: JourneyFixture[] = [];
    let original!: Project;
    let other!: Project;
    const originalText = "Compare tumor vs normal samples.";
    const updatedText = "Updated RNA-seq note\n比较肿瘤与正常样本。";
    const settings = page.getByRole("dialog", { name: "Project settings", exact: true });
    const description = settings.getByRole("region", { name: "Research description", exact: true });
    const projects = async (): Promise<Project[]> => {
      const response = await page.request.get("/api/projects", { headers: authorizationHeader() });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    try {
      await journey.step("Create Projects A and B", "A stores its research description; B has no description.", async () => {
        await page.goto("/");
        for (const [suffix, text] of [["A", originalText], ["B", ""]]) {
          await page.getByRole("button", { name: "Add project", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Create Project", exact: true });
          await dialog.getByLabel("Project name", { exact: true }).fill(`Research-${suffix}-${Date.now()}`);
          await dialog.getByLabel("Research description", { exact: true }).fill(text);
          const response = page.waitForResponse((item) => item.request().method() === "POST" && new URL(item.url()).pathname === "/api/projects");
          await dialog.getByRole("button", { name: "Create Project", exact: true }).click();
          const payload = await (await response).json() as CreateProjectResponse;
          fixtures.push({ project: payload.project, session: payload.firstSession });
          await expect(dialog).toHaveCount(0);
        }
        original = (await projects()).find((item) => item.id === fixtures[0]!.project.id)!;
        other = (await projects()).find((item) => item.id === fixtures[1]!.project.id)!;
        expect(original.description).toBe(originalText);
        expect(other).not.toHaveProperty("description");
      });
      await journey.step("Read the saved description", "Project A settings display the description without manually querying an API.", async () => {
        await page.getByRole("button", { name: "Projects", exact: true }).click();
        await page.getByRole("button", { name: `More actions for ${original.name}`, exact: true }).click();
        await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await expect(description.locator(".project-description-text")).toHaveText(originalText);
        await expect(description.getByRole("button", { name: "Edit description", exact: true })).toBeVisible();
      });
      await journey.step("Cancel a long draft at 390 × 844", "The textarea and actions fit the narrow dialog; cancel restores the saved description.", async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await description.getByRole("button", { name: "Edit description", exact: true }).click();
        const input = description.getByLabel("Research description", { exact: true });
        await input.fill("https://research.example/" + "研究RNAseq".repeat(247));
        await expect(input).toHaveAttribute("maxlength", "2000");
        const box = await description.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        await expect(description.getByRole("button", { name: "Save description", exact: true })).toBeVisible();
        await description.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(description.locator(".project-description-text")).toHaveText(originalText);
      });
      await journey.step("Recover from a failed save", "The error stays next to the editor and the user's draft remains available for retry.", async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await description.getByRole("button", { name: "Edit description", exact: true }).click();
        await description.getByLabel("Research description", { exact: true }).fill(`  ${updatedText}  `);
        await page.route(`**/api/projects/${original.id}`, async (route) => {
          if (route.request().method() === "PATCH") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Description save unavailable" }) });
          else await route.continue();
        });
        await description.getByRole("button", { name: "Save description", exact: true }).click();
        await expect(description.getByRole("alert")).toContainText("Description save unavailable");
        await expect(description.getByLabel("Research description", { exact: true })).toHaveValue(`  ${updatedText}  `);
        await page.unroute(`**/api/projects/${original.id}`);
      });
      await journey.step("Save and reopen", "The retried save trims the text; a full reload shows the persisted multiline description.", async () => {
        const response = page.waitForResponse((item) => item.request().method() === "PATCH" && new URL(item.url()).pathname === `/api/projects/${original.id}`);
        await description.getByRole("button", { name: "Save description", exact: true }).click();
        const saved = await (await response).json() as Project;
        expect(saved).toEqual({ ...original, description: updatedText });
        await expect(description.locator(".project-description-text")).toHaveText(updatedText);
        await page.reload();
        await expect(description.locator(".project-description-text")).toHaveText(updatedText);
        expect((await projects()).find((item) => item.id === other.id)).toEqual(other);
      });
      await journey.step("Clear with an empty value at 1280 × 600", "Saving empty text removes the payload field and hides the description preview after reload.", async () => {
        await page.setViewportSize({ width: 1280, height: 600 });
        await description.getByRole("button", { name: "Edit description", exact: true }).click();
        await description.getByLabel("Research description", { exact: true }).fill("");
        await description.getByRole("button", { name: "Save description", exact: true }).click();
        await expect(description.getByRole("button", { name: "Add description", exact: true })).toBeVisible();
        await page.reload();
        await expect(description.locator(".project-description-text")).toHaveCount(0);
        expect((await projects()).find((item) => item.id === original.id)).not.toHaveProperty("description");
      });
      await journey.step("Clear with whitespace and check isolation", "Whitespace also removes the field; Project A's other fields and all of Project B remain unchanged.", async () => {
        await description.getByRole("button", { name: "Add description", exact: true }).click();
        await description.getByLabel("Research description", { exact: true }).fill("A temporary note");
        await description.getByRole("button", { name: "Save description", exact: true }).click();
        await expect(description.locator(".project-description-text")).toHaveText("A temporary note");
        await description.getByRole("button", { name: "Edit description", exact: true }).click();
        await description.getByLabel("Research description", { exact: true }).fill("  \n\t  ");
        await description.getByRole("button", { name: "Save description", exact: true }).click();
        await expect(description.getByRole("button", { name: "Add description", exact: true })).toBeVisible();
        await page.reload();
        await expect(description.locator(".project-description-text")).toHaveCount(0);
        await expect(description.getByRole("button", { name: "Add description", exact: true })).toBeVisible();
        const { description: _description, ...unchanged } = original;
        const items = await projects();
        expect(items.find((item) => item.id === original.id)).toEqual(unchanged);
        expect(items.find((item) => item.id === other.id)).toEqual(other);
      });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      for (const fixture of fixtures) await cleanupJourney(page, fixture);
    }
  });
});
