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

import { expect, type Locator, type Page } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  expectNoArtifactCatalog,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

async function expectColumnAlignment(table: Locator) {
  await expect(table).toBeVisible();
  const columns = await table.evaluate((element) => {
    const headings = Array.from(element.querySelectorAll("thead th"));
    return Array.from(element.querySelectorAll("tbody tr")).flatMap((row) =>
      Array.from(row.querySelectorAll("td")).map((cell, index) => ({
        column: headings[index]?.textContent,
        heading: headings[index] ? getComputedStyle(headings[index]).textAlign : null,
        cell: getComputedStyle(cell).textAlign,
      })),
    );
  });
  expect(columns.length).toBeGreaterThan(0);
  for (const column of columns) expect(column.cell, `alignment of ${column.column}`).toBe(column.heading);
}

test.describe("journey-artifact-table-alignment.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
const PROSE = "Control and treatment measurements remain readable without changing the report layout.";
const SOURCE = "growth_rate = 0.61\nprint(growth_rate)\n";
/**
 * E2E-META
 * Purpose: Dataset and Markdown table headers align with their cells, while prose and source previews retain their layout (issue 429).
 * Steps:
 *   1. Create an isolated Project/Session with a local stub and generate dataset, Markdown and source artifacts.
 *   2. Open dataset and Markdown artifacts at 1280px and 1920px; compare every header/body column alignment.
 *   3. Open prose and source previews; check contents, reading measure and source whitespace.
 * Environment: Isolated source stack at E2E_BASE_URL, usable bubblewrap and pinned Chromium.
 * Type: mocked
 * LLM: journey-owned local HTTP stub only.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: E2E_API_TOKEN for the isolated API only.
 * CostSideEffects: no external cost; journey-owned records are deleted in finally.
 */
test("J429 Artifact table headings align with values without changing prose or source", { tag: "@mocked" }, async ({ journey, page }) => {
  test.setTimeout(180_000);
  const dataset = JSON.stringify([{ sample: "control", concentration_mM: 0, growth_rate: 0.12 }, { sample: "实验组", concentration_mM: 12.5, growth_rate: 0.61 }]);
  const report = "# Growth measurements\n\n" + PROSE + "\n\n| Sample | Concentration | Growth |\n| --- | ---: | :---: |\n| control | 0 | 0.12 |\n| 实验组 | 12.5 | 0.61 |\n";
  const files = { "dataset.json": dataset, "report.md": report, "prose.md": "# Summary\n\n" + PROSE, "analysis.py": SOURCE };
  const shell = "mkdir -p results\n" + Object.entries(files).map(([name, content]) => `cat > results/${name} <<'CONTENT'\n${content}\nCONTENT`).join("\n");
  const stub = await scriptedModel([[
    { arguments: { command: shell }, delayMs: 300, tool: "run_shell" },
    ...Object.keys(files).map(name => ({ arguments: { path: `results/${name}` }, tool: "declare_artifact" })),
    { text: "Declared the measurements, report, summary and analysis source." },
  ]]);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `J429 model ${Date.now()}` },
    projectName: `J429 alignment ${Date.now()}`, sessionTitle: `J429 artifacts ${Date.now()}`,
  });
  journey.scenario({ goal: "Read dataset columns beneath matching headers and keep prose/source previews unchanged.", preconditions: ["Isolated local stack with a usable sandbox", "Journey-owned model, Project and Session; no external services"] });
  try {
    await journey.step("Generate the research artifacts", "Four artifacts are available in the Session.", async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await openProjectSession(page, fixture);
      await expectNoArtifactCatalog(page);
      const run = await sendUserMessage(page, fixture.session.id, "Prepare the measurements, report, summary and analysis source.");
      const terminal = await waitForRunTerminal(page, fixture.session.id, run.id);
      expect(terminal.status, terminal.error).toBe("completed");
    });
    const tree = await artifactTree(page);
    await expect(tree.artifactCount).toHaveText("4", { timeout: 30_000 });
    const open = async (name: string) => {
      await tree.catalog.getByRole("button", { name: `Open results/${name}` }).click();
      const dialog = page.getByRole("dialog", { name: `Artifact: results/${name}` });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    const close = async (dialog: Locator) => {
      await dialog.getByRole("button", { name: "Close artifact viewer" }).click();
      await expect(dialog).toHaveCount(0);
    };
    await journey.step("Read the prose-only summary and source", "Prose stays within its reading measure and source preserves content and whitespace.", async () => {
      const prose = await open("prose.md");
      await expect(prose.locator(".markdown-body > p")).toHaveText(PROSE);
      expect(await prose.locator(".markdown-body > p").evaluate(element => {
        const style = getComputedStyle(element);
        return element.getBoundingClientRect().width <= parseFloat(style.maxWidth) + 1;
      })).toBe(true);
      await expect(prose.locator("table")).toHaveCount(0);
      await close(prose);
      const source = await open("analysis.py");
      await expect(source.locator("pre.artifact-source-preview")).toContainText(SOURCE.trim());
      await expect(source.locator("pre.artifact-source-preview")).toHaveCSS("white-space", "pre-wrap");
    });
    await journey.step("Read the dataset at laptop and desktop widths", "Text and numeric values align with their headers at 1280px and 1920px.", async () => {
      await close(page.getByRole("dialog", { name: "Artifact: results/analysis.py" }));
      const dialog = await open("dataset.json");
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1080 });
        await expectColumnAlignment(dialog.locator(".dataset-table"));
        await expect(dialog.locator("tbody")).toContainText("12.5");
        await expect(dialog.locator("tbody")).toContainText("实验组");
      }
    });
    await journey.step("Read the Markdown table", "Default, right and center aligned columns keep their declared alignment and readable prose.", async () => {
      await close(page.getByRole("dialog", { name: "Artifact: results/dataset.json" }));
      const dialog = await open("report.md");
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1080 });
        await expectColumnAlignment(dialog.locator(".markdown-body table"));
        await expect(dialog.locator(".markdown-body > p")).toHaveText(PROSE);
      }
    });
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
});
