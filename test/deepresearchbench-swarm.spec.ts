// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").
import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { allowRealEnvException, requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession,
  sendUserMessage, waitForRunTerminal } from "./helpers/journeys.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { researchPrompt, drbArticle, drbApi, positiveNumber,
  evaluationConfig, evaluationPreflight, evaluateReport } from "./helpers/deepresearchbench.ts";
import { collectFinalDelivery } from "./helpers/real-delivery.ts";
import { scoringArtifact } from "./helpers/real-delivery.mjs";
import { drbSamples } from "./benchmarks/deepresearchbench/samples.ts";

for (const sample of drbSamples) {
  const drbQuestion = sample.question;
  const drbOutput = `deepresearchbench-${sample.id}.md`;
  const drbPrompt = researchPrompt(drbQuestion, drbOutput);
/**
 * E2E-META
 * Purpose: Research five difficulty-stratified DeepResearchBench samples autonomously on Swarm, verify durable UI delivery, and optionally evaluate RACE/FACT.
 * Steps:
 *   1. Validate evaluator prerequisites, create an always-allow Session and submit the original question with delivery instructions.
 *   2. Check terminal completion and readable nonempty artifacts referenced in the final response.
 *   3. Run pinned RACE/FACT as non-gating quality evaluation; preserve official criteria and export scores.
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
  test(`DRB-${sample.id} ${sample.difficulty} Swarm research integration`, { tag: ["@real","@category:e2e","@os:linux","@arch:amd64","@model:real","@judge:llm","@sandbox:bubblewrap"] }, async ({ journey, page }, testInfo) => {
    // These evidence-heavy cases have reviewed generation budgets. Keep
    // their dedicated overrides ahead of the shorter suite-wide CI budget.
    const caseRunBudget = sample.id === 58 ? 5_400_000 : (sample.id === 59 || sample.id === 64) ? 7_200_000 : undefined;
    const runBudget = caseRunBudget === undefined
      ? positiveNumber("E2E_DRB_RUN_TIMEOUT_MS", 3_600_000)
      : positiveNumber(`E2E_DRB_${sample.id}_RUN_TIMEOUT_MS`, caseRunBudget);
    const judgeBudget = positiveNumber("E2E_DRB_EVAL_TIMEOUT_MS", 3_600_000);
    test.setTimeout(runBudget + judgeBudget + 240_000);
    expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires isolated Swarm stack (E2E_SWARM_TASK=1)").toBe(false);
    journey.scenario({ goal: `Research DRB-${sample.id} and evaluate both delivery and report quality.`,
      preconditions: ["live generator", "isolated Swarm stack", "configured judges and source access"] });
    const metrics: Record<string, any> = {
      schema_version: 1, case_id: sample.id, difficulty: sample.difficulty, difficulty_source: "local workload stratification", backend: "jiuwenswarm", started_at: new Date().toISOString(),
      prompt: drbPrompt, run_budget_ms: runBudget, evaluation_budget_ms: judgeBudget,
      max_subagents_prompt_limit: process.env.E2E_DRB_MAX_SUBAGENTS === undefined ? null : Number(process.env.E2E_DRB_MAX_SUBAGENTS),
      integration_status: "not_run", evaluation: { status: "not_run" },
      children: [], generation_usage: null,
    };
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let runId: string | undefined;
    let terminal: string | undefined;
    let started: number | undefined;
    try {
      let config: ReturnType<typeof evaluationConfig> | undefined;
      try {
        config = evaluationConfig();
        metrics.evaluation_mode = config.mode;
        await evaluationPreflight(config);
      } catch (error) {
        config = undefined;
        metrics.evaluation = { status: "error", gating: false, error: error instanceof Error ? error.message : String(error) };
      }
      const existingModelId = process.env.E2E_LLM_MODEL_ID?.trim();
      if (existingModelId) allowRealEnvException(testInfo, "Explicit live model already registered on isolated stack; credentials stay server-side.");
      const real = existingModelId ? undefined : requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
      await requireRealStack(testInfo);
      fixture = await createProjectAndSession(page, {
        approvalMode: "always_allow",
        ...(existingModelId ? { modelId: existingModelId } : { model: { apiToken: real!.E2E_LLM_TOKEN!,
          baseUrl: real!.E2E_LLM_BASE_URL!, model: real!.E2E_LLM_MODEL!, name: `DRB-${sample.id} ${Date.now()}` } }),
        projectName: `DRB-${sample.id} Swarm ${Date.now()}`, sessionTitle: `DRB-${sample.id} autonomous research`,
      });
      metrics.generator_model_id = fixture.session.modelId ?? existingModelId;
      const models = await drbApi<Array<{ id: string; model: string }>>(page, "/api/models");
      metrics.generator_model = models.find(m => m.id === metrics.generator_model_id)?.model ?? real?.E2E_LLM_MODEL ?? null;
      await openProjectSession(page, fixture);
      started = Date.now();
      const run = await sendUserMessage(page, fixture.session.id, drbPrompt);
      runId = run.id;
      metrics.run_id = runId;
      metrics.session_id = fixture.session.id;
      await writeFile(testInfo.outputPath("benchmark-metrics.json"), JSON.stringify(metrics, null, 2));
      const finished = await waitForRunTerminal(page, fixture.session.id, runId, runBudget);
      terminal = finished.status;
      metrics.run_status = terminal;
      metrics.generation_duration_ms = Date.now() - started;
      const delivery = await collectFinalDelivery(page, fixture.session.id, runId);
      metrics.delivery = delivery;
      metrics.integration_status = delivery.status;
      expect(delivery.status, "Main run must complete and reference a readable nonempty final artifact").toBe("passed");
      const report = scoringArtifact(delivery.artifacts, drbOutput);
      if (report) {
        const input = testInfo.outputPath(`deepresearchbench-${sample.id}.json`);
        await writeFile(input, JSON.stringify({ id: sample.id, prompt: drbQuestion, article: report.text }, null, 2));
        await testInfo.attach("benchmark-report", { path: input, contentType: "application/json" });
        metrics.report_version_id = report.version;
        if (config) metrics.evaluation = { ...await evaluateReport(config, input, testInfo.outputPath("evaluation"), judgeBudget), gating: false };
      } else {
        metrics.evaluation = { status: "insufficient_evidence", gating: false, reason: "No unambiguous final text report for official RACE/FACT scoring" };
      }
      metrics.quality_status = metrics.evaluation.status;
      await testInfo.attach("quality-scorecard", { contentType: "application/json", body: JSON.stringify(metrics.evaluation, null, 2) });

    } catch (error) {
      metrics.error = error instanceof Error ? error.message : String(error);
      if (!["passed", "partial"].includes(metrics.integration_status)) metrics.integration_status = "failed";
      throw error;
    } finally {
      const visibleAnswers = await page.locator(".message.assistant").allTextContents().catch(() => []);
      await writeFile(testInfo.outputPath("assistant-messages.json"), JSON.stringify(visibleAnswers, null, 2));
      if (fixture) {
        if (runId && !terminal) {
          await page.request.post(`${apiBaseUrl()}/api/sessions/${fixture.session.id}/runs/${runId}/cancel`,
            { headers: authorizationHeader() }).catch(() => undefined);
          await waitForRunTerminal(page, fixture.session.id, runId, 30_000).catch(() => undefined);
        }
        metrics.generation_usage = await drbApi(page, `/api/sessions/${fixture.session.id}/usage`).catch(() => null);
        const details = await drbApi<Array<any>>(page, `/api/sessions/${fixture.session.id}/subagents`).catch(() => []);
        await writeFile(testInfo.outputPath("child-trajectories.json"), JSON.stringify(details, null, 2));
        metrics.tool_errors = details.flatMap(c => (c.steps ?? []).filter((s: any) => s.kind === "tool" && s.status === "failed")
          .map((s: any) => ({ agent_id: c.id, tool: s.toolName, content: s.content })));
        metrics.artifacts = await drbApi(page, `/api/sessions/${fixture.session.id}/artifacts`).catch(() => []);
        // Preserve delivery evidence even if an earlier lifecycle/UI assertion failed.
        const retainedReport = await drbArticle(page, fixture.session.id, drbOutput).catch(() => null);
        if (retainedReport && !metrics.report_version_id) {
          await writeFile(testInfo.outputPath(`deepresearchbench-${sample.id}.json`),
            JSON.stringify({ id: sample.id, prompt: drbQuestion, article: retainedReport.article }, null, 2));
          metrics.report_words ??= retainedReport.article.trim().split(/\s+/u).length;
        }
        metrics.generation_duration_ms ??= started ? Date.now() - started : null;
        // Capture reliability metrics on early assertion failures too.
        if (!metrics.children.length) metrics.children = await drbApi<Array<{ id: string; status: string }>>(
          page, `/api/sessions/${fixture.session.id}/subagents`).then(cs => cs.map(c => ({ id: c.id, status: c.status }))).catch(() => []);
      }
      metrics.finished_at = new Date().toISOString();
      const path = testInfo.outputPath("benchmark-metrics.json");
      await writeFile(path, JSON.stringify(metrics, null, 2));
      await testInfo.attach("benchmark-metrics", { path, contentType: "application/json" });
      if (fixture && process.env.E2E_KEEP_RESEARCH_RECORDS !== "1") await cleanupJourney(page, fixture);
    }
  });
}
