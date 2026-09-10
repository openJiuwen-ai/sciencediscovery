// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * NPU Broker operator journey for the 910B wiring chain. Uses the production
 * Runner CLI and HTTP adapter (dist/server.js) exactly as the API layer does:
 * list workloads, submit a smoke job, watch the workload execute, cancel a
 * long-running job, and read persisted terminal results across a restart.
 *
 * The current dev host has no Ascend driver, MindSpore or 910B card, so the
 * journey points SCIENCE_AGENT_NPU_WORKLOAD_CONFIG at a mock registry whose
 * smoke program is plain `${python}` running a deterministic mock that emits
 * the exact JSON shape `.ci/run-layer.mjs:validNpuSmoke` asserts. Every HTTP
 * route, job state and catalog persistence behaviour is the real one.
 *
 * Run from the repository root after building the Runner:
 *   node test/api/npu-broker-journey.mjs
 * Owns an ephemeral loopback port, random in-memory token and ignored .tmp data.
 * No LLM/MCP/search/package service, external credentials or external network.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RunnerClient } from "../../packages/executor/dist/runner-client.js";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim());
const root = resolve(".tmp", `npu-broker-journey-${randomUUID()}`);
const dataDir = resolve(root, "data");
await mkdir(root, { recursive: true });
const token = randomUUID();
const sessionId = "journey-npu-session";
const workspaceRoot = resolve(dataDir, "projects", "npu", "journey");
const steps = [];
let child;
let client;
let origin;
let serviceLog = "";
let mockDir;
let mockWorkloadConfig;
let mockSmoke;
const redact = (value) => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
async function until(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the NPU job to reach the documented state");
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function step(name, expectation, operation) {
  try {
    const actual = await operation();
    steps.push({ name, expectation, actual: actual ?? "PASS", result: "PASS" });
  } catch (error) {
    steps.push({ name, expectation, actual: redact(error.stack ?? error), result: "FAIL" });
    throw error;
  }
}
async function start(extraEnv = {}) {
  origin = undefined;
  child = spawn(process.execPath, ["services/runner/dist/server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, TMPDIR: root,
      SCIENCE_AGENT_DATA_DIR: dataDir, SCIENCE_AGENT_RUNNER_PORT: "0",
      SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_TOKEN: token,
      SCIENCE_AGENT_NPU_BROKER: "1", SCIENTIFIC_ENVS: "0",
      ...extraEnv,
    },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    serviceLog += redact(chunk.toString());
    const match = chunk.toString().match(/runner listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) origin = match[1];
  });
  await until(() => {
    if (child.exitCode !== null) throw new Error(`Runner exited before readiness: ${serviceLog}`);
    return Boolean(origin);
  });
  client = new RunnerClient(origin, token);
  assert.equal((await client.health()).status, "ok");
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await exited;
}
let outcome = "FAIL";
try {
  mockDir = await mkdtemp(join(tmpdir(), "npu-mock-"));
  mockSmoke = resolve(mockDir, "npu-smoke-mock.py");
  await writeFile(mockSmoke, [
    "import json",
    "print(json.dumps({",
    '    "ok": True,',
    '    "device_target": "Ascend",',
    '    "result": [4, 4, 4],',
    "}, sort_keys=True))",
    "",
  ].join("\n"));
  mockWorkloadConfig = resolve(mockDir, "npu-workloads.mock.json");
  await writeFile(mockWorkloadConfig, JSON.stringify({
    workloads: [
      {
        description: "Run a fixed host MindSpore Ascend tensor probe (mock: plain python).",
        id: "npu.smoke_test",
        label: "Ascend NPU smoke test",
        phase: "builtin",
        command: {
          program: "${python}",
          args: [
            "${env:SCIENCE_AGENT_NPU_SMOKE_SCRIPT:-repo:services/runner/workloads/npu-smoke-test.py}",
            "${workspaceRoot}",
          ],
        },
      },
      {
        description: "Long-running placeholder to exercise the cancel path.",
        id: "npu.slow_test",
        label: "Slow NPU placeholder",
        phase: "builtin",
        command: { program: "sleep", args: ["30"] },
      },
      {
        description: "Run the configured Protenix antibody pipeline entrypoint on the host NPU.",
        id: "antibody.protenix.v1",
        label: "Antibody Protenix pipeline",
        phase: "builtin",
        command: {
          program: "${python}",
          args: [
            "${repo:services/runner/workloads/antibody-manager-adapter.py}",
            "${env:SCIENCE_AGENT_NPU_PROTENIX_SCRIPT}",
            "${input:configPath}",
            "${workspaceRoot}",
          ],
        },
        rejectAf3Intent: true,
      },
    ],
  }, null, 2));
  await mkdir(workspaceRoot, { recursive: true });
  const brokerEnv = { SCIENCE_AGENT_NPU_SMOKE_SCRIPT: mockSmoke, SCIENCE_AGENT_NPU_WORKLOAD_CONFIG: mockWorkloadConfig };
  await step("启动带 NPU Broker 的生产 Runner", "生产 CLI 在独立回环端口就绪；/health 显示 npuBroker.enabled=true 且 smoke workload 可见。", async () => {
    await start(brokerEnv);
    const health = await client.health();
    assert.equal(health.npuBroker.enabled, true);
    assert.ok(health.npuBroker.workloads.some((w) => w.id === "npu.smoke_test"));
    return `Runner health OK; ${origin}; broker enabled; smoke workload listed`;
  });
  await step("读取 NPU 工作负载注册表", "GET /npu/workloads 返回 npu.smoke_test、npu.slow_test 与 antibody.protenix.v1，带阶段与必填输入。", async () => {
    const workloads = await client.listNpuWorkloads();
    assert.ok(workloads.some((w) => w.id === "npu.smoke_test" && w.phase === "builtin"));
    assert.ok(workloads.some((w) => w.id === "npu.slow_test" && w.phase === "builtin"));
    assert.ok(workloads.some((w) => w.id === "antibody.protenix.v1" && w.requiredInputs?.includes("configPath")));
    return `workloads=${workloads.map((w) => w.id).join(", ")}`;
  });
  await step("提交 NPU 冒烟作业", "POST /npu/jobs 带 sessionId/workspaceRoot 立即返回 queued 作业；session_id 隔离在列表生效。", async () => {
    const submitted = await client.submitNpuJob({ sessionId, workloadId: "npu.smoke_test", workspaceRoot });
    assert.equal(submitted.state, "queued");
    assert.equal(submitted.workloadId, "npu.smoke_test");
    assert.ok(submitted.id);
    const mine = await client.listNpuJobs(sessionId);
    assert.ok(mine.some((j) => j.id === submitted.id));
    const others = await client.listNpuJobs("other-session");
    assert.equal(others.some((j) => j.id === submitted.id), false);
    return `job=${submitted.id} state=queued; visible only to its session`;
  });
  await step("观察冒烟负载执行到成功", "作业从 queued→running→succeeded；日志包含 mock 冒烟 JSON；结果 device_target=Ascend 且 result=[4,4,4]。", async () => {
    const jobs = await client.listNpuJobs(sessionId);
    const job = jobs.find((j) => j.workloadId === "npu.smoke_test");
    assert.ok(job);
    await until(async () => (await client.getNpuJob(job.id, sessionId)).state === "succeeded", 15_000);
    const logs = await client.npuJobLogs(job.id, sessionId);
    assert.match(logs.stdout, /"ok":\s*true/);
    const result = await client.npuJobResult(job.id, sessionId);
    assert.equal(result.job.state, "succeeded");
    assert.equal(result.job.exitCode, 0);
    return `state=succeeded exit=0; stdout has ok:true; result persisted`;
  });
  await step("重启 Runner 后目录仍持久化", "作业目录 jobs.json 保留；重启后同一 session 仍能读回 succeeded 状态与日志。", async () => {
    const jobs = await client.listNpuJobs(sessionId);
    const job = jobs.find((j) => j.workloadId === "npu.smoke_test");
    await stop();
    await start(brokerEnv);
    const again = await client.getNpuJob(job.id, sessionId);
    assert.equal(again.state, "succeeded");
    assert.match((await client.npuJobLogs(job.id, sessionId)).stdout, /"ok":\s*true/);
    return "catalog persisted across restart; state and logs readable";
  });
  await step("提交长期 NPU 作业并取消", "慢作业提交后进入 running；POST /npu/jobs/:id/cancel 带 sessionId 使其最终进入 cancelled。", async () => {
    const longRunning = await client.submitNpuJob({ sessionId, workloadId: "npu.slow_test", workspaceRoot });
    await until(async () => (await client.getNpuJob(longRunning.id, sessionId)).state === "running");
    await client.cancelNpuJob(longRunning.id, sessionId);
    await until(async () => (await client.getNpuJob(longRunning.id, sessionId)).state === "cancelled");
    const after = await client.getNpuJob(longRunning.id, sessionId);
    assert.equal(after.state, "cancelled");
    return `long job ${longRunning.id} cancelled via HTTP; state=cancelled`;
  });
  await step("结果接口对非终结作业拒绝", "GET /npu/jobs/:id/result 在 running 时返回 409；对已取消作业返回完整 job 记录。", async () => {
    const running = await client.submitNpuJob({ sessionId, workloadId: "npu.slow_test", workspaceRoot });
    await until(async () => (await client.getNpuJob(running.id, sessionId)).state === "running");
    await assert.rejects(client.npuJobResult(running.id, sessionId), /not terminal/);
    await client.cancelNpuJob(running.id, sessionId);
    await until(async () => (await client.getNpuJob(running.id, sessionId)).state === "cancelled");
    const result = await client.npuJobResult(running.id, sessionId);
    assert.equal(result.job.state, "cancelled");
    return "409 while running; complete record after cancel";
  });
  await step("取消已完成的作业保持 succeeded", "对已终结作业再次 cancel 不改变状态；结果仍为 succeeded。", async () => {
    const jobs = await client.listNpuJobs(sessionId);
    const completed = jobs.find((j) => j.workloadId === "npu.smoke_test" && j.state === "succeeded");
    assert.ok(completed);
    const after = await client.cancelNpuJob(completed.id, sessionId);
    assert.equal(after.state, "succeeded");
    const result = await client.npuJobResult(completed.id, sessionId);
    assert.equal(result.job.state, "succeeded");
    return "idempotent cancel; terminal state preserved";
  });
  outcome = "PASS";
} catch (error) {
  process.exitCode = 1;
  console.error(redact(error.stack ?? error.message));
} finally {
  await stop();
  await writeFile(resolve(root, "report.md"), [
    "# NPU Broker operator journey", "", `Result: ${outcome}`, `Commit: ${sha}${dirty ? " (worktree has uncommitted changes)" : ""}`, "",
    "Invocation: `node test/api/npu-broker-journey.mjs` (repository root).",
    "Scope: production Runner CLI + HTTP NPU broker controls. Uses a deterministic mock smoke script and mock workload registry because this host has no Ascend 910B driver or MindSpore.",
    "Isolation: own loopback port, temporary data, in-memory credential; no model/MCP/package/network side effects.", "",
    ...steps.flatMap((entry, i) => [`## ${i + 1}. ${entry.name}`, "", `Expected: ${entry.expectation}`, `Actual: ${redact(entry.actual)}`, `Result: ${entry.result}`, ""]),
    "## Service evidence", "", "```text", serviceLog, "```", "",
  ].join("\n"));
  await rm(dataDir, { recursive: true, force: true });
  if (mockDir) await rm(mockDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`${outcome}: ${steps.filter((entry) => entry.result === "PASS").length}/${steps.length} steps; report saved under .tmp/npu-broker-journey-*/report.md`);
}
