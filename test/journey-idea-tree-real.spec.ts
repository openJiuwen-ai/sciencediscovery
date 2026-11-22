import { expect } from "@playwright/test";
import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

test.describe("Idea Tree real research", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l4", "@sandbox:bubblewrap"] }, () => {
  test.use({ locale: "zh-CN" });

  /**
   * E2E-META
   * Purpose: Complete a small autonomous Idea Tree research using a real model and retrieve its persisted results.
   * Steps:
   *   1. Configure quick water-treatment research and start it from a session.
   *   2. Wait for completion and inspect a scored candidate and its insight.
   *   3. Reload the session and retrieve the same research results again.
   * Environment: Isolated API/web, Runner and evolve services.
   * Type: real
   * LLM: Live OpenAI-compatible provider configured by E2E_LLM_BASE_URL and E2E_LLM_MODEL.
   * WebSearch: none requested
   * PaperSources: none requested
   * MCP: none requested
   * OtherExternal: configured live LLM endpoint.
   * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
   * CostSideEffects: Billable model calls; temporary project and model are deleted.
   */
  test("real Idea Tree research completes and survives reload", { tag: "@real" }, async ({ page, journey }, testInfo) => {
    test.setTimeout(900_000);
    journey.scenario({ goal: "Explore a small materials research question and retrieve the result after reload", preconditions: ["Isolated stack and live model credentials"] });
    const real = requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    await requireRealStack(testInfo);
    const headers = authorizationHeader();
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let researchId = "";
    const read = async () => {
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`, { headers, timeout: 10_000, maxRetries: 2 });
      expect(response.ok()).toBe(true);
      return (await response.json()).items;
    };
    try {
      await journey.step("Start a small research", "Quick research starts from the session", async () => {
        fixture = await createProjectAndSession(page, { model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `Idea Tree real ${Date.now()}` }, projectName: `Idea Tree real ${Date.now()}`, sessionTitle: "Catalyst research" });
        const settings = await page.request.patch(`${apiBaseUrl()}/api/sessions/${fixture.session.id}`, { headers, data: { ideaTreeOverride: { templateId: "water-treatment-materials/v1", explorationIntensity: "quick" } } });
        expect(settings.ok()).toBe(true);
        const existingIds = new Set((await read()).map((item: any) => item.research.id));
        await openProjectSession(page, fixture);
        await page.locator("form.composer").getByRole("textbox").fill("/idea-tree Skip literature retrieval. Explore low-cost iron catalysts for near-neutral water treatment, considering recovery and leaching.");
        await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
        await expect(page.getByRole("region", { name: "Idea Tree 研究控制" })).toBeVisible({ timeout: 120_000 });
        await expect.poll(async () => (await read()).filter((item: any) => !existingIds.has(item.research.id)).length, { timeout: 120_000 }).toBe(1);
        researchId = (await read()).find((item: any) => !existingIds.has(item.research.id)).research.id;
      });
      await journey.step("Inspect completed research", "At least one candidate has a score and insight", async () => {
        await expect.poll(async () => (await read()).find((item: any) => item.research.id === researchId)?.research.status, { timeout: 720_000 }).toBe("completed");
        const { graph, research } = (await read()).find((item: any) => item.research.id === researchId);
        expect(research.settings).toMatchObject({ templateId: "water-treatment-materials/v1", explorationIntensity: "quick" });
        const candidates = graph.nodes.filter((node: any) => node.kind === "candidate");
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.some((node: any) => typeof node.score === "number" && typeof node.insight === "string" && node.insight.trim().length > 0)).toBe(true);
      });
      await journey.step("Reload the research", "The completed research and scored candidate remain available", async () => {
        await page.reload();
        await expect(page.getByRole("region", { name: "Idea Tree 研究控制" })).toBeVisible();
        const items = await read();
        const saved = items.find((item: any) => item.research.id === researchId);
        expect(saved?.research.status).toBe("completed");
        expect(saved.graph.nodes.some((node: any) => node.kind === "candidate" && typeof node.score === "number" && node.insight?.trim())).toBeTruthy();
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
    }
  });
});
