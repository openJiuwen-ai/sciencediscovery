// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { allowRealEnvException, requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { artifactTree, cleanupJourney, createProjectAndSession, openProjectSession,
  readRunActivity, sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { drbQuestion, drbPrompt, drbOutput, drbArticle, drbApi, positiveNumber,
  evaluationConfig, evaluationPreflight, evaluateReport } from "./helpers/deepresearchbench.ts";

/**
 * E2E-META
 * Purpose: Research DRB-59 autonomously on Swarm, verify durable UI delivery, and evaluate report quality with RACE/FACT.
 * Steps:
 *   1. Validate evaluator prerequisites, create an always-allow Session and submit the original question with delivery instructions.
 *   2. Check terminal completion, research activity, report content and persistence after reload; record child failures without constraining strategy.
 *   3. Run pinned RACE/FACT, enforce configurable quality gates and export scorecard/performance artifacts.
 * Environment: Opt-in isolated real E2E stack; pinned upstream evaluator and outbound source access.
 * Type: real
 * LLM: Live generator plus independently configurable cleaner/RACE/FACT judges.
 * WebSearch: Live configured web providers; no test-imposed search count.
 * PaperSources: Live sources selected by the Agent.
 * MCP: ScienceDiscovery tools hosted through the JiuwenSwarm MCP adapter.
 * OtherExternal: Jina Reader, Judge endpoint, local API, Runner, browser and Artifact store.
 * Credentials: E2E_API_TOKEN; E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN; Judge credentials and JINA_API_KEY.
 * CostSideEffects: Billable research and Judge calls; temporary application records deleted, local evaluation artifacts retained.
 */
test("DRB-59 Swarm research integration", { tag: "@real" }, async ({ journey, page }, testInfo) => {
  const runBudget = positiveNumber("E2E_DRB_RUN_TIMEOUT_MS", 3_600_000);
  const judgeBudget = positiveNumber("E2E_DRB_EVAL_TIMEOUT_MS", 3_600_000);
  test.setTimeout(runBudget + judgeBudget + 240_000);
  testInfo.skip(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires isolated Swarm stack (E2E_SWARM_TASK=1)");
  journey.scenario({ goal: "Research DRB-59 and evaluate both delivery and report quality.",
    preconditions: ["live generator", "isolated Swarm stack", "configured judges and source access"] });
  const metrics: Record<string, any> = {
    schema_version: 1, case_id: 59, backend: "jiuwenswarm", started_at: new Date().toISOString(),
    prompt: drbPrompt, run_budget_ms: runBudget, evaluation_budget_ms: judgeBudget,
    integration_status: "not_run", evaluation: { status: "not_run" },
    children: [], generation_usage: null,
  };
  let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
  let runId: string | undefined;
  let terminal: string | undefined;
  let started: number | undefined;
  try {
    const config = evaluationConfig();
    metrics.evaluation_mode = config.mode;
    await evaluationPreflight(config); // Fail before spending generator tokens when credentials are missing.
    const existingModelId = process.env.E2E_LLM_MODEL_ID?.trim();
    if (existingModelId) allowRealEnvException(testInfo, "Explicit live model already registered on isolated stack; credentials stay server-side.");
    const real = existingModelId ? undefined : requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    await requireRealStack(testInfo);
    fixture = await createProjectAndSession(page, {
      approvalMode: "always_allow",
      ...(existingModelId ? { modelId: existingModelId } : { model: { apiToken: real!.E2E_LLM_TOKEN,
        baseUrl: real!.E2E_LLM_BASE_URL, model: real!.E2E_LLM_MODEL, name: `DRB-59 ${Date.now()}` } }),
      projectName: `DRB-59 Swarm ${Date.now()}`, sessionTitle: "DRB-59 autonomous research",
    });
    metrics.generator_model_id = fixture.session.modelId ?? existingModelId;
    const models = await drbApi<Array<{ id: string; model: string }>>(page, "/api/models");
    metrics.generator_model = models.find(m => m.id === metrics.generator_model_id)?.model ?? real?.E2E_LLM_MODEL ?? null;
    await openProjectSession(page, fixture);
    started = Date.now();
    const run = await sendUserMessage(page, fixture.session.id, drbPrompt);
    runId = run.id;
    metrics.run_id = runId;
    const finished = await waitForRunTerminal(page, fixture.session.id, runId, runBudget);
    terminal = finished.status;
    metrics.run_status = terminal;
    metrics.generation_duration_ms = Date.now() - started;
    expect(terminal, finished.error ?? "run did not complete").toBe("completed");
    const children = await drbApi<Array<{ id: string; status: string; turnCount?: number; steps?: Array<{ toolName?: string; status?: string }> }>>(
      page, `/api/sessions/${fixture.session.id}/subagents`);
    metrics.children = children.map(c => ({ id: c.id, status: c.status, turns: c.turnCount }));
    // Recovered failures are reliability metrics, not an arbitrary strategy failure.
    expect(children.filter(c => ["running", "queued", "pending", "waiting"].includes(c.status))).toHaveLength(0);
    const activity = await readRunActivity(page, { expandTools: true });
    const research = /search|fetch|pubmed|europe.?pmc|arxiv|biorxiv|medrxiv/i;
    expect(activity.tools.some(t => research.test(t.summary + "\n" + t.details)) ||
      children.some(c => c.steps?.some(s => s.status === "completed" && research.test(s.toolName ?? "")))).toBe(true);
    const tree = await artifactTree(page);
    await expect.poll(() => tree.artifacts.allTextContents()).toContain(drbOutput);
    await tree.catalog.getByRole("button", { name: `Open ${drbOutput}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Artifact: ${drbOutput}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".artifact-version-preview")).not.toHaveText("");
    const report = await drbArticle(page, fixture.session.id);
    const input = testInfo.outputPath("deepresearchbench-59.json");
    await writeFile(input, JSON.stringify({ id: 59, prompt: drbQuestion, article: report.article }, null, 2));
    await testInfo.attach("benchmark-report", { path: input, contentType: "application/json" });
    metrics.report_version_id = report.versionId;
    metrics.report_words = report.article.trim().split(/\s+/u).length;
    expect(metrics.report_words).toBeGreaterThanOrEqual(600);
    expect((report.article.match(/^#{1,3}\s+.+$/gm) ?? []).length).toBeGreaterThanOrEqual(3);
    // Syntax-only sanity check, not a claim that these URLs resolve or support the prose.
    expect(new Set(report.article.match(/https?:\/\/[^\s)\]}>,]+/gi) ?? []).size).toBeGreaterThanOrEqual(3);
    await page.reload();
    await openProjectSession(page, fixture);
    const restored = await artifactTree(page);
    await expect.poll(() => restored.artifacts.allTextContents()).toContain(drbOutput);
    expect(await drbArticle(page, fixture.session.id)).toEqual(report);
    const answer = (await page.locator(".message.assistant").last().innerText()).trim();
    expect(answer.length).toBeGreaterThan(80);
    expect(answer).toContain(drbOutput);
    metrics.integration_status = "passed";
    metrics.evaluation = await evaluateReport(config, input, testInfo.outputPath("evaluation"), judgeBudget);
    metrics.quality_status = metrics.evaluation.status;
    if (config.mode !== "off") {
      await testInfo.attach("quality-scorecard", { contentType: "application/json",
        body: JSON.stringify(metrics.evaluation, null, 2) });
      expect(metrics.evaluation.status).toBe(config.mode === "full" ? "passed" : "partial");
    }
  } catch (error) {
    if (metrics.integration_status !== "passed") metrics.integration_status = "failed";
    throw error;
  } finally {
    if (fixture) {
      if (runId && !terminal) {
        await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/${runId}/cancel`,
          { headers: authorizationHeader() }).catch(() => undefined);
        await waitForRunTerminal(page, fixture.session.id, runId, 30_000).catch(() => undefined);
      }
      metrics.generation_usage = await drbApi(page, `/api/sessions/${fixture.session.id}/usage`).catch(() => null);
      metrics.generation_duration_ms ??= started ? Date.now() - started : null;
      // Capture reliability metrics on early assertion failures too.
      if (!metrics.children.length) metrics.children = await drbApi<Array<{ id: string; status: string }>>(
        page, `/api/sessions/${fixture.session.id}/subagents`).then(cs => cs.map(c => ({ id: c.id, status: c.status }))).catch(() => []);
    }
    metrics.finished_at = new Date().toISOString();
    const path = testInfo.outputPath("benchmark-metrics.json");
    await writeFile(path, JSON.stringify(metrics, null, 2));
    await testInfo.attach("benchmark-metrics", { path, contentType: "application/json" });
    if (fixture) await cleanupJourney(page, fixture);
  }
});
