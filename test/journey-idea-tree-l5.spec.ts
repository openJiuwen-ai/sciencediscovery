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
const terminalStatuses = ["completed", "interrupted", "paused", "ended", "budget_exhausted"];

// `standard` is three rounds of three candidates with three independent
// assessors, so the waits are ordered under the 7200s case budget instead of
// summing past it: 3 x 600s to create + (120s running + 480s paused + 300s
// resumed) + 4200s terminal = 6900s. That is the sum of the stage caps, not a
// bound on the case: `openSession()` alone can spend about 340s per attempt, so
// the real limit is the 7200s case timeout and the caps above only decide how
// long each wait may take before it gives up by name.
//
// 600s to create is measured, not guessed, and raising it was measured too. The
// agent sometimes explores the workspace and the skill directories instead of
// calling `create_idea_research`: a 600s budget cut two runs off mid-preparation
// (142K and 179K input tokens), and a 1200s budget let one run go 50 turns and
// 1.9M tokens without ever calling the tool. A longer wait therefore buys nothing
// and costs ten times the tokens, so the budget stays at 600s; a run that never
// calls the tool still fails, and the settled-run branch reports it with status
// and cards rather than waiting out the case.
const startAttempts = 3;
const createBudget = 600_000;
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
    const startedSessions: Array<Awaited<ReturnType<typeof createProjectAndSession>>> = [];
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
    // Session in 0.68-0.93 s on five out of five fresh Projects.
    //
    // Two details make the click path dependable, both measured. The Session rows are
    // filled after the Project selection request returns, so the row is awaited before
    // it is clicked rather than assumed present — after a reload that panel did not
    // render within 30s once. And the whole open is attempted twice, because a single
    // miss there used to fail a case whose research had already completed; a Session
    // that cannot be opened still fails, now by name.
    const openSession = async () => {
      const heading = page.getByRole("heading", { name: fixture!.session.title });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // A reload can restore the Session by itself; when it did, the clicks below
        // would only navigate away from it.
        if (await heading.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) return;
        await page.goto("/");
        const project = page.locator("#projects-panel-content button.nav-item").filter({ hasText: fixture!.project.name });
        await project.first().click({ timeout: 30_000 });
        // `#sessions-panel-content` and its toggle are rendered by the same
        // `sessionsExpanded` flag, so visibility of the panel cannot tell "collapsed"
        // from "not mounted yet" — clicking on that guess would collapse a panel that
        // had just appeared. The toggle carries `aria-expanded`
        // (`ManagementControls.tsx:100`), so read its state instead of inferring.
        const sessionsToggle = page.getByRole("button", { name: /^(会话|Sessions)$/ }).first();
        if ((await sessionsToggle.getAttribute("aria-expanded").catch(() => null)) === "false") {
          await sessionsToggle.click({ timeout: 15_000 });
        }
        await expect(page.locator("#sessions-panel-content")).toBeVisible({ timeout: 15_000 });
        const session = page.locator("#sessions-panel-content button.nav-item").filter({ hasText: fixture!.session.title });
        const listed = await session.first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
        if (!listed) {
          console.warn(`[l5-open] session row not listed after selecting the Project (attempt ${attempt}/2)`);
          continue;
        }
        await session.first().click({ timeout: 30_000 });
        const tour = page.getByRole("button", { name: /^(跳过|Skip)$/ });
        if (await tour.isVisible().catch(() => false)) await tour.click();
        // `isVisible({ timeout })` does not wait — the option is deprecated and
        // ignored — so the heading is awaited properly here and once more at the end.
        if (await heading.waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false)) return;
        console.warn(`[l5-open] session heading not visible after the click (attempt ${attempt}/2)`);
      }
      await expect(heading).toBeVisible({ timeout: 30_000 });
    };
    try {
      await journey.step("Start research", "A research record appears for the chosen objective", async () => {
        // The Session title carries the timestamp as well: `openSession()` returns as
        // soon as a heading with `fixture.session.title` is visible, so a second
        // attempt that reused the same title would match the Session left by the
        // first one, skip the navigation and then drive the wrong Session while the
        // poll reads the new one. A unique title makes the heading check unambiguous.
        // The agent starts the research from the composer only about half the time,
        // and the failure is behavioural: it reads skill files instead of calling
        // `create_idea_research` (#1311). Each attempt therefore gets its own Project
        // and Session so a stuck run cannot leak into the next one, and the command is
        // re-sent up to `startAttempts` times before this step reports a failure.
        // Whole-case retries would be simpler, but four attempts at ~105 minutes do
        // not fit the 240-minute research-worker ceiling. Three create attempts plus
        // the terminal wait come to 6900s inside the 7200s case budget, so the
        // terminal cap can still be reached before the test is killed and the third
        // miss still fails honestly. Assertions after this step are never retried.
        let lastError: unknown;
        for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
          // A three-round standard research prepares inputs with governed tools, and
          // the default approval mode parks the run as `blocked` on the first one
          // with nobody to answer the card — measured: two runs sat blocked for
          // ~10 min without ever creating a research. Approval surfaces have their
          // own journeys (`journey-governed-download-approval`,
          // `journey-sandbox-network-consent`); this case exists to check research
          // results, so the Session allows the tools it needs.
          fixture = await createProjectAndSession(page, { approvalMode: "always_allow", model: { apiToken: real.E2E_LLM_TOKEN, baseUrl: real.E2E_LLM_BASE_URL, model: real.E2E_LLM_MODEL, name: `L5 Idea Tree ${scenario.id} ${Date.now()}` }, projectName: `L5 Idea Tree ${scenario.id} ${Date.now()}`, sessionTitle: `${scenario.title} ${Date.now()}` });
          startedSessions.push(fixture);
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
          try {
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
            if (attempt > 1) console.warn(`[l5-start] created on attempt ${attempt}/${startAttempts}`);
            return;
          } catch (error) {
            lastError = error;
            if (attempt === startAttempts) break;
            console.warn(`[l5-start] attempt ${attempt}/${startAttempts} did not create a research: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
        }, { timeout: terminalBudget, message: "the research should settle in a terminal status" }).toMatch(/^(completed|interrupted|paused|ended|budget_exhausted)$/);
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
      for (const started of startedSessions) {
        // A failed cleanup leaves a Project, its Session and a research on the shared
        // stack. It must not fail a case that otherwise passed, but it must not be
        // invisible either: the delete is the only thing that removes them.
        await cleanupJourney(page, started).catch((error) => console.warn(`[l5-cleanup] could not remove ${started.project.name}: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  });
}
