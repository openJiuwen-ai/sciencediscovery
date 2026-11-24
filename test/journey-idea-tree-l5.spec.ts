// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { expect } from "@playwright/test";
import type { IdeaResearchView } from "@sciencediscovery/schema";
import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { cleanupJourney, createProjectAndSession, type JourneyRun } from "./helpers/journeys.ts";
import { RunPollRecovery } from "./helpers/run-poll-recovery.ts";

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
// summing past it: 1200s to create + (120s running + 480s paused + 300s resumed)
// + 4200s terminal = 6300s, leaving ~900s for the composer command, the reload
// and cleanup. Every cap below is below the case timeout, so a slow research
// fails as "status never settled" rather than being killed inside cleanup.
//
// 1200s to create is measured, not guessed. The agent sometimes explores the
// workspace and the skill directories for several turns before it calls
// `create_idea_research`: two runs were cut off by a 600s budget while still
// preparing, one on turn 5 with 142K input tokens, another with 179K in / 9.7K
// out across six turns and no tool call. The same prompt has also created the
// research in 71s. Raising the budget does not weaken the assertion — a run that
// never calls the tool still fails, and the settled-run branch still reports it
// with its status and cards.
const createBudget = 1_200_000;
const runningBudget = 120_000;
const pausedBudget = 480_000;
const resumedBudget = 300_000;
const terminalBudget = 4_200_000;

// A run reports one of these when it can no longer produce a research on its
// own. `blocked` is deliberately absent: it is a wait for a person, and
// `runs/index.ts` resumes the same run once the card is decided, so treating it
// as terminal would fail a run that was about to continue.
const settledRunStatuses = ["cancelled", "completed", "failed", "interrupted"];

// `configuration_requests_v2` states that still wait for a person.
const pendingConfigurationStates = ["collecting_input", "awaiting_confirmation", "needs_fix", "validating", "applying", "failed"];

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
    const base = () => apiBaseUrl();
    const researchUrl = () => `${base()}/api/sessions/${fixture!.session.id}/idea-tree/research`;
    // Every read in this case goes through this helper, which retries three
    // transient failures before giving up: the waits below cover 20-30 minutes
    // of a paid run, so one 502 from a restarting evolve or API must not end it.
    // Writes (create, pause, continue) are never replayed.
    const recovery = new RunPollRecovery();
    const readJson = async (url: string) => {
      for (;;) {
        try {
          const response = await page.request.get(url, { headers, timeout: 15_000, maxRetries: 2 });
          if (!response.ok()) throw new Error(`GET ${url} -> ${response.status()}: ${(await response.text()).slice(0, 200)}`);
          recovery.succeeded();
          return await response.json();
        } catch (error) {
          // `failed` rethrows anything that is not a recognised transient
          // failure, and rethrows once the three-failure budget is spent.
          const failures = recovery.failed(error);
          console.warn(`[l5-read] transient failure ${failures}/3 for ${url}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    const read = async () => ((await readJson(researchUrl())) as { items: IdeaResearchView[] }).items;
    const researchById = async () => (await read()).find((item) => item.research.id === researchId);
    const status = async () => (await researchById())?.research.status ?? "";
    const readRuns = async () => (await readJson(`${base()}/api/sessions/${fixture!.session.id}/runs`)) as JourneyRun[];
    // A run waits for a person in two shapes: `permissions/index.ts` reports
    // "Waiting for permission decision" and `runs/index.ts` reports "Waiting for
    // configuration decision", both with run status `blocked`. Reading both
    // lists turns that into a named card instead of a bare status.
    const pendingCards = async () => {
      const permissions = (await readJson(`${base()}/api/permission-requests?sessionId=${fixture!.session.id}`)) as Array<{ state: string; summary?: string }>;
      const configurations = ((await readJson(`${base()}/api/sessions/${fixture!.session.id}/configuration-requests`)).items ?? []) as Array<{ capabilityId?: string; state?: string }>;
      const open = permissions.filter((item) => item.state === "pending");
      const waitingConfigurations = configurations.filter((item) => pendingConfigurationStates.includes(item.state ?? ""));
      return [
        open.length ? `permission requests: ${open.map((item) => item.summary ?? "pending").join(" | ")}` : "",
        waitingConfigurations.length ? `configuration requests: ${waitingConfigurations.map((item) => `${item.capabilityId ?? "?"}:${item.state ?? "?"}`).join(", ")}` : "",
      ].filter(Boolean).join("; ");
    };
    // Open the Session the way a user does: click the Project row, then the Session
    // row. The URL deep link is available and is how a reload restores a Session, but
    // on this shared stack it is not deterministic — measured, it left the app on its
    // start-up shell (Project count rendered, no Session selected) six times in one
    // campaign and three times in the next, while the same two clicks opened the
    // Session in 0.68-0.93 s on five out of five fresh Projects. Each click carries an
    // explicit timeout, so a row that never renders fails this step by name instead of
    // waiting out the case budget the way the old helper did.
    const openSession = async () => {
      await page.goto("/");
      const project = page.locator("#projects-panel-content button.nav-item").filter({ hasText: fixture!.project.name });
      await project.first().click({ timeout: 30_000 });
      const session = page.locator("#sessions-panel-content button.nav-item").filter({ hasText: fixture!.session.title });
      await session.first().click({ timeout: 30_000 });
      const tour = page.getByRole("button", { name: /^(跳过|Skip)$/ });
      if (await tour.isVisible().catch(() => false)) await tour.click();
      await expect(page.getByRole("heading", { name: fixture!.session.title })).toBeVisible({ timeout: 30_000 });
    };
    try {
      await journey.step("Start research", "A research record appears for the chosen objective", async () => {
        // A three-round standard research prepares inputs with governed tools, and
        // the default approval mode parks the run as `blocked` on the first one
        // with nobody to answer the card — measured: two runs sat blocked for
        // ~10 min without ever creating a research. Approval surfaces have their
        // own journeys (`journey-governed-download-approval`,
        // `journey-sandbox-network-consent`); this case exists to check research
        // results, so the Session allows the tools it needs.
        fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `L5 Idea Tree ${scenario.id} ${Date.now()}` }, projectName: `L5 Idea Tree ${scenario.id} ${Date.now()}`, sessionTitle: scenario.title });
        // Session scope, not the deployment: the override dies with this Session,
        // so no restore step can be skipped by a killed worker and a shared stack
        // keeps its own Idea Tree settings.
        const override = await page.request.patch(`${base()}/api/sessions/${fixture.session.id}`, { headers, data: { ideaTreeOverride: { templateId: scenario.template, explorationIntensity: "standard" } } });
        expect(override.ok()).toBe(true);
        const existingIds = new Set((await read()).map((item) => item.research.id));
        await openSession();
        await page.locator("form.composer").getByRole("textbox").fill(`/idea-tree ${scenario.prompt}`);
        await page.getByRole("button", { name: /^(Run analysis|运行分析)$/ }).click();
        // Identify this run by the id that was not there before the command was
        // sent: the list is shared by every research in the Session. A run that
        // reports a terminal status without a research cannot recover, so it
        // fails here with that status — `expect.poll` retries any other value, so
        // the terminal case has to throw. `blocked` keeps waiting unless a card
        // actually needs a person.
        await expect.poll(async () => {
          if ((await read()).some((item) => !existingIds.has(item.research.id))) return "created";
          const runs = await readRuns();
          const newest = runs[runs.length - 1];
          if (!newest) return "waiting";
          if (newest.status === "blocked") {
            // No card yet means the engine is still preparing; a card means a
            // person has to act, and nobody will in a journey.
            const cards = await pendingCards().catch((error) => `cards unavailable: ${error instanceof Error ? error.message : String(error)}`);
            if (cards && !cards.startsWith("cards unavailable")) throw new Error(`the /idea-tree run is blocked on ${cards} and cannot continue until it is answered`);
            return "waiting";
          }
          if (settledRunStatuses.includes(newest.status)) {
            const cards = await pendingCards().catch((error) => `cards unavailable: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`the /idea-tree run settled as "${newest.status}"${newest.error ? `: ${newest.error}` : ""} without creating a research (${cards || "no pending card"})`);
          }
          return "waiting";
        }, { timeout: createBudget, message: "the /idea-tree command should create one research before its run settles" }).toBe("created");
        researchId = (await read()).find((item) => !existingIds.has(item.research.id))!.research.id;
      });
      if (scenario.pause) {
        await journey.step("Pause and resume", "Research reaches paused state and can continue without losing its identity", async () => {
          const endpoint = researchUrl();
          // The pause is only meaningful while the engine is running; sending it
          // blind would either race a research that just settled or wait out the
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
          return terminalStatuses.includes(current) ? current : "waiting";
        }, { timeout: terminalBudget, message: "the research should settle in a terminal status" }).toMatch(/^(completed|interrupted|paused|ended)$/);
        const stored = await researchById();
        expect(stored, `research ${researchId} should still be readable`).toBeDefined();
        const { research, graph } = stored!;
        expect(research.status, `research settled as "${research.status}"${research.reason ? `: ${research.reason}` : ""}`).toBe("completed");
        expect(research.settings).toMatchObject({ templateId: scenario.template, explorationIntensity: "standard" });
        expect(research.round).toBeGreaterThanOrEqual(2);
        const candidates = graph.nodes.filter((node) => node.kind === "candidate" && node.status === "done");
        expect(candidates.length).toBeGreaterThan(0);
        const assessors = scenario.id === "iteration" ? ["activity", "stability", "sustainability"] : ["scientificValidity", "evidenceReadiness", "feasibility"];
        for (const candidate of candidates) {
          expect(typeof candidate.score).toBe("number");
          expect(candidate.insight?.trim()).toBeTruthy();
          for (const role of assessors) expect(typeof candidate.stages?.[role]?.score, `candidate ${candidate.id} should carry the ${role} assessment`).toBe("number");
        }
        expect(graph.nodes.find((node) => node.id === "ROOT")?.insight?.trim()).toBeTruthy();
      });
      await journey.step("Reopen results", "The completed research and root insight remain available after reload", async () => {
        await page.reload();
        // A reload does not always land back on this Session: a first-visit tour can
        // mount over a fresh empty session (measured — the tour's first step was on
        // screen after the reload and the created Session was not selected). Close
        // the tour, then reopen the same Project/Session through the controls a user
        // uses, and only then make the claim this step exists for.
        const tour = page.getByRole("button", { name: /^(跳过|Skip)$/ });
        if (await tour.isVisible().catch(() => false)) await tour.click();
        const card = page.getByRole("region", { name: /Idea Tree/ });
        if (!(await card.isVisible().catch(() => false))) await openSession();
        // The API answering is not the same claim as the page still showing the
        // research: check the user-visible control region first, then the API.
        await expect(card).toBeVisible({ timeout: 60_000 });
        const saved = await researchById();
        expect(saved?.research.status).toBe("completed");
        expect(saved?.graph.nodes.find((node) => node.id === "ROOT")?.insight?.trim()).toBeTruthy();
      });
    } finally {
      if (fixture) await cleanupJourney(page, fixture);
    }
  });
}
