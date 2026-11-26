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
    // Budgets measured on this stack with the live model (2026-11-25). One model
    // call took 45-130s; the research appeared 77s after the command in one run
    // and 403s in the next; a research that did settle took 12+ minutes of engine
    // work. A single wall-clock cap sized from a fast sample turns that variance
    // into red cases, which is why this case used to fail repeatedly.
    // The waits are therefore bounded by progress, not only by the clock:
    //   - creating: up to 600s, but a run that ends `failed`/`blocked`/`cancelled`
    //     fails at once with its own reason instead of waiting out the budget;
    //   - settling: up to 1800s, but 900s without a single new token, round,
    //     activity or node fails as "stopped progressing".
    // A slow provider no longer reds the case; an engine that really stalls still
    // does, and says what it was doing when it stopped.
    const CREATE_BUDGET_MS = 600_000;
    const TERMINAL_BUDGET_MS = 1_800_000;
    // The same allowance the real shard runs under, not a guess:
    // `.github/workflows/real-e2e.yml:122-123` sets
    // SCIENCE_AGENT_GATEWAY_IDLE_TIMEOUT_MS to 900000 — "Allow long research
    // turns to go up to fifteen minutes without progress". A single provider
    // call does not advance any of the progress counters, so a threshold below
    // that allowance would report the same provider latency this change exists
    // to stop reporting.
    const STALL_MS = 900_000;
    test.setTimeout(3_000_000);
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
        // `always_allow` is load-bearing, not convenience: the agent's preparation
        // can reach a tool that raises an approval card, and nothing in a headless
        // journey answers one. Measured on a live stack, the run went `running`
        // then `blocked` after 40s and never created a research at all, so the
        // case failed on a card no one could press. Every other real journey on
        // this stack asks for the same mode for the same reason.
        fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `Idea Tree real ${Date.now()}` }, projectName: `Idea Tree real ${Date.now()}`, sessionTitle: "Catalyst research" });
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
        const latestRun = async () => {
          const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs`, { headers, timeout: 10_000, maxRetries: 2 });
          const body = await response.json();
          return Array.isArray(body) ? body[0] : undefined;
        };
        let run: any;
        try {
          await expect.poll(async () => {
            const started = (await read()).filter((entry: any) => !existingIds.has(entry.research.id));
            if (started.length > 0) return started.length;
            run = await latestRun();
            // A run that already ended without a research will not start one
            // afterwards: waiting out the budget would only hide its reason.
            if (run && ["failed", "cancelled", "blocked"].includes(run.status)) {
              throw new Error(`run ${run.id} ended as "${run.status}"${run.reason ? `: ${run.reason}` : run.error ? `: ${run.error}` : ""} without starting a research`);
            }
            return 0;
          }, { timeout: CREATE_BUDGET_MS, message: "the command should start exactly one new research" }).toBe(1);
        } catch (failure) {
          // Say what the run was doing: a research that never appeared is either a
          // stalled/failed run or a slow one, and the two need different fixes.
          throw new Error(`no research was created in ${CREATE_BUDGET_MS / 1000}s: run=${run?.id ?? "none"} status=${run?.status ?? "?"} error=${run?.error ?? "none"} reason=${run?.reason ?? "none"}`, { cause: failure });
        }
        researchId = (await read()).find((entry: any) => !existingIds.has(entry.research.id)).research.id;
        // Now the card. The interface re-reads the list on its own while it holds
        // nothing, so this is short: a card that misses a created event no longer
        // has to wait for a reload.
        await expect(page.getByRole("region", { name: /^(Idea Tree research controls|研究思路树控制)$/ })).toBeVisible({ timeout: 60_000 });
      });
      await journey.step("Inspect completed research", "A terminal status is reached and at least one candidate has a score and insight", async () => {
        // Read the last view each poll: a timeout has to say what the research
        // was doing, or a stalled engine and a lost record look the same.
        let last: any;
        let mark = "";
        let movedAt = Date.now();
        const progressOf = (view: any) => {
          const seen = view?.research;
          if (!seen) return "absent";
          return [seen.status, seen.phase, seen.round, seen.batchCompleted, seen.tokens, (seen.activities ?? []).length, (view.graph?.nodes ?? []).length].join("|");
        };
        try {
          await expect.poll(async () => {
            last = await researchById();
            const seen = last?.research;
            if (seen && terminalStatuses.includes(seen.status)) return seen.status;
            const now = progressOf(last);
            if (now !== mark) { mark = now; movedAt = Date.now(); }
            // A live model is slow but it does move: tokens, rounds, activities
            // and nodes all advance as a research runs. Nothing changing for this
            // long is a stall, not latency, so fail with the state instead of
            // waiting out a budget that a slow run legitimately needs.
            if (Date.now() - movedAt > STALL_MS) {
              throw new Error(`research ${researchId} stopped progressing: status=${seen?.status ?? "absent from the list"} phase=${seen?.phase ?? "?"} round=${seen?.round ?? "?"} tokens=${seen?.tokens ?? "?"} for ${Math.round((Date.now() - movedAt) / 1000)}s`);
            }
            return null;
          }, { timeout: TERMINAL_BUDGET_MS, message: "the research should settle in a terminal status" }).not.toBeNull();
        } catch (failure) {
          const seen = last?.research;
          throw new Error(`research ${researchId} never settled: status=${seen?.status ?? "absent from the list"} phase=${seen?.phase ?? "?"} round=${seen?.round ?? "?"} tokens=${seen?.tokens ?? "?"} reason=${seen?.reason ?? "none"}`, { cause: failure });
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
        await expect(page.getByRole("region", { name: /^(Idea Tree research controls|研究思路树控制)$/ })).toBeVisible();
        const saved = await researchById();
        expect(saved?.research.status).toBe("completed");
        expect(saved.graph.nodes.some((node: any) => node.kind === "candidate" && typeof node.score === "number" && node.insight?.trim())).toBeTruthy();
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
    }
  });
});
