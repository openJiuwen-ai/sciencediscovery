// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "./helpers/e2e.ts";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession,
  scriptedModel, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";

/**
 * E2E-META
 * Purpose: Fast PR-gate coverage for the twelve daily workflow identities.
 * Steps: Keep the project/session UI entry, the primary run, delegation where
 * the daily case has it, artifact delivery and the visible final response.
 * Repeated research/tool turns are represented by one deterministic fixture turn.
 * Environment: Isolated JiuwenSwarm E2E stack with a local scripted model.
 * Type: mocked
 * LLM: Local scripted OpenAI-compatible model; no model capability is measured.
 * WebSearch: Synthetic local notes only.
 * PaperSources: None.
 * MCP: Platform task/artifact bridge where the delegated path is selected.
 * OtherExternal: Browser, local API, Runner and artifact store only.
 * Credentials: E2E_API_TOKEN and the local fixture token.
 * CostSideEffects: No billable requests; each project and model is deleted.
 */

type Flow = "delegated" | "puct" | "direct";
const DAILY_CASES = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/daily-flow-smoke-plan.json", import.meta.url)), "utf8")) as ReadonlyArray<readonly [string, Flow]>;

function safeName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function runDailySmoke(page: Page, id: string, flow: Flow) {
  expect(process.env.E2E_SWARM_TASK !== "1", "Daily smoke requires platform task delegation").toBe(false);
  const name = safeName(id);
  const report = `${name}-report.md`;
  const notes = `${name}-notes.md`;
  const delegated = flow === "delegated";
  const puct = flow === "puct";
  const stub = await scriptedModel(
    delegated
      ? [[
        { tool: "task", arguments: { description: `Prepare synthetic notes for ${id}`, subagent_type: "general-purpose",
          prompt: `Write and declare ${notes}; use synthetic fixture content only.`, max_turns: 4, timeout_seconds: 30 } },
        { tool: "read_artifact", arguments: { name: notes, version: 1 } },
        { tool: "run_shell", arguments: { command: `printf '# ${id} smoke report\\n\\nSynthetic workflow evidence.\\n' > ${report}` } },
        { tool: "declare_artifact", arguments: { path: report } },
        { text: `${id} smoke workflow completed and delivered ${report}.` },
      ]]
      : [[
        { tool: "run_shell", arguments: { command: `printf '# ${id} smoke result\\n\\nDeterministic functional fixture.\\n' > ${report}` } },
        { tool: "declare_artifact", arguments: { path: report } },
        { text: `${id} smoke workflow completed and delivered ${report}.` },
      ]],
    delegated ? [
      { tool: "run_shell", arguments: { command: `printf '# ${id} notes\\n\\nSynthetic source note.\\n' > ${notes}` } },
      { tool: "declare_artifact", arguments: { path: notes } },
      { text: `Synthetic notes for ${id} are ready in ${notes}.` },
    ] : undefined,
  );
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  try {
    fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
      model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `daily-smoke-${name}` },
      projectName: `Daily smoke ${id}`, sessionTitle: `${id} PR gate` });
    await openProjectSession(page, fixture);
    const composer = page.locator("form.composer").getByRole("textbox");
    if (puct) {
      // Keep the PUCT-specific UI click in the gate. The expensive search itself
      // is covered by the real test; the smoke fixture verifies selection and
      // the resulting artifact handoff through the same session surface.
      await composer.fill("/evolve-design ");
      await page.getByRole("option").filter({ hasText: "PUCT" }).click();
      await expect(composer).toHaveValue(/--algorithm puct/);
      await composer.fill(`PR smoke handoff for ${id}; save a concise Markdown result.`);
    }
    const run = await sendUserMessage(page, fixture.session.id,
      puct ? `PR smoke handoff for ${id}; save a concise Markdown result.` : `Run the ${id} daily functional smoke path.`);
    expect((await waitForRunTerminal(page, fixture.session.id, run.id, 90_000)).status).toBe("completed");
    const tree = await artifactTree(page);
    await expect.poll(() => tree.artifacts.allTextContents(), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining(report)]));
    await expect(page.locator(".message.assistant").last()).toContainText(report);
    if (delegated) {
      const card = page.locator("section[aria-label='Subagent activity'] details.process-agent-record");
      await expect(card).toHaveCount(1);
      await expect(card).toHaveClass(/completed/);
      // Preserve the key UI navigation into the child conversation.
      await card.locator(":scope > summary").click();
      await card.getByRole("button", { name: /^Open SubAgent: / }).click();
      await expect(page.locator("section.subagent-conversation")).toContainText(notes);
    }
  } finally {
    try { if (fixture) await cleanupJourney(page, fixture); }
    finally { await stub.stop(); }
  }
}

for (const [id, flow] of DAILY_CASES) {
  /** E2E-META
   * Purpose: Run one daily functional smoke identity with deterministic model output.
   * Steps:
   *   1. Create a Project/Session and submit the case's smoke request through the browser.
   *   2. Exercise the direct or delegated artifact path and assert terminal delivery.
   *   3. Verify the visible artifact and final response, plus the child card when delegated.
   * Environment: Isolated JiuwenSwarm stack and local scripted model.
   * Type: mocked
   * LLM: Local scripted OpenAI-compatible HTTP model.
   * WebSearch: Synthetic local notes only.
   * PaperSources: None.
   * MCP: Platform task/artifact bridge where delegated.
   * OtherExternal: Browser, local API, Runner and artifact store.
   * Credentials: E2E_API_TOKEN and local fixture token.
   * CostSideEffects: No billable requests; temporary records are cleaned up.
   */
  test(`${id} daily flow smoke @daily-smoke`, { tag: ["@mocked", "@daily-smoke", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] },
    async ({ page }) => {
      test.setTimeout(150_000);
      await runDailySmoke(page, id, flow);
    });
}
