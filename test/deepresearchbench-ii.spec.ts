// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { test, requireRealEnv, requireRealStack } from "./helpers/e2e.ts";
import { createProjectAndSession, openProjectSession, sendUserMessage, waitForRunChainTerminal,
  cancelActiveSessionRuns, cleanupJourney } from "./helpers/journeys.ts";
import { drbApi, positiveNumber } from "./helpers/deepresearchbench.ts";
import { collectFinalDelivery } from "./helpers/real-delivery.ts";
import { finalReportArtifact } from "./helpers/real-delivery.mjs";
import { caseIds, revision, verifyUpstream, researchPrompt } from "./benchmarks/deepresearchbench-ii/upstream.mjs";

for (const id of caseIds) {
  /**
   * E2E-META
   * Purpose: Complete each of the 132 DRB II tasks and obtain a complete official-rubric score for release assessment.
   * Steps:
   *   1. Verify pinned runtime dataset/evaluator and live generator/Judge credentials.
   *   2. Submit the original task including excluded sources, wait for final delivery and preserve evidence.
   *   3. Score all rubric items; record quality, latency, usage and failures separately.
   * Environment: Isolated Swarm stack, verified DRB II runtime checkout and Python environment.
   * Type: real
   * LLM: Configured live generator and independent Judge.
   * WebSearch: Live product providers.
   * PaperSources: Agent-selected live sources excluding benchmark-blocked articles.
   * MCP: Platform tools through the Swarm adapter.
   * OtherExternal: Source websites, Runner and browser.
   * Credentials: E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN and E2E_JUDGE_BASE_URL/E2E_JUDGE_MODEL/E2E_JUDGE_TOKEN.
   * CostSideEffects: Paid generation and rubric evaluation; temporary project/session, retained local reports and diagnostics.
   */
  test(`DRB-II-${id} full release benchmark`, {
    tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@judge:llm", "@sandbox:bubblewrap", "@tier:l5"],
    annotation: { type: "capability", description: "swarm-task" },
  }, async ({ journey, page }, testInfo) => {
    const runBudget = positiveNumber("E2E_DRB2_RUN_TIMEOUT_MS", 7_200_000);
    const judgeBudget = positiveNumber("E2E_DRB2_EVAL_TIMEOUT_MS", 1_800_000);
    test.setTimeout(runBudget + judgeBudget + 240_000);
    const env = requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN",
      "E2E_JUDGE_BASE_URL", "E2E_JUDGE_MODEL", "E2E_JUDGE_TOKEN", "DRB2_UPSTREAM_DIR", "DRB2_PYTHON");
    const task = verifyUpstream(env.DRB2_UPSTREAM_DIR).find(t => t.idx === id)!;
    // All dependency/config checks happen before billable research.
    await promisify(execFile)(env.DRB2_PYTHON!, ["-c", "import requests, docx"], { timeout: 30_000 });
    expect(["openai", "deepseek"]).toContain(process.env.DRB2_JUDGE_API_STYLE ?? "openai");
    await requireRealStack(testInfo);
    journey.scenario({ goal: `DRB II task ${id}: final report and complete rubric score`,
      preconditions: ["pinned 132-task dataset", "live generator and Judge", "working Swarm/Runner"] });
    const prompt = researchPrompt(task);
    const metrics: Record<string, any> = { schema_version: 1, case_id: `drb2-${id}`, benchmark: "DeepResearchBench II",
      upstream_revision: revision, license: task.license, generator_model: env.E2E_LLM_MODEL,
      judge_model: env.E2E_JUDGE_MODEL, backend: "jiuwenswarm", started_at: new Date().toISOString(),
      memory_graph_available: process.env.SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE !== "0",
      run_budget_ms: runBudget, judge_budget_ms: judgeBudget, prompt,
      integration_status: "not_run", evaluation: { status: "not_run" },
      generation_usage_scope: "platform session summary; may omit intermediate/child calls; not billing total" };
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let rootRun: string | undefined;
    let terminal = false;
    let started: number | undefined;
    const save = () => writeFile(testInfo.outputPath("benchmark-metrics.json"), JSON.stringify(metrics, null, 2));
    try {
      metrics.quota_settings = await drbApi(page, "/api/quota-settings");
      fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
        model: { apiToken: env.E2E_LLM_TOKEN!, baseUrl: env.E2E_LLM_BASE_URL!, model: env.E2E_LLM_MODEL!, name: `DRB II ${id}` },
        projectName: `DRB II ${id}`, sessionTitle: `DRB II ${id}` });
      metrics.session_id = fixture.session.id;
      await openProjectSession(page, fixture);
      started = Date.now();
      const run = await sendUserMessage(page, fixture.session.id, prompt);
      rootRun = run.id;
      metrics.run_id = rootRun;
      await save();
      const finished = await waitForRunChainTerminal(page, fixture.session.id, rootRun, { timeout: runBudget });
      terminal = true;
      metrics.generation_duration_ms = Date.now() - started;
      metrics.run_status = finished.run.status;
      const delivery = await collectFinalDelivery(page, fixture.session.id, finished.run.id, rootRun);
      metrics.delivery = delivery;
      metrics.integration_status = delivery.status;
      expect(delivery.status).toBe("passed");
      const report = finalReportArtifact(delivery.artifacts, `drb2-${id}.md`, delivery.producer_answer);
      if (!report) metrics.integration_status = "failed";
      expect(report, "A final report, not only intermediate artifacts, is required").toBeDefined();
      const reportPath = testInfo.outputPath(`idx-${id}.md`);
      await writeFile(reportPath, report!.text);
      const output = testInfo.outputPath("evaluation");
      try {
        await promisify(execFile)(env.DRB2_PYTHON!, [fileURLToPath(new URL("./benchmarks/deepresearchbench-ii/evaluate.py", import.meta.url)),
          "--upstream", env.DRB2_UPSTREAM_DIR!, "--id", String(id), "--report", reportPath, "--output", output],
        { timeout: judgeBudget, maxBuffer: 4 * 1024 * 1024 });
      } catch {
        metrics.evaluation = { status: "error", reason: "Judge failed or exceeded budget; inspect scorecard/call ledger" };
      }
      metrics.evaluation = await readFile(`${output}/scorecard.json`, "utf8").then(JSON.parse).catch(() => metrics.evaluation);
      expect(metrics.evaluation.status, "Every rubric must have a valid verdict; missing evaluation is not zero quality").toBe("completed");
    } catch (error) {
      metrics.error = error instanceof Error ? error.name : "Error"; // Avoid Playwright auth headers in metrics.
      if (metrics.integration_status !== "passed") metrics.integration_status = "failed";
      throw error;
    } finally {
      metrics.generation_duration_ms ??= started ? Date.now() - started : null;
      if (fixture) {
        if (rootRun && !terminal) metrics.shutdown = await cancelActiveSessionRuns(page, fixture.session.id).catch(() => ({ status: "error" }));
        metrics.generation_usage = await drbApi(page, `/api/sessions/${fixture.session.id}/usage`).catch(() => null);
        metrics.children = await drbApi(page, `/api/sessions/${fixture.session.id}/subagents`).catch(() => null);
      }
      metrics.finished_at = new Date().toISOString();
      await save();
      if (fixture && process.env.E2E_KEEP_RESEARCH_RECORDS !== "1" && (!metrics.shutdown || metrics.shutdown.status === "stopped"))
        await cleanupJourney(page, fixture);
    }
  });
}
