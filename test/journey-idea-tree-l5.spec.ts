// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

const cases = [
  { id: "iteration", title: "Multi-round water treatment research", template: "water-treatment-materials/v1", prompt: "Explore low-cost iron and manganese catalysts for near-neutral water treatment. Consider activity, recovery and leaching. Do not retrieve literature; distinguish hypotheses from evidence.", pause: false },
  { id: "recovery", title: "Resume a materials research", template: "scientific-hypothesis-general/v1", prompt: "Investigate how repeated wetting affects the durability of biodegradable packaging. Consider measurable controls, uncertainty and practical feasibility. Do not retrieve literature.", pause: true },
] as const;

for (const scenario of cases) {
  /**
   * E2E-META
   * Purpose: Verify real-model multi-round Idea Tree results and recovery through a user session.
   * Steps:
   *   1. Configure standard exploration, create a session and start research from the composer.
   *   2. For the recovery case, pause in progress and continue manually.
   *   3. Inspect completed candidates, independent assessments and propagated root insight; reload and retrieve persisted results.
   * Environment: Isolated API/web, Runner and evolve services on Linux.
   * Type: real
   * LLM: Live OpenAI-compatible provider configured by E2E_LLM_BASE_URL and E2E_LLM_MODEL.
   * WebSearch: none requested
   * PaperSources: none requested
   * MCP: none requested
   * OtherExternal: configured live LLM endpoint.
   * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
   * CostSideEffects: Billable model calls; temporary project and model deleted and global settings restored.
   */
  test(`L5 Idea Tree: ${scenario.title}`, { tag: ["@real", "@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l5", "@sandbox:bubblewrap"] }, async ({ page, journey }, info) => {
    test.setTimeout(7_200_000);
    journey.scenario({ goal: scenario.title, preconditions: ["Isolated stack with evolve", "Real model credentials", "Standard exploration: up to three rounds"] });
    const real = requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    await requireRealStack(info);
    const headers = authorizationHeader();
    const settingsUrl = `${apiBaseUrl()}/api/settings/idea-tree`;
    const originalResponse = await page.request.get(settingsUrl, { headers });
    expect(originalResponse.ok()).toBe(true);
    const original = await originalResponse.json();
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let researchId = "";
    const read = async () => {
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`, { headers, timeout: 15_000, maxRetries: 2 });
      expect(response.ok()).toBe(true);
      return (await response.json()).items;
    };
    try {
      await journey.step("Start research", "A research record appears for the chosen objective", async () => {
        const settings = await page.request.put(settingsUrl, { headers, data: { templateId: scenario.template, explorationIntensity: "standard" } });
        expect(settings.ok()).toBe(true);
        fixture = await createProjectAndSession(page, { model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `L5 Idea Tree ${scenario.id} ${Date.now()}` }, projectName: `L5 Idea Tree ${scenario.id} ${Date.now()}`, sessionTitle: scenario.title });
        await openProjectSession(page, fixture);
        await page.locator("form.composer").getByRole("textbox").fill(`/idea-tree ${scenario.prompt}`);
        await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
        await expect.poll(async () => (await read()).length, { timeout: 300_000 }).toBeGreaterThan(0);
        researchId = (await read())[0].research.id;
      });
      if (scenario.pause) {
        await journey.step("Pause and resume", "Research reaches paused state and can continue without losing its identity", async () => {
          const endpoint = `${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`;
          const pause = await page.request.post(endpoint, { headers, data: { operation: "pause", researchId } });
          expect(pause.ok()).toBe(true);
          await expect.poll(async () => (await read()).find((item: any) => item.research.id === researchId)?.research.status, { timeout: 1_800_000 }).toBe("paused");
          const resume = await page.request.post(endpoint, { headers, data: { operation: "continue", researchId } });
          expect(resume.ok()).toBe(true);
        });
      }
      await journey.step("Inspect completed research", "Multiple rounds complete with scored candidates, assessments and root insight", async () => {
        await expect.poll(async () => (await read()).find((item: any) => item.research.id === researchId)?.research.status, { timeout: 6_600_000 }).toBe("completed");
        const { research, graph } = (await read()).find((item: any) => item.research.id === researchId);
        expect(research.round).toBeGreaterThanOrEqual(2);
        const candidates = graph.nodes.filter((node: any) => node.kind === "candidate" && node.status === "done");
        expect(candidates.length).toBeGreaterThan(0);
        for (const candidate of candidates) {
          expect(typeof candidate.score).toBe("number");
          expect(candidate.insight?.trim()).toBeTruthy();
          const assessors = scenario.id === "iteration" ? ["activity", "stability", "sustainability"] : ["scientificValidity", "evidenceReadiness", "feasibility"];
          for (const role of assessors) expect(typeof candidate.stages[role]?.score).toBe("number");
        }
        expect(graph.nodes.find((node: any) => node.id === "ROOT")?.insight?.trim()).toBeTruthy();
      });
      await journey.step("Reopen results", "The completed research and root insight remain available after reload", async () => {
        await page.reload();
        const saved = (await read()).find((item: any) => item.research.id === researchId);
        expect(saved?.research.status).toBe("completed");
        expect(saved.graph.nodes.find((node: any) => node.id === "ROOT")?.insight?.trim()).toBeTruthy();
      });
    } finally {
      try {
        if (fixture) await cleanupJourney(page, fixture);
      } finally {
        const restored = await page.request.put(settingsUrl, { headers, data: { templateId: original.templateId, explorationIntensity: original.explorationIntensity } });
        expect(restored.ok()).toBe(true);
      }
    }
  });
}
