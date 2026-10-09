// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage,
  waitForRunTerminal, artifactTree, type JourneyFixture } from "./helpers/journeys.ts";
import { drbArticle } from "./helpers/deepresearchbench.ts";
import { researchModel, type ResearchStep } from "./helpers/research-model.ts";

for (const id of ["LR-13", "LR-15"]) {
/**
 * E2E-META
 * Purpose: Preserve child workspace and artifact version identity, and durable report delivery in Swarm research.
 * Steps:
 *   1. Write synthetic child notes, declare versions and read artifacts through the parent.
 *   2. Deliver the report, reload the browser and inspect persisted content.
 * Environment: Isolated Swarm stack with E2E_SWARM_TASK=1; local Runner enabled.
 * Type: mocked
 * LLM: Loopback scripted model; actual Swarm and platform tool execution.
 * WebSearch: none
 * PaperSources: Synthetic citation markers only; URLs are not fetched.
 * MCP: Real Swarm-to-platform shell and artifact bridge.
 * OtherExternal: none; local API, browser, sandbox and artifact store.
 * Credentials: E2E_API_TOKEN; local model fixture token only.
 * CostSideEffects: Temporary model/project/artifacts removed in finally; no paid calls.
 */
test(`${id} ${id === "LR-13" ? "child file names and report versions remain isolated" : "report survives reload with identical content and version"}`,
  { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires isolated Swarm stack with platform task delegation").toBe(false);
  test.setTimeout(180_000);
  journey.scenario({ goal: "Read real persisted research outputs instead of trusting scripted final claims", preconditions: ["Swarm stack", "local sandbox"] });
  const report = "# Synthetic literature review\n\n## Methods\nLocal fixtures only.\n\n## Results\nSOURCE_A_V1, SOURCE_A_V2 and SOURCE_B are distinct.\n\n## References\nhttps://example.invalid/synthetic-source\n";
  const write = (content: string, file: string): ResearchStep => ({ tools: [{ name: "run_shell", arguments: {
    command: `printf '%s' '${content}' > '${file}'`,
  } }] });
  const declare = (name: string, path = "shared.md"): ResearchStep => ({ tools: [{ name: "declare_artifact", arguments: { path, name } }] });
  const main: ResearchStep[] = [];
  if (id === "LR-13") main.push({ tools: ["a", "b"].map(name => ({ name: "task", arguments: {
    description: `Synthetic notes ${name}`, prompt: `LR_CHILD_${name}: Write and declare your own source notes.`, subagent_type: "general-purpose",
    max_turns: 8, timeout_seconds: 90,
  } })) }, { tools: [
    { name: "read_artifact", arguments: { name: "notes-a.md", version: 1 } },
    { name: "read_artifact", arguments: { name: "notes-a.md", version: 2 } },
    { name: "read_artifact", arguments: { name: "notes-b.md", version: 1 } },
  ] });
  main.push(write(report, "fixture-review.md"), declare("fixture-review.md", "fixture-review.md"), { text: "Delivered fixture-review.md. This report contains synthetic fixtures, not scientific evidence." });
  const stub = await researchModel({ main,
    a: [write("SOURCE_A_V1", "shared.md"), declare("notes-a.md"), write("SOURCE_A_V2", "shared.md"), declare("notes-a.md"), { text: "Declared both versions of notes-a.md." }],
    b: [write("SOURCE_B", "shared.md"), declare("notes-b.md"), { text: "Declared notes-b.md." }],
  });
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Artifacts ${id}` },
      projectName: `Literature artifacts ${id} ${Date.now()}`, sessionTitle: `Artifact lifecycle ${id}` });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, "Execute the local synthetic research artifact fixture and deliver fixture-review.md.");
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 120_000);
    expect(terminal.status, terminal.error).toBe("completed");
    if (id === "LR-13") {
      // Check actual LLM input after artifact reads, not the fixture's invented final answer.
      const observed = stub.calls.filter(c => c.route === "main" && c.step === 2).flatMap(c => c.results).join("\n");
      for (const marker of ["SOURCE_A_V1", "SOURCE_A_V2", "SOURCE_B"]) expect(observed).toContain(marker);
      expect((await drbArticle(page, fixture.session.id, "notes-a.md")).article).toBe("SOURCE_A_V2");
      expect((await drbArticle(page, fixture.session.id, "notes-b.md")).article).toBe("SOURCE_B");
    }
    const persisted = await drbArticle(page, fixture.session.id, "fixture-review.md");
    expect(persisted.article).toBe(report);
    await page.reload();
    await openProjectSession(page, fixture);
    expect(await drbArticle(page, fixture.session.id, "fixture-review.md")).toEqual(persisted);
    const tree = await artifactTree(page);
    await tree.catalog.getByRole("button", { name: "Open fixture-review.md", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "Artifact: fixture-review.md" });
    await expect(preview).toBeVisible();
    await expect(preview.locator(".artifact-version-preview")).toContainText("Synthetic literature review");
    await expect(page.locator(".message.assistant").last()).toContainText("fixture-review.md");
    expect(stub.errors).toEqual([]);
  } finally {
    await info.attach("model-input-tool-results", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    await info.attach("fixture-errors", { body: JSON.stringify(stub.errors), contentType: "application/json" });
    try { if (fixture) await cleanupJourney(page, fixture); } finally { await stub.stop(); }
  }
});
}
