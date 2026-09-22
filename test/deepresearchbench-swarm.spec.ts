// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0

import { expect } from "@playwright/test";

import { allowRealEnvException, requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import {
  artifactTree,
  cleanupJourney,
  createProjectAndSession,
  openProjectSession,
  readRunActivity,
  sendUserMessage,
  waitForRunTerminal,
} from "./helpers/journeys.ts";

const output = "deepresearchbench-59.md";
const prompt = [
  "Complete the following DeepResearchBench task as a scientific literature review.",
  "Use the available research tools to find credible sources and distinguish established findings, contested claims, and evidence limitations.",
  "For this bounded integration run, delegate two focused source-retrieval tasks to the builtin-literature-searcher specialist: navigation mechanisms and environmental disturbances. Each task should retrieve 3-5 relevant sources through its governed literature MCP tools, then return a compact source package with URLs. Every task call must set max_turns to 20 and timeout_seconds to 600. Do not launch further subagents. Use their results to write the review and disclose search gaps; do not request exhaustive coverage.",
  `Deliver the full report as a declared Markdown Artifact named ${output}.`,
  "Include a descriptive title, section headings, synthesis, limitations, and references with resolvable URLs.",
  "<task>",
  "In ecology, how do birds achieve precise location and direction navigation during migration? What cues and disturbances influence this process?",
  "</task>",
].join("\n");

/**
 * E2E-META
 * Purpose: Verify the previously failing DRB-59 task/subagent/MCP path completes on JiuwenSwarm and declares its report.
 * Steps:
 *   1. Register the live model and create an always-allow Session.
 *   2. Submit the DRB-59 literature-review task and wait for terminal state.
 *   3. Assert visible research activity, a declared Markdown Artifact, and a non-empty final handoff.
 * Environment: Opt-in isolated real E2E stack with outbound research access.
 * Type: real
 * LLM: Live OpenAI-compatible provider; tool choices and prose vary.
 * WebSearch: Live configured web providers.
 * PaperSources: Live sources selected by the Agent.
 * MCP: ScienceDiscovery tools hosted through the JiuwenSwarm MCP adapter.
 * OtherExternal: Source websites, local API, Runner, browser UI, Artifact store.
 * Credentials: E2E_API_TOKEN; E2E_LLM_MODEL_ID for a preconfigured live model, or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.
 * CostSideEffects: Billable model calls and external queries; temporary records are deleted.
 */
test("DRB-59 Swarm research integration", { tag: "@real" }, async ({ journey, page }, testInfo) => {
  test.setTimeout(1_200_000);
  testInfo.skip(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires Swarm backend with platform task delegation (E2E_SWARM_TASK=1)");
  journey.scenario({
    goal: "Verify the previously failing DRB-59 task/subagent/MCP path on JiuwenSwarm.",
    preconditions: ["live model credentials", "isolated Swarm stack", "outbound web access"],
  });
  const existingModelId = process.env.E2E_LLM_MODEL_ID?.trim();
  if (existingModelId) allowRealEnvException(testInfo, "Explicitly opted-in live model already registered on the isolated stack; its credentials remain server-side.");
  const real = existingModelId ? undefined : requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  await requireRealStack(testInfo);
  const fixture = await createProjectAndSession(page, {
    approvalMode: "always_allow",
    ...(existingModelId ? { modelId: existingModelId } : { model: { apiToken: real!.E2E_LLM_TOKEN, baseUrl: real!.E2E_LLM_BASE_URL, model: real!.E2E_LLM_MODEL, name: `DRB-59 ${Date.now()}` } }),
    projectName: `DRB-59 Swarm ${Date.now()}`,
    sessionTitle: "DRB-59 Swarm regression",
  });
  try {
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, prompt);
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, 1_080_000);
    expect(terminal.status, terminal.error ?? "run did not complete").toBe("completed");
    const activity = await readRunActivity(page, { expandTools: true });
    expect(activity.tools.some((tool) => /task/i.test(`${tool.summary}\n${tool.details}`))).toBe(true);
    // A completed parent alone is insufficient: both delegated children must
    // return, and at least one must successfully invoke a literature MCP tool.
    const children = page.locator("section[aria-label='Subagent activity'] details.process-agent-record");
    await expect(children).toHaveCount(2);
    for (let index = 0; index < 2; index += 1) await expect(children.nth(index)).toHaveClass(/completed/);
    let successfulLiteratureCall = false;
    for (let index = 0; index < 2; index += 1) {
      const child = children.nth(index);
      if (await child.getAttribute("open") === null) await child.locator(":scope > summary").click();
      await child.getByRole("button", { name: /^Open SubAgent: / }).click();
      const childTools = await readRunActivity(page, { expandTools: true });
      successfulLiteratureCall ||= childTools.tools.some((tool) => /mcp__.*(?:pubmed|europe|arxiv|biorxiv|medrxiv)/i.test(`${tool.summary}\n${tool.details}`)
        && /"ok"\s*:\s*true/.test(tool.details));
      await page.getByRole("button", { name: "Back to main Agent" }).click();
    }
    expect(successfulLiteratureCall, "at least one child must successfully use a literature MCP tool").toBe(true);
    const tree = await artifactTree(page);
    await expect.poll(async () => tree.artifacts.allTextContents()).toContain(output);
    const answer = (await page.locator(".message.assistant").last().innerText()).trim();
    expect(answer.length).toBeGreaterThan(80);
    await testInfo.attach("integration-result.json", { contentType: "application/json", body: JSON.stringify({
      caseId: 59, sessionId: fixture.session.id, runId: run.id, terminal,
      qualityScore: null, note: "Integration check only; official DeepResearchBench grading is not run.",
    }, null, 2) });
  } finally {
    await cleanupJourney(page, fixture);
  }
});
