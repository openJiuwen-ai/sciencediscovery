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
 * Purpose: A user's antibody-design request makes the real JiuwenSwarm Agent load the Skill, prepare a fresh remote Session, run all NPU stages, and deliver usable results.
 * Steps:
 *   1. Create a Project/Session, select the live model and Ascend Runner, and upload the user's two PDBs.
 *   2. Submit a scientific goal without prescribing an environment, script, tool calls, or prepared model assets.
 *   3. Observe the Agent's Skill load, input sync, environment selection, preparation, validation, and one managed NPU pipeline across any automatic wake Runs.
 *   4. Verify committed zero-exit executions, all model stages, remote-to-local transfer, declared report/CSV/CIF, and the Agent's final answer.
 * Environment: Explicit opt-in, running JiuwenSwarm product stack, connected selected Ascend Runner, sandbox domain allowlist, live model, two operator-provided PDBs. The test creates a fresh Session and does not preseed model assets or select a Python environment.
 * Type: real hardware; collected but deselected by shared CI (npu:required, model:real, status:external).
 * LLM: Operator-selected live model; output and tool ordering are nondeterministic.
 * WebSearch: none
 * PaperSources: none
 * MCP: ScienceDiscovery's JiuwenSwarm tool bridge.
 * OtherExternal: Remote Ascend Runner, pinned model downloads, package sources, and NPU inference.
 * Credentials: SCIENCEDISCOVERY_NPU_E2E_TOKEN; never printed.
 * CostSideEffects: billable model tokens, downloads and package installs, one unique remote NPU run; Project, Session and results are retained for inspection.
 * Run: SCIENCEDISCOVERY_NPU_E2E_ENABLE=1 SCIENCEDISCOVERY_NPU_E2E_API=... SCIENCEDISCOVERY_NPU_E2E_TOKEN=... SCIENCEDISCOVERY_NPU_E2E_MODEL_ID=... SCIENCEDISCOVERY_NPU_E2E_RUNNER=... SCIENCEDISCOVERY_NPU_E2E_ANTIGEN_PDB=... SCIENCEDISCOVERY_NPU_E2E_FRAMEWORK_PDB=... SCIENCEDISCOVERY_NPU_E2E_HOTSPOTS='[A45,A46,A49]' SCIENCEDISCOVERY_NPU_E2E_SHA=... node --test test/api/sciencediscovery-npu.test.mjs
 * Resume: Set SCIENCEDISCOVERY_NPU_E2E_SESSION and SCIENCEDISCOVERY_NPU_E2E_RUN_ID together to observe an accepted run without submitting another one.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createTest } from "../support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:e2e", "os:linux", "arch:amd64", "npu:required", "model:real", "status:external"],
});

const env = process.env;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const terminalRuns = new Set(["completed", "failed", "cancelled", "interrupted"]);
const requiredDomains = ["gitcode.com", "gitee.com", "tools.mindspore.cn", "af3-dev.tos-cn-beijing.volces.com"];

function redact(value) {
  return String(value).replaceAll(env.SCIENCEDISCOVERY_NPU_E2E_TOKEN || "<unset-token>", "[REDACTED]");
}

function toolArguments(trace) {
  if (trace.args && typeof trace.args === "object") return trace.args;
  try { return JSON.parse(trace.input ?? "{}"); } catch { return {}; }
}

function callText(call) {
  return JSON.stringify(call.args ?? {});
}

function pipelineScript(call) {
  return call.name === "run_shell"
    && call.args?.scriptPath?.includes("antibody-design/scripts/run_sandbox_pipeline.sh");
}

test("a real Agent autonomously completes the antibody-design Skill on an Ascend NPU", async () => {
  const startedAt = new Date().toISOString();
  const steps = [];
  const reportName = `antibody-design-agent-e2e-${randomUUID().slice(0, 8)}`;
  const reportDir = join(resolve(env.SCIENCEDISCOVERY_NPU_E2E_REPORT_DIR ?? ".test-runs/npu-e2e"), reportName);
  let phase = "1. Prepare a fresh user Session";
  let verdict = "PASS";
  let failure = "none";
  let projectId = "not created";
  let sessionId = "not created";
  let initialRunId = "not submitted";
  let pipelineId = "not observed";
  let runName = reportName;
  let observedCalls = [];
  let observedRuns = [];
  try {
    assert.equal(env.SCIENCEDISCOVERY_NPU_E2E_ENABLE, "1", "Real NPU E2E requires explicit opt-in");
    for (const name of ["API", "TOKEN", "MODEL_ID", "RUNNER", "SHA"]) {
      assert.ok(env[`SCIENCEDISCOVERY_NPU_E2E_${name}`], `Missing SCIENCEDISCOVERY_NPU_E2E_${name}`);
    }
    const resume = Boolean(env.SCIENCEDISCOVERY_NPU_E2E_RUN_ID || env.SCIENCEDISCOVERY_NPU_E2E_SESSION);
    assert.equal(Boolean(env.SCIENCEDISCOVERY_NPU_E2E_RUN_ID), Boolean(env.SCIENCEDISCOVERY_NPU_E2E_SESSION),
      "Resume requires both SCIENCEDISCOVERY_NPU_E2E_SESSION and SCIENCEDISCOVERY_NPU_E2E_RUN_ID");
    if (!resume) {
      for (const name of ["ANTIGEN_PDB", "FRAMEWORK_PDB", "HOTSPOTS"]) {
        assert.ok(env[`SCIENCEDISCOVERY_NPU_E2E_${name}`], `Missing SCIENCEDISCOVERY_NPU_E2E_${name}`);
      }
    }
    const api = env.SCIENCEDISCOVERY_NPU_E2E_API.replace(/\/$/, "");
    const runnerId = env.SCIENCEDISCOVERY_NPU_E2E_RUNNER;
    const modelId = env.SCIENCEDISCOVERY_NPU_E2E_MODEL_ID;
    const request = async (method, path, body) => {
      const response = await fetch(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${env.SCIENCEDISCOVERY_NPU_E2E_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const content = await response.text();
      assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}: ${redact(content.slice(0, 500))}`);
      return content ? JSON.parse(content) : undefined;
    };
    const get = (path) => request("GET", path);
    const post = (path, body) => request("POST", path, body);
    const health = await get("/health");
    assert.equal(health.status, "ok", "The real product API must be healthy");
    const skills = await get("/api/skills");
    assert.ok(JSON.stringify(skills).includes('"antibody-design"'), "The antibody-design Skill must be installed");
    const models = await get("/api/models");
    assert.ok(models.some((model) => model.id === modelId), "The selected live model must exist in the product registry");
    const runner = await get(`/api/runners/${encodeURIComponent(runnerId)}`);
    assert.equal(runner.runnerStatus?.state, "ready", "The Ascend Runner must be connected");
    const npu = await get("/api/runners/npu");
    assert.ok(npu.selections?.[runnerId]?.length, "The Runner must have an explicitly selected sandbox-usable NPU");
    const network = await get("/api/sandbox-network-settings");
    assert.equal(network.mode, "domain-allowlist", "First-use model preparation requires a sandbox domain allowlist");
    for (const domain of requiredDomains) assert.ok(network.allowedDomains.includes(domain), `Missing sandbox domain ${domain}`);

    if (resume) {
      sessionId = env.SCIENCEDISCOVERY_NPU_E2E_SESSION;
      initialRunId = env.SCIENCEDISCOVERY_NPU_E2E_RUN_ID;
      const session = await get(`/api/sessions/${encodeURIComponent(sessionId)}`);
      projectId = session.projectId;
      const run = await get(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(initialRunId)}`);
      assert.ok(run.prompt.includes("antibody-design"), "The resumed Run must be an antibody-design user request");
      const foundName = run.prompt.match(/antibody-design-agent-e2e-[a-f0-9]{8}/u);
      assert.ok(foundName, "The resumed Run must contain its unique test run name");
      runName = foundName[0];
      steps.push(`1. PASS — resumed inspection of Project ${projectId}, Session ${sessionId}, selected Runner and Skill.`);
      steps.push(`2. PASS — resumed existing Agent Run ${initialRunId}; no second user request was submitted.`);
    } else {
      const antigen = await readFile(env.SCIENCEDISCOVERY_NPU_E2E_ANTIGEN_PDB, "utf8");
      const framework = await readFile(env.SCIENCEDISCOVERY_NPU_E2E_FRAMEWORK_PDB, "utf8");
      assert.ok(antigen.includes("ATOM") && framework.includes("ATOM"), "Both user-provided inputs must be PDB files");
      const antigenCa = new Set(antigen.split(/\r?\n/u)
        .filter((line) => line.startsWith("ATOM") && line.slice(12, 16).trim() === "CA")
        .map((line) => `${line.slice(21, 22)}${Number(line.slice(22, 26))}`));
      const hotspots = env.SCIENCEDISCOVERY_NPU_E2E_HOTSPOTS.replaceAll(/[\[\]\s]/gu, "").split(",");
      assert.ok(hotspots.length && hotspots.every((hotspot) => antigenCa.has(hotspot)),
        "Every supplied hotspot must name a CA residue in the antigen PDB");
      const created = await post("/api/projects", { name: reportName });
      projectId = (created.project ?? created).id;
      sessionId = created.firstSession.id;
      const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
      const configured = await request("PATCH", sessionPath, {
        title: reportName,
        modelId,
        remoteRunnerHostIds: [runnerId],
        skillSelectionMode: "selected",
        enabledSkillIds: ["antibody-design"],
      });
      // JiuwenSwarm exposes its shared Skill catalog to every Session, even when
      // the stored Session selection requests one Skill. Verify availability here;
      // the tool trace below proves which Skill the Agent actually loaded.
      assert.ok(configured.enabledSkillIds.includes("antibody-design"), "The intended Skill must be available to the Agent");
      const approved = await request("PATCH", sessionPath, { approvalMode: "always_allow" });
      assert.equal(approved.approvalMode, "always_allow", "The fresh Session must allow autonomous Skill execution");
      for (const [path, content] of [
        ["antibody_pipeline/inputs/target_antigen.pdb", antigen],
        ["antibody_pipeline/inputs/antibody_framework.pdb", framework],
      ]) await post(`${sessionPath}/files`, { path, content });
      const workspaces = await get(`/api/runners/${encodeURIComponent(runnerId)}/workspaces`);
      const existing = workspaces.find((entry) => entry.sessionId === sessionId);
      if (existing) {
        const files = await get(`/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(sessionId)}/files`);
        assert.ok(!files.files.some((file) => file.path.startsWith("antibody_pipeline/models/")),
          "The fresh remote Session must not be seeded with model assets");
      }
      steps.push(`1. PASS — created Project ${projectId} and fresh Session ${sessionId}; selected live model, Skill and NPU Runner; uploaded ${basename(env.SCIENCEDISCOVERY_NPU_E2E_ANTIGEN_PDB)} and ${basename(env.SCIENCEDISCOVERY_NPU_E2E_FRAMEWORK_PDB)}.`);
      phase = "2. Ask the Agent to perform the whole Skill";
      const prompt = [
        "请使用当前会话启用的 antibody-design Skill，在已授权的 Ascend NPU Runner 上完成一次真实抗体设计。",
        "目标抗原和抗体骨架已上传为 antibody_pipeline/inputs/target_antigen.pdb 与 antibody_pipeline/inputs/antibody_framework.pdb。",
        `抗原热点为 ${env.SCIENCEDISCOVERY_NPU_E2E_HOTSPOTS}，设计数量为 1，运行名称为 ${runName}。`,
        "使用完整参数 diffuser_t=200、final_step=160。请按 Skill 自行检查输入与设备、选择或建立合适的托管环境、准备首次运行资源、校验并完成 RFdiffusion、ProteinMPNN、Protenix 和筛选。",
        "结束后请将筛选报告、汇总 CSV 和一份预测结构 CIF 交付到当前会话的产物中，并说明结果。",
        "如果已经受理某个后台执行，不要因等待或连接问题重复提交；不能核实终态与产物时请如实说明。",
      ].join(" ");
      const submitted = await post(`${sessionPath}/runs`, { content: prompt });
      initialRunId = submitted.id;
      assert.ok(initialRunId, "A user request must create an Agent Run");
      steps.push(`2. PASS — submitted one natural-language request as Agent Run ${initialRunId}; no environment, script or model assets were preselected.`);
    }

    phase = "3. Observe the Agent's complete Skill journey";
    const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const cursors = new Map();
    const calls = new Map();
    const deadline = Date.now() + 120 * 60_000;
    const runDir = `antibody_pipeline/runs/${runName}`;
    const reportPath = `${runDir}/05_screening/protenix_screening_report.md`;
    const csvPath = `${runDir}/05_screening/protenix_screening_summary.csv`;
    let activity = { executions: [], transfers: [] };
    let executionRuns = [];
    let runs = [];
    let artifacts = [];
    let localFiles = [];
    let lastProgress = 0;
    let idleSince = 0;
    while (Date.now() < deadline) {
      [runs, activity, executionRuns, artifacts, localFiles] = await Promise.all([
        get(`${sessionPath}/runs`),
        get(`${sessionPath}/agent-activity`),
        get(`${sessionPath}/execution-runs`),
        get(`${sessionPath}/artifacts`),
        get(`${sessionPath}/files`),
      ]);
      assert.ok(runs.some((run) => run.id === initialRunId), "The original user Run must remain queryable");
      assert.ok(!runs.some((run) => ["failed", "cancelled", "interrupted"].includes(run.status)),
        `Agent Run failed: ${redact(JSON.stringify(runs.map(({ id, status, error }) => ({ id, status, error }))))}`);
      for (const run of runs) {
        const events = await get(`${sessionPath}/runs/${encodeURIComponent(run.id)}/events?after=${cursors.get(run.id) ?? 0}`);
        for (const item of events) {
          cursors.set(run.id, item.sequence);
          const { event } = item;
          if (event.type === "tool.started" && event.trace) {
            calls.set(`${run.id}:${event.trace.id}`, {
              runId: run.id, id: event.trace.id, name: event.trace.name,
              args: toolArguments(event.trace), status: "started",
            });
          } else if (event.type === "tool.completed" && event.trace) {
            const key = `${run.id}:${event.trace.id}`;
            calls.set(key, { ...(calls.get(key) ?? { runId: run.id, id: event.trace.id, name: event.trace.name, args: {} }), status: event.trace.status });
          }
        }
      }
      const callList = [...calls.values()];
      const pipelineCalls = callList.filter((call) => pipelineScript(call)
        && !callText(call).includes("--prepare-only") && !callText(call).includes("--validate-only"));
      assert.ok(pipelineCalls.length <= 1, `The Agent submitted the NPU pipeline ${pipelineCalls.length} times`);
      const pipelineCall = pipelineCalls[0];
      const pipelineReceipt = pipelineCall && executionRuns.find((entry) => entry.toolCallId === pipelineCall.id);
      const pipeline = pipelineReceipt && activity.executions.find((entry) => entry.id === pipelineReceipt.id);
      if (pipeline) pipelineId = pipeline.id;
      const delivered = [reportPath, csvPath].every((path) => localFiles.some((file) => file.path === path && file.size > 0))
        && artifacts.some((artifact) => artifact.origin === "llm_declared" && artifact.originMeta?.declaredPath === reportPath)
        && artifacts.some((artifact) => artifact.origin === "llm_declared" && artifact.originMeta?.declaredPath === csvPath);
      const cifDelivered = localFiles.some((file) => file.path.startsWith(`${runDir}/04_protenix_output/`) && file.path.endsWith(".cif") && file.size > 0)
        && artifacts.some((artifact) => artifact.origin === "llm_declared"
          && artifact.originMeta?.declaredPath?.startsWith(`${runDir}/04_protenix_output/`)
          && artifact.originMeta.declaredPath.endsWith(".cif"));
      if (pipeline?.state === "completed" && delivered && cifDelivered && runs.every((run) => terminalRuns.has(run.status))) break;
      const idle = runs.length > 0 && runs.every((run) => terminalRuns.has(run.status))
        && !activity.executions.some((execution) => ["queued", "running"].includes(execution.state));
      idleSince = idle ? (idleSince || Date.now()) : 0;
      assert.ok(!idleSince || Date.now() - idleSince < 5 * 60_000,
        "The Agent stopped making progress before completing the Skill and delivering all outputs");
      if (Date.now() - lastProgress > 60_000) {
        console.log(`NPU journey: runs=${runs.map((run) => run.status).join(",")} calls=${calls.size} executions=${activity.executions.map((entry) => entry.state).join(",")} report=${delivered} cif=${cifDelivered}`);
        lastProgress = Date.now();
      }
      await sleep(10_000);
    }
    observedCalls = [...calls.values()];
    observedRuns = runs.map(({ id, status, automaticWake }) => ({ id, status, automaticWake: Boolean(automaticWake) }));
    const matching = (name, predicate = () => true) => observedCalls.filter((call) => call.name === name && predicate(call));
    assert.ok(matching("skill_tool", (call) => callText(call).includes("antibody-design")).length
      || matching("read_skill", (call) => callText(call).includes("antibody-design")).length
      || matching("read_file", (call) => callText(call).includes("antibody-design/SKILL.md")).length,
    "The Agent must load antibody-design itself, not merely mention it in the user prompt");
    assert.ok(matching("environment_list").length, "The Agent must inspect managed environments itself");
    assert.ok(matching("sync_remote_workspace", (call) => callText(call).includes('"push"')).length,
      "The Agent must push uploaded PDBs to the remote Runner");
    assert.ok(!activity.executions.some((execution) => execution.state === "unknown"),
      "An unknown managed Execution is not an end-to-end success and must never be replayed");
    const prepare = matching("run_shell", (call) => pipelineScript(call)
      && callText(call).includes("--prepare-only"));
    const validate = matching("run_shell", (call) => pipelineScript(call)
      && callText(call).includes("--validate-only"));
    const pipelineCalls = matching("run_shell", (call) => pipelineScript(call)
      && !callText(call).includes("--prepare-only") && !callText(call).includes("--validate-only"));
    assert.equal(prepare.length, 1, "The Agent must prepare fresh Session model assets exactly once");
    assert.ok(validate.length, "The Agent must run the Skill's preflight validation");
    assert.equal(pipelineCalls.length, 1, "The Agent must submit the complete Skill pipeline exactly once");
    assert.ok(matching("sync_remote_workspace", (call) => callText(call).includes('"pull"')).length,
      "The Agent must pull outputs into the Session");
    assert.ok(matching("declare_artifact").length >= 3, "The Agent must declare report, CSV and CIF artifacts");
    const receiptFor = (call) => executionRuns.find((entry) => entry.toolCallId === call.id);
    const prepareReceipt = receiptFor(prepare[0]);
    const validateReceipt = validate.map(receiptFor).find((entry) => entry?.exitCode === 0);
    const pipelineReceipt = receiptFor(pipelineCalls[0]);
    assert.equal(prepareReceipt?.exitCode, 0, "Managed first-use preparation must exit 0");
    assert.ok(validateReceipt, "Managed preflight validation must exit 0");
    assert.equal(pipelineReceipt?.exitCode, 0, "The complete NPU pipeline must exit 0");
    assert.equal(pipelineReceipt?.runnerId, runnerId, "The NPU pipeline must use the selected remote Runner");
    assert.ok(pipelineReceipt?.environmentRevisionId, "The Agent must use a managed Python environment revision");
    const pipeline = activity.executions.find((entry) => entry.id === pipelineReceipt.id);
    assert.equal(pipeline?.state, "completed", "The same managed NPU Execution must complete");
    assert.equal(pipeline?.provenance, "committed", "The Runner receipt must have committed provenance");
    assert.ok(runs.every((run) => run.status === "completed"), "All Agent Runs, including automatic wakes, must complete");
    steps.push(`3. PASS — Agent loaded the Skill, chose a managed environment, pushed inputs, prepared model assets (Execution ${prepareReceipt.id}), validated, and completed one NPU pipeline (Execution ${pipelineReceipt.id}) across ${runs.length} Agent Run(s).`);

    phase = "4. Verify scientific results and the Agent's delivery";
    const remote = await get(`/api/runners/${encodeURIComponent(runnerId)}/workspaces/${encodeURIComponent(sessionId)}/files`);
    const remoteFiles = remote.files;
    for (const path of [reportPath, csvPath]) {
      assert.ok(remoteFiles.find((file) => file.path === path)?.size > 0, `Missing remote screening output ${path}`);
      assert.ok(localFiles.find((file) => file.path === path)?.size > 0, `Screening output was not transferred: ${path}`);
      assert.ok(artifacts.some((artifact) => artifact.origin === "llm_declared"
        && artifact.originMeta?.declaredPath === path && artifact.currentVersion >= 1),
      `Screening output was not declared as an Artifact: ${path}`);
    }
    for (const stage of ["01_rfdiffusion", "02_proteinmpnn", "03_protenix_input_json", "04_protenix_output"]) {
      assert.ok(remoteFiles.some((file) => file.path.startsWith(`${runDir}/${stage}/`) && file.size > 0),
        `Model stage ${stage} produced no remote files`);
    }
    const cif = localFiles.find((file) => file.path.startsWith(`${runDir}/04_protenix_output/`)
      && file.path.endsWith(".cif") && file.size > 0);
    assert.ok(cif, "No predicted CIF was transferred to the Session");
    assert.ok(artifacts.some((artifact) => artifact.origin === "llm_declared"
      && artifact.originMeta?.declaredPath === cif.path && artifact.currentVersion >= 1),
    "The predicted CIF was not declared as a user-visible Artifact");
    const transferred = new Set(activity.transfers.filter((entry) => entry.state === "completed")
      .flatMap((entry) => entry.files?.map((file) => file.targetPath) ?? []));
    for (const path of [reportPath, csvPath, cif.path]) assert.ok(transferred.has(path), `No completed transfer for ${path}`);
    const session = await get(sessionPath);
    assert.ok(session.messages?.some((message) => message.role === "assistant"
      && (message.content?.includes(runName) || message.content?.includes("screening"))),
    "The Agent did not explain the delivered scientific result to the user");
    steps.push(`4. PASS — all four model stages produced files; report, CSV and ${cif.path} are nonempty remotely and locally, transferred, declared and explained to the user.`);
  } catch (error) {
    verdict = phase.startsWith("1.") ? "BLOCKED" : "FAIL";
    failure = redact(error?.stack ?? error);
    steps.push(`${phase}: ${verdict} — ${failure}`);
    throw error;
  } finally {
    const report = [
      `# ScienceDiscovery full Agent antibody-design NPU journey — ${verdict}`,
      "",
      `- Started: ${startedAt}`,
      `- Ended: ${new Date().toISOString()}`,
      `- Target SHA (operator supplied): ${env.SCIENCEDISCOVERY_NPU_E2E_SHA ?? "missing"}`,
      `- Interface: user Session Runs API → real JiuwenSwarm Agent → loaded antibody-design Skill → managed remote Ascend Runner → local Artifacts`,
      `- Project: ${projectId}`,
      `- Session: ${sessionId}`,
      `- Initial user Run: ${initialRunId}`,
      `- Pipeline Execution: ${pipelineId}`,
      `- Agent Runs: ${JSON.stringify(observedRuns)}`,
      `- Agent tools: ${JSON.stringify(observedCalls.map(({ name, status }) => ({ name, status })))}`,
      `- Result: ${failure === "none" ? "all assertions passed" : failure}`,
      `- Count: ${verdict === "PASS" ? "1 passed / 0 failed / 0 blocked / 0 skipped" : verdict === "BLOCKED" ? "0 passed / 0 failed / 1 blocked / 0 skipped" : "0 passed / 1 failed / 0 blocked / 0 skipped"}`,
      "",
      "## User steps",
      "",
      ...steps.map((entry) => `- ${entry}`),
      "",
      "The test never directly calls a model script or NPU endpoint and never resubmits an accepted Agent request. Its Project and outputs remain for inspection.",
      "",
    ].join("\n");
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, "report.md"), report, "utf8");
  }
});
