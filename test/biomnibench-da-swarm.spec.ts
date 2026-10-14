// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { requireRealEnv, requireRealStack, test } from "./helpers/e2e.ts";
import { cancelActiveSessionRuns, cleanupJourney, createProjectAndSession, openProjectSession } from "./helpers/journeys.ts";
import { drbApi, positiveNumber } from "./helpers/deepresearchbench.ts";
import { apiBaseUrl, authorizationHeader } from "./e2e-auth.js";
import { collectFinalDelivery } from "./helpers/real-delivery.ts";
import { requiredArtifacts } from "./helpers/real-delivery.mjs";
import { mainRunChain } from "./helpers/run-chain.ts";
import { loadAnalysisPrompt, cases, manifest, researchTeamReference } from "./benchmarks/biomnibench-da/cases.ts";
import { generationTokens, judgeTokens, machineIdentity, MEASUREMENT_VERSION, settled, startMemorySampler, toolMetrics } from "./benchmarks/biomnibench-da/metrics.mjs";
import { manifestHash, validateMetrics } from "../.ci/biomni-gate.mjs";
import { biomniCase } from "./support/tagged/execution.mjs";
import { validatePlan } from "./support/tagged/plan.mjs";

const execute = promisify(execFile);
const scripts = fileURLToPath(new URL("./benchmarks/biomnibench-da/", import.meta.url));
const outputs = ["trace.md", "answer.txt"];

async function waitForResearch(page: any, sessionId: string, rootRunId: string, budget: number) {
  const prefix = `/api/sessions/${sessionId}`, deadline = Date.now() + budget;
  let previous = "", stableAt = Date.now();
  while (Date.now() < deadline) {
    const [runs, children, activity] = await Promise.all([
      drbApi<any[]>(page, `${prefix}/runs`), drbApi<any[]>(page, `${prefix}/subagents`), drbApi<any>(page, `${prefix}/agent-activity`),
    ]);
    const snapshot = { runs, children, activity };
    const last = mainRunChain(runs, rootRunId).at(-1);
    if (settled(snapshot) && last?.status === "completed") {
      // Terminal executions must precede the final answer, not complete after it.
      const workFinished = [...activity.executions, ...activity.transfers, ...children]
        .every((x: any) => !x.finishedAt || Date.parse(x.finishedAt) <= Date.parse(last.finishedAt));
      const timersConsumed = activity.timers.every((x: any) => x.state !== "fired" || x.dueAt <= Date.parse(last.finishedAt));
      if (workFinished && timersConsumed) {
        const delivery = await collectFinalDelivery(page, sessionId, last.id, rootRunId, outputs);
        const fingerprint = JSON.stringify([snapshot, delivery.artifacts.map(a => [a.id, a.version])]);
        if (fingerprint !== previous) { previous = fingerprint; stableAt = Date.now(); }
        if (delivery.status === "passed" && requiredArtifacts(delivery.artifacts, outputs).missing.length === 0
            && Date.now() - stableAt >= 5_000) return { snapshot, delivery, runId: last.id };
      } else { previous = ""; stableAt = Date.now(); }
    } else {
      previous = ""; stableAt = Date.now();
      if (settled(snapshot) && last && ["failed", "cancelled"].includes(last.status)) throw new Error(`Final research run ${last.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Research did not settle with trace.md and answer.txt within the end-to-end budget");
}

for (const sample of cases) {
/**
 * E2E-META
 * Purpose: Run every public BiomniBench-DA task in L5 and require complete score and resource evidence.
 * Steps:
 *   1. Verify pinned authorized input files; stage nested data in a disposable local session workspace.
 *   2. Attach the research-team Skill as a structured reference, submit the original instruction with parameter and delivery appendices, and wait for final artifacts.
 *   3. Score the trace and answer using the original rubric; validate and retain all required metrics.
 * Environment: Isolated Linux Swarm stack, authorized pinned data, sufficient disk/RAM and product scientific runtime.
 * Type: real
 * LLM: Real configured generator and separately configured rubric judge.
 * WebSearch: Disabled by a non-enforcing Skill parameter in the submitted prompt; original task restrictions apply.
 * PaperSources: Original benchmark task data.
 * MCP: Product execution tools and sandbox.
 * OtherExternal: Gated Hugging Face data prepared before model calls; local API, Runner and artifact store.
 * Credentials: E2E_API_TOKEN, E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN, BIOMNI_JUDGE_BASE_URL/BIOMNI_JUDGE_MODEL/BIOMNI_JUDGE_API_KEY.
 * CostSideEffects: Billable generation/judging; temporary sessions; L5 full-public baseline candidate, not a PR default.
 */
  test(`BiomniBench-${sample.id} ${sample.title}`, { tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@judge:llm", "@sandbox:bubblewrap", "@status:external", "@tier:l5"], annotation: { type: "capability", description: "swarm-task" } }, async ({ page, journey }, testInfo) => {
    const budget = positiveNumber("E2E_BIOMNI_RUN_TIMEOUT_MS", 10_800_000);
    const workspaceBudget = positiveNumber("SCIENCE_AGENT_MAX_WORKSPACE_BYTES", 40 * 1024 ** 3);
    const evaluationBudget = positiveNumber("E2E_BIOMNI_EVAL_TIMEOUT_MS", 3_900_000);
    const preparationBudget = 1_800_000;
    test.setTimeout(budget + evaluationBudget + 2 * preparationBudget + 360_000);
    expect(process.env.E2E_SWARM_TASK, "BLOCKED: isolated Swarm stack required").toBe("1");
    const env = requireRealEnv(testInfo, "BIOMNI_DATA_ROOT", "E2E_BIOMNI_FIXTURE_ROOT", "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN", "BIOMNI_JUDGE_BASE_URL", "BIOMNI_JUDGE_MODEL", "BIOMNI_JUDGE_API_KEY", "SCIENCE_TAG_PLAN");
    if ((process.env.E2E_BIOMNI_EVALUATION ?? "rubric") !== "rubric") throw new Error("L5 requires rubric scoring");
    const plan = validatePlan(JSON.parse(await readFile(env.SCIENCE_TAG_PLAN!, "utf8")));
    const entry = plan.entries.find((e: any) => biomniCase(e) === sample.id);
    if (!entry) throw new Error("Benchmark task missing from frozen plan");
    const python = process.env.BIOMNI_PYTHON ?? "python3";
    const task = join(env.BIOMNI_DATA_ROOT!, sample.id);
    const metrics: Record<string, any> = { schema_version: 2, benchmark: "biomnibench-da", case_id: sample.id,
      key: entry.key, revision: plan.revision, integration_status: "not_run", evaluation: { status: "not_run", gating: true },
      identity: { dataset_revision: manifest.revision, manifest_sha256: manifestHash, evaluator_revision: plan.evaluatorRevision,
        measurement_version: MEASUREMENT_VERSION, generator_model: env.E2E_LLM_MODEL, judge_model: env.BIOMNI_JUDGE_MODEL,
        backend: plan.execution.backend, run_budget_ms: budget, workspace_budget_bytes: workspaceBudget, machine: machineIdentity() } };
    let fixture: Awaited<ReturnType<typeof createProjectAndSession>> | undefined;
    let memory: Awaited<ReturnType<typeof startMemorySampler>> | undefined;
    let completed = false;
    journey.scenario({ goal: `Complete and score public task ${sample.id}; record score, tool rounds, memory, latency and tokens.`, preconditions: ["isolated Swarm", "pinned authorized inputs", "candidate baseline mode"] });
    try {
      await journey.step("Prepare the scientific task", "Verify the pinned task and place only input data in the disposable workspace.", async () => {
        await execute(python, [join(scripts, "prepare.py"), "verify", "--root", env.BIOMNI_DATA_ROOT!, "--case", sample.id], { timeout: preparationBudget });
        await requireRealStack(testInfo);
        fixture = await createProjectAndSession(page, { approvalMode: "always_allow",
          model: { apiToken: env.E2E_LLM_TOKEN!, baseUrl: env.E2E_LLM_BASE_URL!, model: env.E2E_LLM_MODEL!, name: `BiomniBench ${sample.id} ${Date.now()}` },
          projectName: `BiomniBench ${sample.id} ${Date.now()}`, sessionTitle: sample.title });
        await execute(python, [join(scripts, "prepare.py"), "stage", "--root", env.BIOMNI_DATA_ROOT!, "--case", sample.id,
          "--data-root", env.E2E_BIOMNI_FIXTURE_ROOT!, "--project", fixture.project.id, "--session", fixture.session.id], { timeout: preparationBudget });
        await openProjectSession(page, fixture);
      });
      const prefix = `/api/sessions/${fixture!.session.id}`;
      let finished: Awaited<ReturnType<typeof waitForResearch>>;
      await journey.step("Run the complete research task", "Wait for final delivery after tools, children and automatic wake-ups settle.", async () => {
        const before = await drbApi<any>(page, `${prefix}/usage`);
        const prompt = await loadAnalysisPrompt(env.BIOMNI_DATA_ROOT!, sample.id);
        await writeFile(testInfo.outputPath("prompt.txt"), prompt);
        memory = await startMemorySampler(env.E2E_BIOMNI_FIXTURE_ROOT!);
        const start = performance.now();
        const runResponse = await page.request.post(`${apiBaseUrl()}${prefix}/runs`, {
          data: { content: prompt, references: [researchTeamReference] },
          headers: authorizationHeader(),
        });
        const runBody = await runResponse.text();
        expect(runResponse.status(), runBody).toBe(201);
        const initialRun = JSON.parse(runBody) as { id: string; references: Array<{ id: string; kind: string; label: string }>;
          settingsSnapshot: { enabledSkillIds: string[] } };
        expect(initialRun.references).toContainEqual(researchTeamReference);
        expect(initialRun.settingsSnapshot.enabledSkillIds).toContain(researchTeamReference.id);
        metrics.initial_run_id = initialRun.id;
        finished = await waitForResearch(page, fixture!.session.id, initialRun.id, Math.max(1, budget - (performance.now() - start)));
        const e2eMs = performance.now() - start;
        const measuredMemory = await memory.stop(); memory = undefined;
        const usage = await drbApi<any>(page, `${prefix}/usage`);
        const tokens = generationTokens(usage, before.invocations.map((x: any) => x.id));
        const records: any[] = [];
        for (const run of finished.snapshot.runs) {
          records.push(...await drbApi<any[]>(page, `${prefix}/runs/${run.id}/events`));
          for (const child of finished.snapshot.children) {
            records.push(...await drbApi<any[]>(page, `${prefix}/runs/${run.id}/streams/${encodeURIComponent(`subagent-${child.id}`)}/events`));
          }
        }
        for (const child of finished.snapshot.children) {
          const recorded = new Set(records.filter(r => r.event.type === "subagent.step" && r.event.subagentId === child.id)
            .map(r => r.event.step.toolCallId).filter(Boolean));
          if (child.steps.some((s: any) => s.kind === "tool" && (!s.toolCallId || !recorded.has(s.toolCallId)))) throw new Error("Incomplete subagent tool stream");
        }
        metrics.measurements = { ...toolMetrics(records), peak_rss_bytes: measuredMemory.peak_rss_bytes,
          memory_samples: measuredMemory.samples, memory_interval_ms: measuredMemory.interval_ms, memory_scope: measuredMemory.scope,
          e2e_ms: e2eMs, generation_tokens: tokens.total, generation_input_tokens: tokens.input, generation_output_tokens: tokens.output };
        metrics.integration_status = finished.delivery.status;
        metrics.run_id = finished.runId;
        await writeFile(testInfo.outputPath("research-evidence.json"), JSON.stringify({ ...finished, usage, records }, null, 2));
        for (const name of outputs) {
          const artifact = requiredArtifacts(finished.delivery.artifacts, outputs).found.get(name)!;
          await writeFile(testInfo.outputPath(name), artifact.text);
        }
      });
      await journey.step("Score and validate the evidence", "Require a valid original-rubric score and complete generator/judge usage before publishing metrics.", async () => {
        const judgeStart = performance.now();
        metrics.evaluation = { status: "running", gating: true };
        await execute(python, [join(scripts, "judge.py"), "--rubric", join(task, "tests/rubric.txt"),
          "--trace", testInfo.outputPath("trace.md"), "--answer", testInfo.outputPath("answer.txt"),
          "--output", testInfo.outputPath("quality-scorecard.json")], { timeout: evaluationBudget });
        metrics.evaluation = { ...JSON.parse(await readFile(testInfo.outputPath("quality-scorecard.json"), "utf8")), gating: true };
        const tokens = judgeTokens(JSON.parse(await readFile(testInfo.outputPath("quality-scorecard.attempts", "attempts.json"), "utf8")));
        Object.assign(metrics.measurements, { score: metrics.evaluation.score, judge_ms: performance.now() - judgeStart,
          judge_tokens: tokens.total, judge_input_tokens: tokens.input, judge_output_tokens: tokens.output,
          total_tokens: metrics.measurements.generation_tokens + tokens.total });
        validateMetrics(metrics, entry, plan);
        completed = true;
      });
    } catch (error) {
      metrics.integration_status = "failed";
      metrics.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (memory) await memory.stop().then(value => { metrics.partial_memory = value; }).catch(() => undefined);
      if (fixture && !completed) {
        metrics.shutdown = { ...await cancelActiveSessionRuns(page, fixture.session.id), runs: undefined };
        if (metrics.shutdown.status !== "stopped") metrics.cleanup_error = `Session cleanup ${metrics.shutdown.status}`;
      }
      metrics.finished_at = new Date().toISOString();
      await writeFile(testInfo.outputPath("benchmark-metrics.json"), JSON.stringify(metrics, null, 2));
      await testInfo.attach("benchmark-metrics", { path: testInfo.outputPath("benchmark-metrics.json"), contentType: "application/json" });
      if (fixture) await cleanupJourney(page, fixture);
      if (metrics.cleanup_error) throw new Error(metrics.cleanup_error);
    }
  });
}
