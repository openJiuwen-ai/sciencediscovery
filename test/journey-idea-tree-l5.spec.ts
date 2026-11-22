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

// The engine settles a research in one of these states. Only `completed` grows
// a scored candidate, so every wait below stops on any of them and then names
// the persisted reason: a run that failed a model call must not be reported as
// a value mismatch after burning its whole poll budget.
const terminalStatuses = ["completed", "interrupted", "paused", "ended"];

// `standard` is three rounds of three candidates with three independent
// assessors, so the waits are ordered under the 7200s case budget instead of
// summing past it: 600s to create + (120s running + 480s paused + 300s resumed)
// + 4800s terminal = 6300s, leaving ~900s for the composer command, the reload
// and cleanup. Every cap below is below the case timeout, so a slow research
// fails as "status never settled" rather than being killed inside cleanup.
//
// 600s to create is measured, not guessed: on this head a run of the recovery
// prompt spent more than 300s preparing its inputs — the agent was still on
// turn 5, one turn carrying 142K input tokens — before it could call
// `create_idea_research`, while a second run of the same prompt completed the
// whole research in 23.4m. The step also stops waiting the moment the run
// settles without a research, so a run that will never create one fails at that
// point instead of burning the budget.
const createBudget = 600_000;
const runningBudget = 120_000;
const pausedBudget = 480_000;
const resumedBudget = 300_000;
const terminalBudget = 4_800_000;

// A session run reports one of these once it can no longer produce a research.
const settledRunStatuses = ["blocked", "cancelled", "completed", "failed", "interrupted"];

for (const scenario of cases) {
  /**
   * E2E-META
   * Purpose: Verify real-model multi-round Idea Tree results and recovery through a user session.
   * Steps:
   *   1. Configure standard exploration on the Session, create it and start research from the composer.
   *   2. For the recovery case, pause an in-progress research and continue it manually.
   *   3. Inspect completed candidates, independent assessments and propagated root insight; reload and retrieve persisted results.
   * Environment: Isolated API/web, Runner and evolve services on Linux.
   * Type: real
   * LLM: Live OpenAI-compatible provider configured by E2E_LLM_BASE_URL and E2E_LLM_MODEL.
   * WebSearch: none requested
   * PaperSources: none requested
   * MCP: none requested
   * OtherExternal: configured live LLM endpoint.
   * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL, E2E_LLM_MODEL, E2E_LLM_TOKEN.
   * CostSideEffects: Billable model calls for a three-round standard research; the override is session-scoped and the temporary project and model are deleted.
   */
  test(`L5 Idea Tree: ${scenario.title}`, { tag: ["@real", "@isolation:session", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l5", "@sandbox:bubblewrap"] }, async ({ page, journey }, info) => {
    test.setTimeout(7_200_000);
    journey.scenario({ goal: scenario.title, preconditions: ["Isolated stack with evolve", "Real model credentials", "Standard exploration: up to three rounds"] });
    const real = requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    await requireRealStack(info);
    const headers = authorizationHeader();
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let researchId = "";
    const researchUrl = () => `${apiBaseUrl()}/api/sessions/${fixture!.session.id}/idea-tree/research`;
    const read = async () => {
      const response = await page.request.get(researchUrl(), { headers, timeout: 15_000, maxRetries: 2 });
      expect(response.ok()).toBe(true);
      return (await response.json()).items;
    };
    const researchById = async () => (await read()).find((item: any) => item.research.id === researchId);
    const status = async () => (await researchById())?.research.status;
    const readRuns = async () => {
      const response = await page.request.get(`${apiBaseUrl()}/api/sessions/${fixture!.session.id}/runs`, { headers, timeout: 15_000, maxRetries: 2 });
      expect(response.ok()).toBe(true);
      return (await response.json()) as Array<{ id: string; status: string; error?: string }>;
    };
    try {
      await journey.step("Start research", "A research record appears for the chosen objective", async () => {
        fixture = await createProjectAndSession(page, { model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `L5 Idea Tree ${scenario.id} ${Date.now()}` }, projectName: `L5 Idea Tree ${scenario.id} ${Date.now()}`, sessionTitle: scenario.title });
        // Session scope, not the deployment: the override dies with this Session,
        // so no restore step can be skipped by a killed worker and a shared stack
        // keeps its own Idea Tree settings.
        const override = await page.request.patch(`${apiBaseUrl()}/api/sessions/${fixture.session.id}`, { headers, data: { ideaTreeOverride: { templateId: scenario.template, explorationIntensity: "standard" } } });
        expect(override.ok()).toBe(true);
        const existingIds = new Set((await read()).map((item: any) => item.research.id));
        await openProjectSession(page, fixture);
        await page.locator("form.composer").getByRole("textbox").fill(`/idea-tree ${scenario.prompt}`);
        await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
        // Identify this run by the id that was not there before the command was
        // sent: the list is shared by every research in the Session. A run that
        // settles without creating one cannot recover, so it fails here with its
        // own status instead of waiting out the creation budget.
        await expect.poll(async () => {
          if ((await read()).some((item: any) => !existingIds.has(item.research.id))) return "created";
          const runs = await readRuns();
          const newest = runs[runs.length - 1];
          return newest && settledRunStatuses.includes(newest.status) ? `settled:${newest.status}` : "waiting";
        }, { timeout: createBudget, message: "the /idea-tree command should create one research before its run settles" }).toBe("created");
        researchId = (await read()).find((item: any) => !existingIds.has(item.research.id)).research.id;
      });
      if (scenario.pause) {
        await journey.step("Pause and resume", "Research reaches paused state and can continue without losing its identity", async () => {
          const endpoint = researchUrl();
          // The pause is only meaningful while the engine is running; sending it
          // blind would either race a research that just completed or wait out the
          // whole paused budget on a run that can no longer pause.
          await expect.poll(status, { timeout: runningBudget, message: "the research should be running before it is paused" }).toBe("running");
          const pause = await page.request.post(endpoint, { headers, data: { operation: "pause", researchId } });
          expect(pause.ok()).toBe(true);
          await expect.poll(status, { timeout: pausedBudget, message: "the pause operation should settle the research as paused" }).toBe("paused");
          const resume = await page.request.post(endpoint, { headers, data: { operation: "continue", researchId } });
          expect(resume.ok()).toBe(true);
          await expect.poll(async () => (await status()) === "paused" ? "paused" : "resumed", { timeout: resumedBudget, message: "the continued research should leave the paused state" }).toBe("resumed");
        });
      }
      await journey.step("Inspect completed research", "Multiple rounds complete with scored candidates, assessments and root insight", async () => {
        await expect.poll(async () => {
          const current = await status();
          return terminalStatuses.includes(current) ? current : null;
        }, { timeout: terminalBudget, message: "the research should settle in a terminal status" }).not.toBeNull();
        const { research, graph } = (await researchById())!;
        expect(research.status, `research settled as "${research.status}"${research.reason ? `: ${research.reason}` : ""}`).toBe("completed");
        expect(research.settings).toMatchObject({ templateId: scenario.template, explorationIntensity: "standard" });
        expect(research.round).toBeGreaterThanOrEqual(2);
        const candidates = graph.nodes.filter((node: any) => node.kind === "candidate" && node.status === "done");
        expect(candidates.length).toBeGreaterThan(0);
        const assessors = scenario.id === "iteration" ? ["activity", "stability", "sustainability"] : ["scientificValidity", "evidenceReadiness", "feasibility"];
        for (const candidate of candidates) {
          expect(typeof candidate.score).toBe("number");
          expect(candidate.insight?.trim()).toBeTruthy();
          for (const role of assessors) expect(typeof candidate.stages?.[role]?.score, `candidate ${candidate.id} should carry the ${role} assessment`).toBe("number");
        }
        expect(graph.nodes.find((node: any) => node.id === "ROOT")?.insight?.trim()).toBeTruthy();
      });
      await journey.step("Reopen results", "The completed research and root insight remain available after reload", async () => {
        await page.reload();
        const saved = await researchById();
        expect(saved?.research.status).toBe("completed");
        expect(saved?.graph.nodes.find((node: any) => node.id === "ROOT")?.insight?.trim()).toBeTruthy();
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
    }
  });
}
