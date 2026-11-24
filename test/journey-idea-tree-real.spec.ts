import { expect } from "@playwright/test";
import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";

test.describe("Idea Tree real research", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l4", "@sandbox:bubblewrap"] }, () => {
  test.use({ locale: "zh-CN" });

  /**
   * E2E-META
   * Purpose: Complete a small autonomous Idea Tree research using a real model and retrieve its persisted results through the public API.
   * Steps:
   *   1. Configure quick water-treatment research on the Session and start it from the composer.
   *   2. Wait for a terminal status, then inspect a scored candidate and its insight.
   *   3. Reload the session and confirm the API still returns that same completed research.
   * Environment: Isolated API/web, Runner and evolve services.
   * Type: real
   * LLM: Live OpenAI-compatible provider configured by E2E_LLM_BASE_URL and E2E_LLM_MODEL.
   * WebSearch: none requested
   * PaperSources: none requested
   * MCP: none requested
   * OtherExternal: configured live LLM endpoint.
   * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
   * CostSideEffects: Billable model calls that do not pass through the metered proxy; temporary project and model are deleted.
   */
  test("real Idea Tree research completes and its result survives a reload", { tag: "@real" }, async ({ page, journey }, testInfo) => {
    // Budget, measured rather than guessed. On an isolated Linux stack with a
    // live model, the same prompt produced the research in 72s and completed it
    // at 512s (≈440s from appearance to completion; 4 candidates, 4 assessments
    // and 2 rounds for 271,367 tokens). The waits below are sized from that:
    // 180s card + 180s new research + 720s terminal poll = 1080s, inside a
    // 1500s case budget, leaving ~420s for the composer command, the reload,
    // the second read and cleanup. The terminal poll stays below the case
    // budget so a slow research fails as "status never settled" instead of
    // being killed mid-cleanup, and 720s keeps ~60% headroom over the measured
    // 440s rather than the 9% headroom a 480s cap gave.
    test.setTimeout(1_500_000);
    journey.scenario({ goal: "Explore a small materials research question and retrieve the result after reload", preconditions: ["Isolated stack and live model credentials"] });
    const real = requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    await requireRealStack(testInfo);
    const headers = authorizationHeader();
    // The engine settles a research in one of these states; only `completed`
    // can grow a scored candidate, so the poll must stop on any of them instead
    // of waiting out its whole budget on a run that will never finish.
    const terminalStatuses = ["completed", "interrupted", "paused", "ended", "budget_exhausted"];
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let researchId = "";
    const read = async () => {
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`, { headers, timeout: 10_000, maxRetries: 2 });
      expect(response.ok()).toBe(true);
      return (await response.json()).items;
    };
    const researchById = async () => (await read()).find((entry: any) => entry.research.id === researchId);
    try {
      await journey.step("Start a small research", "Quick research starts from the session", async () => {
        fixture = await createProjectAndSession(page, { model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `Idea Tree real ${Date.now()}` }, projectName: `Idea Tree real ${Date.now()}`, sessionTitle: "Catalyst research" });
        // Session scope, not the deployment: the override dies with this Session
        // and no restore step can be skipped by a killed worker.
        const settings = await page.request.patch(`${apiBaseUrl()}/api/sessions/${fixture.session.id}`, { headers, data: { ideaTreeOverride: { templateId: "water-treatment-materials/v1", explorationIntensity: "quick" } } });
        expect(settings.ok()).toBe(true);
        const existingIds = new Set((await read()).map((entry: any) => entry.research.id));
        await openProjectSession(page, fixture);
        await page.locator("form.composer").getByRole("textbox").fill("/idea-tree Skip literature retrieval. Explore low-cost iron catalysts for near-neutral water treatment, considering recovery and leaching.");
        await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
        // Ask the API first: whether the command started a research is a fact
        // about the product, and whether the card draws it is a fact about the
        // interface. Waiting for the card first — as this journey used to — made
        // the two indistinguishable: a research that was created but whose card
        // never appeared looked exactly like a command that started nothing.
        // 180s covers a cold first call, which took 72s in the measurement above
        // but missed a 120s window once on a slow start.
        await expect.poll(async () => (await read()).filter((entry: any) => !existingIds.has(entry.research.id)).length, { timeout: 180_000, message: "the command should start exactly one new research" }).toBe(1);
        researchId = (await read()).find((entry: any) => !existingIds.has(entry.research.id)).research.id;
        // Now the card. The interface re-reads the list on its own while it holds
        // nothing, so this is short: a card that misses a created event no longer
        // has to wait for a reload.
        await expect(page.getByRole("region", { name: "Idea Tree 研究控制" })).toBeVisible({ timeout: 60_000 });
      });
      await journey.step("Inspect completed research", "A terminal status is reached and at least one candidate has a score and insight", async () => {
        // Read the last view each poll: a timeout has to say what the research
        // was doing, or a stalled engine and a lost record look the same.
        let last: any;
        try {
          await expect.poll(async () => {
            last = await researchById();
            const status = last?.research.status;
            return terminalStatuses.includes(status) ? status : null;
          }, { timeout: 720_000, message: "the research should settle in a terminal status" }).not.toBeNull();
        } catch (failure) {
          const seen = last?.research;
          throw new Error(`research ${researchId} never settled: status=${seen?.status ?? "absent from the list"} phase=${seen?.phase ?? "?"} round=${seen?.round ?? "?"} reason=${seen?.reason ?? "none"}`, { cause: failure });
        }
        const { graph, research } = (await researchById())!;
        // A real model can stop short of `completed`; name the persisted reason
        // so a provider or JSON-parse failure is not reported as a value mismatch.
        expect(research.status, `research settled as "${research.status}"${research.reason ? `: ${research.reason}` : ""}`).toBe("completed");
        expect(research.settings).toMatchObject({ templateId: "water-treatment-materials/v1", explorationIntensity: "quick" });
        const candidates = graph.nodes.filter((node: any) => node.kind === "candidate");
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.some((node: any) => typeof node.score === "number" && typeof node.insight === "string" && node.insight.trim().length > 0)).toBe(true);
      });
      await journey.step("Reload the session", "The API still returns the same completed research after a reload", async () => {
        await page.reload();
        await expect(page.getByRole("region", { name: "Idea Tree 研究控制" })).toBeVisible();
        const saved = await researchById();
        expect(saved?.research.status).toBe("completed");
        expect(saved.graph.nodes.some((node: any) => node.kind === "candidate" && typeof node.score === "number" && node.insight?.trim())).toBeTruthy();
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
    }
  });
});
