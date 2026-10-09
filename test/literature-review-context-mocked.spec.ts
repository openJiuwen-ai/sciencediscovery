// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";
import { researchModel, type ResearchScriptStep } from "./helpers/research-model.ts";

for (const id of ["LR-08", "LR-12"]) {
/**
 * E2E-META
 * Purpose: Recover facts from oversized tool output and, separately, from actual Swarm-compressed history.
 * Steps:
 *   1. Produce real large shell output and read only the necessary stored-result ranges.
 *   2. For LR-08, force context pressure, answer actual summarizer requests, and require checkpoint reinjection and source recovery.
 * Environment: Dedicated Swarm stack; LR-08 additionally needs E2E_SWARM_COMPACTION=1 and the documented small context window.
 * Type: mocked
 * LLM: Local model and local summarizer; no synthetic compression events or injected post-compression histories.
 * WebSearch: none
 * PaperSources: Generated synthetic text only.
 * MCP: Real Swarm-to-platform shell and read_tool_output bridge.
 * OtherExternal: none; local Runner and real tool output storage.
 * Credentials: E2E_API_TOKEN; fixture model token only.
 * CostSideEffects: Temporary project/model removed in finally; LR-08 can take several minutes, run serially.
 */
test(`${id} ${id === "LR-08" ? "actual Swarm compression retains recoverable evidence" : "single-line output supports bounded search, character ranges and duplicate-read advice"}`,
  { tag: ["@mocked","@category:e2e","@os:linux","@arch:amd64","@model:mock","@sandbox:bubblewrap","@fixture:research"] }, async ({ page, journey }, info) => {
  expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires Swarm with platform tools").toBe(false);
  expect(id === "LR-08" && process.env.E2E_SWARM_COMPACTION !== "1", "BLOCKED: requires isolated Swarm context-engine configuration; do not alter a live research instance").toBe(false);
  test.setTimeout(id === "LR-08" ? 600_000 : 180_000);
  journey.scenario({ goal: id, preconditions: ["real Swarm", "real output store", "local fixture model"] });
  const refs = (text: string) => [...text.matchAll(/tool-output-[a-f0-9]+/g)].map(match => match[0]);
  const steps: ResearchScriptStep[] = [{ tools: [{ name: "run_shell", arguments: {
    command: "awk 'BEGIN { for(i=0;i<120000;i++) printf \"x\"; printf \"LR_EVIDENCE_RR_1_25\"; for(i=0;i<120000;i++) printf \"y\"; }'",
  } }] }];
  const summaries: Array<{ input: string; output: string }> = [];
  if (id === "LR-08") {
    for (let i = 0; i < 28; i++) steps.push({ tools: [{ name: "run_shell", arguments: { command: `printf 'LR_FILL_${i} '; seq -s ' ' 1 1800` } }] });
  }
  steps.push(({ results, messages }) => {
    const text = JSON.stringify(messages);
    const ref = refs(id === "LR-08" ? text : results.join("\n"))[0];
    expect(ref, "Reference must come from actual context, not test-side state").toBeTruthy();
    if (id === "LR-08") {
      expect(summaries.length, "A genuine summarizer model request must occur").toBeGreaterThan(0);
      expect(text).toContain("LR_COMPACTED_CHECKPOINT");
      expect(text).toContain("LR_RESEARCH_GOAL");
    } else {
      expect(results.at(-1)!.length).toBeLessThan(240000);
      expect(results.at(-1)).not.toContain("LR_EVIDENCE_RR_1_25");
    }
    return { tools: [{ name: "read_tool_output", arguments: { ref, query: "LR_EVIDENCE_RR_1_25", contextChars: 32, maxMatches: 1 } }] };
  });
  if (id === "LR-12") {
    steps.push(({ results }) => {
      expect(results.at(-1)).toContain("LR_EVIDENCE_RR_1_25");
      const ref = refs(results.at(-1)!)[0];
      expect(ref).toBeTruthy();
      // The store contains the complete tool envelope, not stdout alone.
      // Recover the offset from the actual search result, as the model would.
      const match = /\[match 1: chars (\d+)-(\d+)\]/.exec(results.at(-1)!);
      expect(match, "Search must expose a recoverable character range").toBeTruthy();
      return { tools: [{ name: "read_tool_output", arguments: { ref, charOffset: Number(match![1]), charLimit: 100 } }] };
    }, ({ results }) => {
      expect(results.at(-1)).toContain("LR_EVIDENCE_RR_1_25");
      const page = /chars (\d+)-(\d+)/.exec(results.at(-1)!);
      expect(page).toBeTruthy();
      return { tools: [{ name: "read_tool_output", arguments: { ref: refs(results.at(-1)!)[0], charOffset: Number(page![1]), charLimit: 100 } }] };
    });
  }
  steps.push(({ results }) => {
    expect(results.at(-1)).toContain("LR_EVIDENCE_RR_1_25");
    if (id === "LR-12") expect(results.at(-1)).toContain("duplicate_read=true");
    return { text: "Recovered synthetic risk ratio 1.25 from stored evidence; no repeated source acquisition was needed." };
  });
  const stub = await researchModel({ main: steps }, {
    stepIndex: ({ index, messages }) => Math.max(index, ...[...JSON.stringify(messages).matchAll(/LR_NEXT_STEP=(\d+)/g)].map(m => Number(m[1]))),
    summary: messages => {
      const text = JSON.stringify(messages);
      if (!/LR_RESEARCH_GOAL|LR_COMPACTED_CHECKPOINT/.test(text) || !refs(text).length) return "Local fixture title";
      // Preserve only facts actually supplied to this summarizer. No test-owned
      // source ref is injected if the framework has already lost it.
      const next = Math.max(0, ...[...text.matchAll(/lr_main_(\d+)_/g)].map(m => Number(m[1]) + 1),
        ...[...text.matchAll(/LR_NEXT_STEP=(\d+)/g)].map(m => Number(m[1])));
      const output = `<coverage_check>Preserved the supplied research goal, tool-output reference, and completed-step position.</coverage_check>\n<state_snapshot>LR_COMPACTED_CHECKPOINT LR_RESEARCH_GOAL: recover the synthetic cohort evidence. LR_NEXT_STEP=${next}. Source reference ${refs(text)[0]}. Search the retained source for LR_EVIDENCE_RR_1_25.</state_snapshot>`;
      summaries.push({ input: text, output });
      return output;
    },
  });
  let fixture: JourneyFixture | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: {
      apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: id }, projectName: `${id} context ${Date.now()}`, sessionTitle: id });
    await openProjectSession(page, fixture);
    const run = await sendUserMessage(page, fixture.session.id, "LR_RESEARCH_GOAL: recover the synthetic cohort evidence from tool output, preserve its reference through summarization, and report the risk ratio.");
    const terminal = await waitForRunTerminal(page, fixture.session.id, run.id, id === "LR-08" ? 480_000 : 120_000);
    expect(terminal.status, terminal.error).toBe("completed");
    expect(stub.errors).toEqual([]);
    await expect(page.locator(".message.assistant").last()).toContainText("risk ratio 1.25");
  } finally {
    await info.attach("model-contexts", { body: JSON.stringify(stub.calls), contentType: "application/json" });
    await info.attach("actual-summary-requests", { body: JSON.stringify(summaries), contentType: "application/json" });
    await info.attach("fixture-errors", { body: JSON.stringify(stub.errors), contentType: "application/json" });
    try { if (fixture) await cleanupJourney(page, fixture); } finally { await stub.stop(); }
  }
});
}
