// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession,
  readRunActivity, scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Swarm-backed platform delegation recovers from a child tool error and delivers child and parent Artifacts.
 * Steps:
 *   1. A deterministic local model delegates a child through task.
 *   2. The child sees a failed shell result, then writes and declares fixture source notes.
 *   3. The parent continues, writes its report, and both Artifacts and completion are visible.
 * Environment: Isolated Swarm stack with SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS=task and E2E_SWARM_TASK=1.
 * Type: mocked
 * LLM: Local scripted OpenAI-compatible HTTP model; actual Swarm loops are not mocked.
 * WebSearch: none
 * PaperSources: Synthetic source notes written locally; no public literature service is called.
 * MCP: Actual Swarm-to-platform MCP tool bridge; scientific upstream MCP discovery is tested separately.
 * OtherExternal: none; actual local API, sandbox, artifact persistence and browser.
 * Credentials: E2E_API_TOKEN only; model token is a local fixture value.
 * CostSideEffects: No billable API calls; temporary project and model removed in finally.
 */
test("Swarm child tool failure recovers and parent delivers report", { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ page, journey }, testInfo) => {
  expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires Swarm backend with platform task delegation (E2E_SWARM_TASK=1)").toBe(false);
  test.setTimeout(240_000);
  journey.scenario({ goal: "Recover from a child tool error without losing the parent research run",
    preconditions: ["Swarm-backed isolated stack", "platform task delegation", "local sandbox"] });
  const stub = await scriptedModel([[
    { tool: "task", arguments: { description: "Collect fixture source notes", subagent_type: "general-purpose",
      prompt: "Prepare fixture-sources.md and return the declared source notes.", max_turns: 8, timeout_seconds: 120 } },
    { tool: "read_artifact", arguments: { name: "fixture-sources.md", version: 1 } },
    { tool: "run_shell", arguments: { command: "printf '# Research report\n\nSynthesis based on fixture source notes.\n\n## Limitations\nSynthetic data only.\n' > fixture-report.md" } },
    { tool: "declare_artifact", arguments: { path: "fixture-report.md" } },
    { text: "Research complete. fixture-report.md synthesizes the child notes in fixture-sources.md; these are synthetic fixtures, not scientific evidence." },
  ], [{ text: "Follow-up complete: prior fixture report remains available." }]], [
    { tool: "run_shell", arguments: { command: "echo FIXTURE-RECOVERABLE-FAILURE >&2; exit 1" } },
    { tool: "run_shell", arguments: { command: "printf '# Fixture source notes\n\nRecovery succeeded. Synthetic bird-navigation source.\n' > fixture-sources.md" } },
    { tool: "declare_artifact", arguments: { path: "fixture-sources.md" } },
    { text: "Recovered from the failed command and declared fixture-sources.md." },
  ]);
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `Swarm fixture ${Date.now()}` },
      projectName: `Swarm research fixture ${Date.now()}`, sessionTitle: "Mocked delegated research" });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, "Delegate fixture source preparation, then write and declare the research report.");
    expect((await waitForRunTerminal(page, fixture.session.id, run.id, 180_000)).status).toBe("completed");
    const card = page.locator("section[aria-label='Subagent activity'] details.process-agent-record");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveClass(/completed/);
    const tree = await artifactTree(page);
    await expect.poll(() => tree.artifacts.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("fixture-report.md"), expect.stringContaining("fixture-sources.md")]));
    await expect(page.locator(".message.assistant").last()).toContainText("Research complete");
    expect(stub.calls.filter((call) => call.route === "subagent" && call.tool === "run_shell")).toHaveLength(2);
    expect(stub.calls.some((call) => call.route === "main" && call.tool === "declare_artifact")).toBe(true);
    expect(stub.calls.some((call) => call.route === "main" && call.tool === "read_artifact")).toBe(true);
    await readRunActivity(page, { expandTools: true });
    // Tool output is lazy-rendered inside its own disclosure, independently
    // of the outer tool card. Open it before checking the visible content.
    const resultSections = page.getByRole("region", { name: "Agent activity" })
      .locator("details.timeline-disclosure.tool details");
    for (let index = 0; index < await resultSections.count(); index += 1) {
      const section = resultSections.nth(index);
      if (await section.getAttribute("open") === null) await section.locator(":scope > summary").click();
    }
    const activity = await readRunActivity(page);
    expect(activity.tools.some((tool) => /read_artifact/.test(tool.summary)
      && /Recovery succeeded/.test(tool.details))).toBe(true);
    expect(activity.tools.some((tool) => /task/.test(tool.summary)
      && /artifact_id/.test(tool.details) && /fixture-sources.md/.test(tool.details))).toBe(true);
    for (const call of stub.calls.filter((call) => call.tool)) expect(call.offeredTools).toContain(call.tool);
    await card.locator(":scope > summary").click();
    await card.getByRole("button", { name: /^Open SubAgent: / }).click();
    await expect(page.locator("section.subagent-conversation")).toContainText("Recovered from the failed command");
    // A new run uses a new route token on the same Swarm session. It must
    // replace the expired connection without resetting conversation history.
    await openProjectSession(page, fixture);
    const followup = await sendUserMessage(page, fixture.session.id, "Acknowledge the prior fixture report without invoking tools.");
    expect((await waitForRunTerminal(page, fixture.session.id, followup.id, 60_000)).status).toBe("completed");
    await expect(page.locator(".message.assistant").last()).toContainText("Follow-up complete");
  } finally {
    try { if (fixture) await cleanupJourney(page, fixture); } finally { await stub.stop(); }
  }
});
