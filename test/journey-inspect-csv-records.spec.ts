// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  scriptedModel,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: A researcher selects a CSV record whose duplicate identifier collides with another source identifier and sees only that record highlighted and its own values in the inspector.
 * Steps:
 *   1. Create an isolated Project/Session with a local scripted model.
 *   2. Generate and declare a CSV containing sample#4/111, sample/222, and sample/333.
 *   3. Open its CSV visualization and select the record with value 333.
 *   4. Switch between the other records and back to 333, checking single-row selection and the matching detail value.
 * Environment: Isolated local product stack with its sandbox Runner and a journey-owned Project/Session.
 * Type: mocked
 * LLM: Journey-owned OpenAI-compatible loopback stub; one deterministic turn.
 * WebSearch: none
 * PaperSources: none
 * MCP: Product platform tools only; no custom external MCP servers.
 * OtherExternal: none; file generation uses offline sandbox Python and browser non-local requests are blocked.
 * Credentials: E2E_API_TOKEN for the isolated local API and a local stub token only.
 * CostSideEffects: No external cost; temporary local records and files are deleted in finally.
 */
test("CSV records with colliding identifiers retain independent selection and details", {
  tag: ["@mocked", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"],
}, async ({ journey, page }) => {
  test.setTimeout(180_000);
  const filename = "results/duplicate-ids.csv";
  const python = [
    "from pathlib import Path",
    "Path('results').mkdir(exist_ok=True)",
    "Path('results/duplicate-ids.csv').write_text('id,value\\nsample#4,111\\nsample,222\\nsample,333\\n')",
  ].join("\n");
  const stub = await scriptedModel([
    { tool: "run_shell", arguments: { command: `python3 - <<'PY'\n${python}\nPY` } },
    { tool: "declare_artifact", arguments: { path: filename } },
    { text: "The CSV is ready for record inspection." },
  ], undefined, { waitForShellCompletion: true });
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `CSV record inspection ${Date.now()}` },
    projectName: `CSV record inspection ${Date.now()}`,
    sessionTitle: "Inspect CSV records",
  });
  journey.scenario({
    goal: "Select one CSV record and inspect its own values even when source IDs resemble generated duplicate suffixes.",
    preconditions: ["Isolated local stack and sandbox", "Journey-owned local model", "No external credentials or services"],
  });
  try {
    await journey.step("Generate the CSV artifact", "The analysis completes and declares one CSV artifact.", async () => {
      await openProjectSession(page, fixture);
      const run = await sendUserMessage(page, fixture.session.id, "Create a CSV for inspecting duplicate sample identifiers.");
      const terminal = await waitForRunTerminal(page, fixture.session.id, run.id);
      expect(terminal.status, terminal.error).toBe("completed");
      const tree = await artifactTree(page);
      await expect(tree.artifactCount).toHaveText("1");
    });
    const workspace = page.locator(".csva-window");
    await journey.step("Open the CSV data table", "All three source records are available in the data table.", async () => {
      const tree = await artifactTree(page);
      await tree.catalog.getByRole("button", { name: `Open ${filename}`, exact: true }).click();
      const artifact = page.getByRole("dialog", { name: `Artifact: ${filename}`, exact: true });
      await artifact.locator(".csv-artifact-launch").click();
      await workspace.locator(".csva-view-tabs").getByRole("button", { name: "Data table", exact: true }).click();
      await expect(workspace.locator(".csva-virtual-grid-row")).toHaveCount(3);
    });
    async function selectAndInspect(value: string) {
      await workspace.locator(".csva-virtual-grid-row").filter({ hasText: value }).click();
      await expect(workspace.locator(".csva-record-fields > div").filter({ hasText: "value" }).locator("dd")).toHaveText(value);
      await expect(workspace.locator('.csva-virtual-grid-row[aria-selected="true"]')).toHaveCount(1);
      await expect(workspace.locator(".csva-selection-count strong")).toHaveText("1");
    }
    await journey.step("Select the record with value 333", "Only the 333 row is highlighted and its detail value is 333, rather than 111.", async () => {
      await selectAndInspect("333");
      await expect(workspace.locator(".csva-record-fields > div").filter({ hasText: /^id/ }).locator("dd")).toHaveText("sample");
    });
    await journey.step("Switch records and return to 333", "111, 222, and 333 each show their own details and retain exactly one highlighted row.", async () => {
      for (const value of ["111", "222", "333"]) await selectAndInspect(value);
    });
  } finally {
    try { await cleanupJourney(page, fixture); } finally { await stub.stop(); }
  }
});
