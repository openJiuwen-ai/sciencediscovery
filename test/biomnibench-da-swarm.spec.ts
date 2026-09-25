// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { allowRealEnvException, requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { cleanupJourney, createProjectAndSession, openProjectSession,
  sendUserMessage, sessionExecutionRuns, waitForRunTerminal } from "./helpers/journeys.ts";
import { drbApi, drbArticle, positiveNumber } from "./helpers/deepresearchbench.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { collectFinalDelivery } from "./helpers/real-delivery.ts";
import { analysisPrompt, cases } from "./benchmarks/biomnibench-da/cases.ts";

const execute = promisify(execFile);
const scripts = fileURLToPath(new URL("./benchmarks/biomnibench-da/", import.meta.url));
const outputs = ["trace.md", "answer.txt"];
const diagnosticOutputs = ["analysis.py", "analysis.json"];

async function verifiedFile(path: string, oid: string) {
  const data = await readFile(path);
  const actual = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  if (actual !== oid) throw new Error(`Benchmark input differs from pinned upstream blob: ${path}`);
  return data;
}

for (const sample of cases) {
/**
 * E2E-META
 * Purpose: Execute two small BiomniBench-DA analyses on real Swarm and verify delivery and score analysis with the upstream rubric.
 * Steps:
 *   1. Verify authorized local benchmark inputs before paid calls; upload the CSV through the workspace API.
 *   2. Submit the original task plus platform delivery contract; verify the two required nonempty deliverables.
 *   3. Retain diagnostics, usage and optionally score the analysis using the upstream rubric with a local Judge adapter.
 * Environment: Opt-in isolated Swarm stack, local authorized BiomniBench task directories and Python scientific dependencies.
 * Type: real
 * LLM: Real configured generator and optional separately configured rubric judge.
 * WebSearch: Live if the model needs general background references; source-paper answer lookup prohibited by original task.
 * PaperSources: Not required for numerical analysis.
 * MCP: Platform execution tools exposed through Swarm.
 * OtherExternal: Local API, Runner, browser and Artifact store; no dataset auto-download.
 * Credentials: E2E_API_TOKEN; E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN; optional BIOMNI_JUDGE_API_KEY.
 * CostSideEffects: Billable model calls; temporary projects and sessions; retained test diagnostics and reports. Not a PR gate.
 */
  test(`BiomniBench-${sample.id} ${sample.title}`, { tag: ["@real","@category:e2e","@os:linux","@arch:amd64","@model:real","@judge:llm","@sandbox:bubblewrap"] }, async ({ page, journey }, testInfo) => {
    const budget = positiveNumber("E2E_BIOMNI_RUN_TIMEOUT_MS", 1_800_000);
    test.setTimeout(budget + 360_000);
    expect(process.env.E2E_SWARM_TASK !== "1", "BLOCKED: requires isolated Swarm stack").toBe(false);
    const modelId = process.env.E2E_LLM_MODEL_ID?.trim();
    if (modelId) allowRealEnvException(testInfo, "Live model is already registered on the isolated stack.");
    const real = modelId ? undefined : requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
    const env = requireRealEnv(testInfo, "BIOMNI_DATA_ROOT");
    const mode = process.env.E2E_BIOMNI_EVALUATION ?? "rubric";
    if (!["off", "rubric"].includes(mode)) throw new Error("E2E_BIOMNI_EVALUATION must be off or rubric");
    const python = process.env.BIOMNI_PYTHON ?? "python3";
    const task = join(env.BIOMNI_DATA_ROOT!, sample.id);
    const dataPath = join(task, "environment/data", sample.file);
    const rubricPath = join(task, "tests/rubric.txt");
    const [data, instruction] = await Promise.all([
      verifiedFile(dataPath, sample.dataOid), verifiedFile(join(task, "instruction.md"), sample.instructionOid),
      verifiedFile(rubricPath, sample.rubricOid),
    ]);
    await requireRealStack(testInfo);
    journey.scenario({ goal: `Execute ${sample.id} with real data and a real LLM.`, preconditions: ["isolated Swarm", "pinned input data", "Python scientific stack"] });
    const metrics: Record<string, any> = { schema_version: 1, case_id: sample.id, backend: "jiuwenswarm",
      started_at: new Date().toISOString(), data_bytes: data.length, data_sha256: createHash("sha256").update(data).digest("hex"),
      instruction_oid: sample.instructionOid, rubric_oid: sample.rubricOid, integration_status: "not_run",
      evaluation: { status: mode === "off" ? "disabled" : "not_run" }, resource_measurement: "not_collected", run_budget_ms: budget };
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let runId: string | undefined;
    let terminal = false;
    let start: number | undefined;
    try {
      fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
        ...(modelId ? { modelId } : { model: { apiToken: real!.E2E_LLM_TOKEN!, baseUrl: real!.E2E_LLM_BASE_URL!,
          model: real!.E2E_LLM_MODEL!, name: `BiomniBench ${sample.id} ${Date.now()}` } }),
        projectName: `BiomniBench ${sample.id} ${Date.now()}`, sessionTitle: sample.title });
      const prefix = `/api/sessions/${fixture.session.id}`;
      metrics.session_id = fixture.session.id;
      metrics.generator_model_id = fixture.session.modelId ?? modelId;
      const upload = await page.request.post(`${apiBaseUrl()}${prefix}/workspace/upload`, {
        headers: authorizationHeader(), multipart: { files: { name: sample.file, mimeType: "text/csv", buffer: data } } });
      expect(upload.status(), await upload.text()).toBe(201);
      await openProjectSession(page, fixture);
      const prompt = analysisPrompt(sample.id, instruction.toString("utf8"), sample.file);
      await writeFile(testInfo.outputPath("prompt.txt"), prompt);
      start = Date.now();
      const run = await sendUserMessage(page, fixture.session.id, prompt);
      runId = run.id;
      metrics.run_id = runId;
      await writeFile(testInfo.outputPath("benchmark-metrics.json"), JSON.stringify(metrics, null, 2));
      try {
        const finished = await waitForRunTerminal(page, fixture.session.id, runId, budget);
        terminal = true;
        metrics.run_status = finished.status;
        metrics.run_error = finished.error;
      } catch (error) {
        metrics.run_status = "wait_error";
        metrics.run_error = error instanceof Error ? error.message : String(error);
        // Stop generation at the budget, then assess whatever was delivered.
        await page.request.post(`${apiBaseUrl()}${prefix}/runs/${runId}/cancel`, { headers: authorizationHeader() });
        const stopped = await waitForRunTerminal(page, fixture.session.id, runId, 30_000).catch(() => null);
        terminal = stopped !== null;
        if (stopped) metrics.run_status = stopped.status;
      }
      metrics.generation_duration_ms = Date.now() - start;
      const executions = await sessionExecutionRuns(page, fixture.session.id).catch(() => null);
      await writeFile(testInfo.outputPath("execution-runs.json"), JSON.stringify(executions, null, 2));
      metrics.execution_count = executions?.length ?? null;
      metrics.children = await drbApi<any[]>(page, `${prefix}/subagents`).catch(() => null);
      const delivery = await collectFinalDelivery(page, fixture.session.id, runId);
      metrics.delivery = delivery;
      metrics.integration_status = delivery.status;
      expect(delivery.status, "Main run must complete and reference a readable nonempty final artifact").toBe("passed");
      try {
        // Official rubric consumes trace and answer; nesting does not change their meaning.
        const scoringInputs: Record<string, string> = {};
        const catalog = await drbApi<any[]>(page, `${prefix}/artifacts`);
        for (const name of outputs) {
          const delivered = delivery.artifacts.filter(a => a.logicalName === name || a.logicalName.endsWith(`/${name}`));
          const named = catalog.filter(a => a.logicalName === name || a.logicalName.endsWith(`/${name}`));
          const content = delivered.length === 1 ? delivered[0]!.text : named.length === 1
            ? (await drbArticle(page, fixture.session.id, named[0].logicalName).catch(() => null))?.article : undefined;
          if (content?.trim()) {
            scoringInputs[name] = content;
            await writeFile(testInfo.outputPath(name), content);
          }
        }
        if (mode === "rubric") {
          metrics.evaluation = { status: "running" };
          const judgeStart = Date.now();
          try {
            if (outputs.some(name => !scoringInputs[name])) throw new Error("Official rubric input missing: trace.md or answer.txt; delivery remains passed");
            await execute(python, [join(scripts, "judge.py"), "--rubric", rubricPath,
              "--trace", testInfo.outputPath("trace.md"), "--answer", testInfo.outputPath("answer.txt"),
              "--output", testInfo.outputPath("quality-scorecard.json")], { timeout: 200_000 });
            metrics.evaluation = JSON.parse(await readFile(testInfo.outputPath("quality-scorecard.json"), "utf8"));
            metrics.evaluation.duration_ms = Date.now() - judgeStart;
            metrics.evaluation.gating = false;
          } catch (error) {
            metrics.evaluation = { status: "error", gating: false, duration_ms: Date.now() - judgeStart,
              error: error instanceof Error ? error.message : String(error) };
          }
        }
      } catch (error) {
        metrics.evaluation = { status: "error", gating: false, error: error instanceof Error ? error.message : String(error) };
      }

    } catch (error) {
      metrics.error = error instanceof Error ? error.message : String(error);
      if (!["passed", "partial"].includes(metrics.integration_status)) metrics.integration_status = "failed";
      if (metrics.evaluation.status === "running") metrics.evaluation = { status: "error" };
      throw error;
    } finally {
      if (fixture) {
        const prefix = `/api/sessions/${fixture.session.id}`;
        if (runId && !terminal) {
          await page.request.post(`${apiBaseUrl()}${prefix}/runs/${runId}/cancel`, { headers: authorizationHeader() }).catch(() => undefined);
          await waitForRunTerminal(page, fixture.session.id, runId, 30_000).catch(() => undefined);
        }
        metrics.generation_usage = await drbApi(page, `${prefix}/usage`).catch(() => null);
        metrics.children = await drbApi(page, `${prefix}/subagents`).catch(() => null);
        metrics.artifacts = await drbApi(page, `${prefix}/artifacts`).catch(() => null);
        // Retain partial deliverables even when required deliverables are missing.
        for (const name of [...outputs, ...diagnosticOutputs]) {
          const content = await drbArticle(page, fixture.session.id, name).catch(() => null);
          if (content && metrics.integration_status !== "passed") await writeFile(testInfo.outputPath(name), content.article);
        }
        await writeFile(testInfo.outputPath("assistant-messages.json"), JSON.stringify(await page.locator(".message.assistant").allTextContents().catch(() => []), null, 2));
      }
      metrics.generation_duration_ms ??= start ? Date.now() - start : null;
      metrics.finished_at = new Date().toISOString();
      await writeFile(testInfo.outputPath("benchmark-metrics.json"), JSON.stringify(metrics, null, 2));
      await testInfo.attach("benchmark-metrics", { path: testInfo.outputPath("benchmark-metrics.json"), contentType: "application/json" });
      if (fixture && process.env.E2E_KEEP_RESEARCH_RECORDS !== "1") await cleanupJourney(page, fixture);
    }
  });
}
