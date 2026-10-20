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
import { cleanupJourney, type JourneyFixture } from "./helpers/journeys.ts";

test.describe("project creation dialog", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  test.use({ locale: "en-US" });

  /**
   * E2E-META
   * Purpose: The new-project dialog defaults to name plus an optional research description, with runtime inheritance folded into collapsed Advanced settings.
   * Steps:
   *   1. Open an empty workbench and open Add project; the default view shows only Project name, Research description, a collapsed Advanced settings entry, and the actions.
   *   2. Expand Advanced settings; the inherited runtime fields (Task model, Connectors, Skills) appear and stay overridable.
   *   3. Close, reopen, fill only the name and description, and create; the Project persists the description and the default (inherited) settings overrides.
   * Environment: Isolated local stack at E2E_BASE_URL; English browser locale; no model required.
   * Type: mocked
   * LLM: none
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none — non-local browser requests are aborted.
   * Credentials: E2E_API_TOKEN for the isolated local API only.
   * CostSideEffects: no external cost; the created Project is deleted in finally.
   */
  test("New-project dialog defaults to name-only with folded advanced settings", { tag: "@mocked" }, async ({ page, journey }) => {
    journey.scenario({
      goal: "Create a Project from a name and an optional research description without confronting runtime inheritance settings.",
      preconditions: ["Isolated local stack; no model is required."],
    });
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    const projectName = `Dialog-${Date.now()}`;
    const projectDescription = "Compare tumor vs normal samples (RNA-seq).";
    let created: JourneyFixture | undefined;
    try {
      await journey.step(
        "Open Add project",
        "The dialog shows Project name and Research description; Advanced settings is collapsed and hides the inheritance fields.",
        async () => {
          await page.goto("/");
          await page.getByRole("button", { name: "Add project", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Create Project" });
          await expect(dialog.getByLabel("Project name")).toBeVisible();
          await expect(dialog.getByLabel("Research description")).toBeVisible();
          const advanced = dialog.locator(".scoped-settings-advanced");
          await expect(advanced).toBeVisible();
          await expect(advanced).not.toHaveAttribute("open", "");
          await expect(advanced.locator("> summary")).toHaveText("Advanced settings");
          await expect(dialog.getByLabel("Task model")).toBeHidden();
          await expect(dialog.getByText("Optional extensions")).toBeHidden();
          for (const sourceNote of await dialog.getByText(/Effective:/).all()) await expect(sourceNote).toBeHidden();
        },
      );
      await journey.step(
        "Expand Advanced settings",
        "The inherited Task model, connectors, and skills appear and stay overridable.",
        async () => {
          const dialog = page.getByRole("dialog", { name: "Create Project" });
          await dialog.locator(".scoped-settings-advanced > summary").click();
          await expect(dialog.getByLabel("Task model")).toBeVisible();
          await expect(dialog.getByText("Optional extensions")).toBeVisible();
          await expect(dialog.getByText(/Effective:/).first()).toBeVisible();
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        },
      );
      await journey.step(
        "Create with name and description only",
        "The Project is created with the description persisted and the default inherited settings overrides.",
        async () => {
          await page.getByRole("button", { name: "Add project", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: "Create Project" });
          await expect(dialog.locator(".scoped-settings-advanced")).not.toHaveAttribute("open", "");
          await dialog.getByLabel("Project name").fill(projectName);
          await dialog.getByLabel("Research description").fill(projectDescription);
          const projectResponsePromise = page.waitForResponse((response) =>
            response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects");
          await dialog.getByRole("button", { name: "Create Project", exact: true }).click();
          const createdPayload = await (await projectResponsePromise).json() as {
            firstSession: JourneyFixture["session"];
            project: JourneyFixture["project"] & { description?: string; settingsOverrides: Record<string, unknown> };
          };
          created = { project: createdPayload.project, session: createdPayload.firstSession };
          expect(createdPayload.project.name).toBe(projectName);
          expect(createdPayload.project.description).toBe(projectDescription);
          expect(createdPayload.project.settingsOverrides).toEqual({ enabledSkillLibraries: [] });
          await expect(dialog).toHaveCount(0);
          await expect(page.getByRole("button", { name: projectName })).toBeVisible();
        },
      );
    } finally {
      if (created) await cleanupJourney(page, created);
    }
  });
});
