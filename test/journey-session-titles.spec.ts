// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { expect } from "@playwright/test";
import { test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession, scriptedModel, sendUserMessage, waitForRunTerminal, type JourneyFixture } from "./helpers/journeys.ts";

test.describe("journey-session-titles.spec", { tag: ["@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {
  /**
   * E2E-META
   * Purpose: Read complete Chinese and English automatic titles after long first messages without reasoning leaks or stored ellipses.
   * Steps:
   *   1. Send a long first message to an untitled Session using a local naming model.
   *   2. Wait for a shorter complete title, or a safe default when only reasoning is returned.
   *   3. Reload and inspect the persisted title, sidebar overflow styling and full-title tooltip.
   * Environment: Isolated current-worktree API/Web and Runner at E2E_BASE_URL.
   * Type: mocked
   * LLM: Local scripted model returns an oversized title then a complete summary, or reasoning only.
   * WebSearch: none
   * PaperSources: none
   * MCP: none
   * OtherExternal: none
   * Credentials: E2E_API_TOKEN for the isolated local stack only.
   * CostSideEffects: Temporary model, Project and Session removed in finally; no external cost.
   */
  test("Complete automatic titles survive reload and sidebar overflow", { tag: "@mocked" }, async ({ page, journey }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => localStorage.setItem("sciencediscovery-locale", "en"));
    journey.scenario({ goal: "Identify long research requests by complete titles without reasoning or truncation.", preconditions: ["Isolated stack is running", "Model calls stay on loopback"] });
    const scenarios = [
      {
        prompt: "请分析多个治疗队列中不同细胞状态的TP53表达差异，调查肿瘤免疫微环境和治疗响应之间的关系并设计后续实验",
        titles: ["多个治疗队列不同细胞状态TP53表达差异及肿瘤免疫微环境与治疗响应关系分析", "<think>outer<think>inner</think>secret</think>TP53表达与治疗响应"],
        expected: "TP53表达与治疗响应",
      },
      {
        prompt: "Compare TP53 expression across treatment cohorts and cell states, investigate immune microenvironment changes and propose validation experiments",
        titles: ["A comprehensive comparison of TP53 expression across treatment cohorts and immune cell states", "<think>secret</think>TP53 expression and treatment response"],
        expected: "TP53 expression and treatment response",
      },
      {
        prompt: "Investigate immune microenvironment changes across several treatment cohorts and propose follow-up validation experiments",
        titles: ["<think>Reasoning without a usable title</think>"],
        expected: undefined,
      },
    ];
    for (const scenario of scenarios) {
      const stub = await scriptedModel([{ text: "Analysis complete." }], undefined, { namingTitles: scenario.titles });
      let fixture: JourneyFixture | undefined;
      try {
        fixture = await createProjectAndSession(page, { projectName: `Session title ${Date.now()}`, sessionTitle: "Untitled session", model: { ...stub, name: `Naming ${Date.now()}` } });
        await journey.step("Submit a long first message", "The task completes and naming runs in the background.", async () => {
          await openProjectSession(page, fixture!);
          const run = await sendUserMessage(page, fixture!.session.id, scenario.prompt);
          expect((await waitForRunTerminal(page, fixture!.session.id, run.id)).status).toBe("completed");
        });
        let storedTitle = "";
        await journey.step("Read the complete stored title", "An oversized response is summarized again; reasoning-only output retains a safe default.", async () => {
          await expect.poll(async () => {
            const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}`, { headers: authorizationHeader() });
            expect(response.ok()).toBeTruthy();
            storedTitle = (await response.json()).title;
            return scenario.expected ? storedTitle === scenario.expected : /^Session \d{2}-\d{2} \d{2}:\d{2}$/.test(storedTitle);
          }).toBe(true);
          expect(storedTitle).not.toMatch(/think|secret|…|\.{3}/);
        });
        await journey.step("Reload and read the full sidebar title", "Only CSS clips overflow; the full stored phrase remains available in the tooltip.", async () => {
          await page.reload();
          const row = page.locator("#sessions-panel-content button.nav-item").filter({ hasText: storedTitle });
          const label = row.locator("span").last();
          await expect(label).toHaveText(storedTitle);
          await expect(label).toHaveAttribute("title", storedTitle);
          await expect(label).toHaveCSS("text-overflow", "ellipsis");
        });
      } finally {
        if (fixture) await cleanupJourney(page, fixture);
        await stub.stop();
      }
    }
  });
});
