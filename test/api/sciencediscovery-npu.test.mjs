// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * E2E-META
 * Purpose: Verify that ScienceDiscovery invokes an Ascend NPU through the antibody-design Skill and receives a committed managed execution and synced outputs.
 * Steps:
 *   1. Verify the prepared Session, Skill, selected Runner/card and environment.
 *   2. Submit one uniquely named short antibody-design request.
 *   3. Observe the same managed NPU execution through to a committed zero-exit receipt.
 *   4. Verify the transferred and declared screening results.
 * Environment: Explicit opt-in, Linux API stack with JiuwenSwarm, a connected usable Ascend Runner, preinstalled antibody model assets and prepared inputs.
 * Type: real hardware; collected but deselected by shared CI (npu:required, model:real, status:external).
 * LLM: Session's configured live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: ScienceDiscovery's JiuwenSwarm tool bridge.
 * OtherExternal: Remote Ascend Runner and model assets.
 * Credentials: SCIENCEDISCOVERY_NPU_E2E_TOKEN; never printed.
 * CostSideEffects: one unique remote model run and its output files; no automatic deletion.
 * Run: SCIENCEDISCOVERY_NPU_E2E_ENABLE=1 SCIENCEDISCOVERY_NPU_E2E_API=... SCIENCEDISCOVERY_NPU_E2E_TOKEN=... SCIENCEDISCOVERY_NPU_E2E_SESSION=... SCIENCEDISCOVERY_NPU_E2E_RUNNER=... SCIENCEDISCOVERY_NPU_E2E_ENVIRONMENT=... SCIENCEDISCOVERY_NPU_E2E_SHA=... node --test test/api/sciencediscovery-npu.test.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTest } from "../support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:e2e", "os:linux", "arch:amd64", "npu:required", "model:real", "status:external"],
});

const env = process.env;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("ScienceDiscovery completes one antibody-design NPU invocation with a committed receipt and synced outputs", async () => {
  const startedAt = new Date().toISOString();
  const steps = [];
  let phase = "1. Verify prepared NPU Session and Runner";
  let verdict = "PASS";
  let runId = "not submitted";
  let executionId = "not observed";
  let runName = `antibody-design-npu-e2e-${randomUUID().slice(0, 8)}`;
  let failure = "none";
  try {
  assert.equal(env.SCIENCEDISCOVERY_NPU_E2E_ENABLE, "1", "Real NPU E2E requires explicit opt-in");
  const required = ["API", "TOKEN", "SESSION", "RUNNER", "ENVIRONMENT", "SHA"];
  for (const name of required) assert.ok(env[`SCIENCEDISCOVERY_NPU_E2E_${name}`], `Missing SCIENCEDISCOVERY_NPU_E2E_${name}`);
  const api = env.SCIENCEDISCOVERY_NPU_E2E_API.replace(/\/$/, "");
  const sessionId = env.SCIENCEDISCOVERY_NPU_E2E_SESSION;
  const runnerId = env.SCIENCEDISCOVERY_NPU_E2E_RUNNER;
  const environmentId = env.SCIENCEDISCOVERY_NPU_E2E_ENVIRONMENT;
  const token = env.SCIENCEDISCOVERY_NPU_E2E_TOKEN;
  const request = async (path, body) => {
    const response = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const content = await response.text();
    assert.ok(response.ok, `${path}: HTTP ${response.status}: ${content.slice(0, 500)}`);
    return JSON.parse(content);
  };
  const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const health = await request("/health");
  assert.equal(health.status, "ok", "API stack must be healthy before submitting an NPU run");
  const skillCatalog = await request("/api/skills");
  assert.ok(JSON.stringify(skillCatalog).includes('"antibody-design"'), "antibody-design Skill must be loaded");
  await request(sessionPath);
  const runner = await request(`/api/runners/${encodeURIComponent(runnerId)}`);
  assert.equal(runner.runnerStatus?.state, "ready", "Selected remote NPU Runner must be connected before submission");
  const bindings = await request(`/api/runners/${encodeURIComponent(runnerId)}/workspaces`);
  assert.ok(bindings.some((entry) => entry.sessionId === sessionId), "Session must have a workspace on the selected Runner");
  const npu = await request("/api/runners/npu");
  assert.ok(npu.selections?.[runnerId]?.length, "Runner must have an explicitly selected NPU card");
  steps.push("1. PASS — prepared Skill, Session workspace and selected NPU card are available.");
  phase = "2. Submit a unique antibody-design request";
  // An explicit existing Run ID is for resuming observation after a test-driver
  // failure. It never submits the NPU command a second time.
  const resumeRunId = env.SCIENCEDISCOVERY_NPU_E2E_RUN_ID;
  const prompt = [
    "Use the installed antibody-design Skill, not antibody-protenix-pipeline or run_npu_job.",
    `Use Runner ${runnerId} and managed environment ${environmentId}; do not install or download dependencies.`,
    "Inputs: antibody_pipeline/inputs/target_antigen.pdb and antibody_pipeline/inputs/antibody_framework.pdb; hotspots [A45,A46,A49].",
    `Create a fresh config with run_name=${runName}, num_designs=1, npus=0, workers_per_npu=1,`,
    "protenix_use_msa=false, protenix_n_sample=1, protenix_seeds=42, diffuser_t=15, final_step=1, force=false.",
    "Validate the config, then submit run_sandbox_pipeline.sh exactly once as a background run_shell command.",
    "Do not retry an accepted or unknown execution. Wait for the SAME managed Execution ID to finish.",
    "Only after completed/committed/exitCode=0, pull its screening report and summary CSV to the Session workspace and declare them as artifacts.",
    "Report the managed Execution ID, provenance, exitCode, and synced file paths.",
  ].join(" ");
  const submitted = resumeRunId
    ? await request(`${sessionPath}/runs/${encodeURIComponent(resumeRunId)}`)
    : await request(`${sessionPath}/runs`, { content: prompt });
  assert.ok(submitted.id, "Agent Run submission must return an ID");
  runId = submitted.id;
  if (resumeRunId) {
    assert.equal(submitted.id, resumeRunId);
    const match = submitted.prompt?.match(/antibody-design-npu-e2e-[a-f0-9]{8}/u);
    assert.ok(match, "Existing Run prompt must contain its unique NPU test run name");
    runName = match[0];
  }
  steps.push(`2. PASS — Agent Run ${runId} accepted for ${runName}${resumeRunId ? " (observation resumed)" : ""}.`);
  phase = "3. Observe the same managed NPU execution";
  const actualRunDir = `antibody_pipeline/runs/${runName}`;
  const deadline = Date.now() + 45 * 60_000;
  const expected = [
    `${actualRunDir}/05_screening/protenix_screening_report.md`,
    `${actualRunDir}/05_screening/protenix_screening_summary.csv`,
  ];
  const outputs = new Map();
  const executionOutput = async (execution) => {
    const saved = outputs.get(execution.id) ?? { cursor: 0, text: "", terminal: false };
    if (saved.terminal) return saved.text;
    for (let page = 0; page < 200; page++) {
      const logs = await request(`${sessionPath}/agent-activity/executions/${execution.id}/logs?cursor=${saved.cursor}`);
      if (!logs.chunks.length) break;
      assert.ok(logs.nextCursor > saved.cursor, `Log cursor did not advance for ${execution.id}`);
      saved.text += logs.chunks.map((chunk) => chunk.text).join("");
      saved.cursor = logs.nextCursor;
    }
    saved.terminal = ["completed", "failed", "cancelled", "unknown"].includes(execution.state);
    outputs.set(execution.id, saved);
    return saved.text;
  };
  let run, activity, pipeline, synced = false;
  while (Date.now() < deadline) {
    [run, activity] = await Promise.all([
      request(`${sessionPath}/runs/${submitted.id}`),
      request(`${sessionPath}/agent-activity`),
    ]);
    const executions = activity.executions.filter((entry) => entry.turnId === submitted.id);
    assert.ok(!executions.some((entry) => entry.state === "unknown"), "Unknown managed execution is an E2E failure; do not infer success from remote files");
    assert.notEqual(run.status, "failed", `Agent Run failed: ${run.error ?? "unknown error"}`);
    // Probes and config validation may also be run_shell calls. The actual
    // pipeline is the one whose retained logs mention this unique run name.
    for (const execution of executions) {
      const output = await executionOutput(execution);
      if (execution.state === "failed") {
        const expectedAbsentDirectory = output.trim().endsWith(`ls: cannot access '${actualRunDir}': No such file or directory`);
        assert.ok(expectedAbsentDirectory && execution.provenance === "committed",
          `Unexpected failed managed Execution ${execution.id}`);
      }
      assert.notEqual(execution.state, "cancelled", `Managed Execution ${execution.id} was cancelled`);
      if (pipeline?.id === execution.id ||
        (!pipeline && output.includes("Launching sandbox pipeline:") && output.includes(runName))) pipeline = execution;
      if (pipeline) executionId = pipeline.id;
    }
    assert.ok(run.status !== "completed" || pipeline,
      `Agent Run completed without a managed NPU pipeline Execution for ${runName}`);
    if (pipeline?.state === "completed" && pipeline.provenance === "committed" && run.status === "completed") {
      const local = await request(`${sessionPath}/files`);
      synced = expected.every((path) => local.some((file) => file.path === path));
      if (synced) break;
    }
    await sleep(10_000);
  }
  assert.ok(pipeline, `No managed NPU pipeline Execution observed for ${runName}`);
  assert.equal(pipeline.state, "completed", `Pipeline Execution ${pipeline.id} did not complete`);
  assert.equal(pipeline.provenance, "committed", "Runner completion must have committed provenance");
  assert.equal(run.status, "completed", "Agent Run must complete normally");
  assert.ok(synced, "Output files were not synced to the Session workspace before the deadline");
  steps.push(`3. PASS — managed Execution ${pipeline.id} and Agent Run completed; outputs reached the Session.`);
  phase = "4. Verify remote, local and declared outputs";
  const pipelineOutput = await executionOutput(pipeline);
  assert.ok(pipelineOutput.includes("/skills/antibody-design/scripts/run_full_antibody_pipeline.sh"),
    "Pipeline must have used the preserved antibody-design Skill, not the branch's replacement Skill");
  const executionRuns = await request(`${sessionPath}/execution-runs`);
  assert.equal(executionRuns.find((entry) => entry.executionId === pipeline.id || entry.id === pipeline.id)?.exitCode, 0,
    "The same managed pipeline Execution must have exitCode=0");
  const remote = await request(`/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(sessionId)}/files`);
  const local = await request(`${sessionPath}/files`);
  const artifacts = await request(`${sessionPath}/artifacts`);
  for (const path of expected) {
    assert.ok(remote.files.find((file) => file.path === path)?.size > 0, `Missing or empty remote output ${path}`);
    assert.ok(local.find((file) => file.path === path)?.size > 0, `Output was not synced to Session workspace: ${path}`);
    assert.ok(
      artifacts.some((artifact) => artifact.origin === "llm_declared"
        && artifact.originMeta?.declaredPath === path && artifact.currentVersion >= 1),
      `Output was not declared as an Artifact from the synced path: ${path}`,
    );
  }
  const transferred = new Set(activity.transfers.filter((entry) => entry.state === "completed")
    .flatMap((entry) => entry.files?.map((file) => file.targetPath) ?? []));
  for (const path of expected) assert.ok(transferred.has(path), `No completed transfer recorded for ${path}`);
  steps.push("4. PASS — report and CSV are nonempty remotely and locally, transferred and declared as Artifacts.");
  } catch (error) {
    verdict = phase.startsWith("1.") ? "BLOCKED" : "FAIL";
    failure = String(error?.message ?? error).replaceAll(env.SCIENCEDISCOVERY_NPU_E2E_TOKEN ?? "<never>", "[REDACTED]");
    steps.push(`${phase}: FAIL — ${failure}`);
    throw error;
  } finally {
    const reportRoot = resolve(env.SCIENCEDISCOVERY_NPU_E2E_REPORT_DIR ?? ".test-runs/npu-e2e");
    const reportDir = join(reportRoot, runName);
    const report = [
      `# ScienceDiscovery NPU E2E — ${verdict}`,
      "",
      `- Started: ${startedAt}`,
      `- Ended: ${new Date().toISOString()}`,
      `- Target SHA (operator supplied): ${env.SCIENCEDISCOVERY_NPU_E2E_SHA ?? "missing"}`,
      `- Stack command: ./scripts/start-stack.sh --mode local (or documented equivalent)`,
      `- Driver command: node --test test/api/sciencediscovery-npu.test.mjs`,
      `- Health: ${steps.some((entry) => entry.startsWith("1. PASS")) ? "ok" : "not verified"}`,
      `- Interface: JiuwenSwarm Session Runs API → antibody-design Skill → remote managed Runner`,
      `- API: ${env.SCIENCEDISCOVERY_NPU_E2E_API ?? "missing"}`,
      `- Session: ${env.SCIENCEDISCOVERY_NPU_E2E_SESSION ?? "missing"}`,
      `- Runner: ${env.SCIENCEDISCOVERY_NPU_E2E_RUNNER ?? "missing"}`,
      `- Run: ${runId}`,
      `- Execution: ${executionId}`,
      `- Expected: committed exit 0, completed Agent Run, nonempty synced and declared screening report/CSV`,
      `- Actual: ${failure === "none" ? "all assertions passed" : failure}`,
      `- Count: ${verdict === "PASS" ? "1 passed / 0 failed / 0 blocked / 0 skipped" : verdict === "BLOCKED" ? "0 passed / 0 failed / 1 blocked / 0 skipped" : "0 passed / 1 failed / 0 blocked / 0 skipped"}`,
      "",
      "## User steps",
      "",
      ...steps.map((entry) => `- ${entry}`),
      "",
      "Outputs are intentionally retained in the prepared Session for inspection; this driver never replays an accepted or unknown NPU execution.",
      "",
    ].join("\n");
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, "report.md"), report, "utf8");
  }
});
