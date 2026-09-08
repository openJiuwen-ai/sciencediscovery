// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Runner operator journey: submit a long-running command, observe it without
 * creating another Shell, cancel, verify the next writer and persistent result.
 * Run from the repository root AFTER building and committing the candidate:
 *   node test/api/detached-runner-journey.mjs
 * Uses the production Runner CLI and HTTP adapter, not an in-process test server.
 * No LLM/MCP/search/package service, external credentials or external network.
 * Owns an ephemeral loopback port, random in-memory token and ignored .tmp data.
 * Scientific setup is disabled; managed Python/R provisioning is NOT covered.
 * Evidence: .tmp/detached-runner-journey-<id>/report.md; data removed in finally.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RunnerClient } from "../../packages/executor/dist/runner-client.js";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) {
  throw new Error("Commit the candidate before running the journey");
}
const root = resolve(".tmp", `detached-runner-journey-${randomUUID()}`);
const dataDir = resolve(root, "data");
await mkdir(root, { recursive: true });
const token = randomUUID();
const owner = { sessionId: "journey-session", agentId: "main" };
const steps = [];
let child;
let client;
let serviceLog = "";
let origin;
let pendingUpload;
let pendingLegacy;
let captured;
const redact = (value) => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
async function until(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the documented Runner result");
    await new Promise((done) => setTimeout(done, 20));
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
async function start() {
  origin = undefined;
  child = spawn(process.execPath, ["services/runner/dist/server.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, TMPDIR: root,
      SCIENCE_AGENT_DATA_DIR: dataDir, SCIENCE_AGENT_RUNNER_PORT: "0",
      SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_TOKEN: token,
      SCIENCE_AGENT_NPU_BROKER: "0", SCIENTIFIC_ENVS: "0",
      SCIENCE_AGENT_MAX_OUTPUT_BYTES: "1000000", SCIENCE_AGENT_MAX_WORKSPACE_BYTES: "10000000",
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
function request(id, code, workspace = "project/session/main") {
  return {
    agentId: owner.agentId, executionId: id, code, runnerWorkspaceKey: workspace,
    workspaceRoot: "unused-control-workspace", executionTimeoutMs: 1,
    permissionEpoch: { id: "journey-epoch", sessionId: owner.sessionId,
      createdAt: new Date().toISOString(), environmentRevisionId: "audit-only",
      mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", secretRefs: [], reason: "journey" },
  };
}
let outcome = "FAIL";
try {
  await step("启动独立 Runner", "生产 CLI 在独立回环端口就绪，没有外部依赖。", async () => {
    await start();
    return `Runner health OK; ${origin}; scientific setup disabled`;
  });
  await step("提交长期任务并离开提交请求", "立即拿到 Execution ID；短等待设置不会杀掉进程；专用日志接口可以看到进展。", async () => {
    const accepted = await client.startShellExecution(request("training", "echo progress; while :; do sleep 1; done"));
    assert.equal(accepted.state, "queued");
    await until(async () => (await client.shellExecutionLogs("training", owner)).chunks.some((chunk) => chunk.text.includes("progress")));
    assert.equal((await client.getShellExecution("training", owner)).state, "running");
    return "HTTP submit returned; state=running; logs contain progress";
  });
  await step("同工作区排队，另一工作区可以运行", "后续写入等待长期任务；独立工作区完成自己的命令。", async () => {
    await client.startShellExecution(request("next", "echo delivered > output.txt"));
    assert.equal((await client.getShellExecution("next", owner)).state, "queued");
    await client.startShellExecution(request("parallel", "echo parallel", "project/session/parallel"));
    await until(async () => (await client.getShellExecution("parallel", owner)).state === "completed");
    assert.equal((await client.getShellExecution("training", owner)).state, "running");
    return "same workspace queued; independent workspace completed";
  });
  await step("运行期间读取稳定源快照", "快照读取不等待写锁，返回已提交基线而不是运行中的文件。", async () => {
    const snapshot = await client.snapshotRemoteWorkspace("project/session/main", []);
    assert.deepEqual(snapshot.files, []);
    assert.equal((await client.getShellExecution("training", owner)).state, "running");
    return "committed empty baseline returned while the writer remains running";
  });
  await step("上传与旧执行入口不能绕过后台写入", "同一 Workspace 的上传和旧 Shell 请求保持等待，查询日志仍可用。", async () => {
    let uploaded = false;
    let executed = false;
    pendingUpload = client.writeRemoteWorkspaceFile("project/session/main", "uploaded.txt", Buffer.from("upload"))
      .then((value) => { uploaded = true; return value; });
    pendingLegacy = client.executeShell({ ...request("legacy", "echo legacy > legacy.txt"), executionTimeoutMs: 0 })
      .then((value) => { executed = true; return value; });
    void pendingUpload.catch(() => undefined);
    void pendingLegacy.catch(() => undefined);
    // The negative observation is bounded; subsequent steps must also verify completion.
    await new Promise((done) => setTimeout(done, 150));
    assert.equal(uploaded, false);
    assert.equal(executed, false);
    assert.equal((await client.getShellExecution("training", owner)).state, "running");
    assert.ok((await client.shellExecutionLogs("training", owner)).chunks.length);
    return "upload and legacy Shell waiting; running status and logs remain observable";
  });
  await step("取消长期任务并取得后续结果", "取消经过管理接口，下一项随后执行；可查询 CAS 版本引用与写入文件。", async () => {
    await client.cancelShellExecution("training", owner);
    await until(async () => (await client.getShellExecution("training", owner)).state === "cancelled");
    await until(async () => (await client.getShellExecution("next", owner)).state === "completed");
    assert.equal((await pendingUpload).path, "uploaded.txt");
    assert.equal((await pendingLegacy).exitCode, 0);
    const completed = await client.getShellExecution("next", owner);
    assert.match(completed.version.digest, /^sha256:[a-f0-9]{64}$/);
    const files = await client.listRemoteWorkspaceFiles("project/session/main");
    assert.ok(files.some((file) => file.path === "output.txt"));
    assert.ok(files.some((file) => file.path === "uploaded.txt"));
    assert.ok(files.some((file) => file.path === "legacy.txt"));
    captured = await client.snapshotRemoteWorkspace("project/session/main", ["output.txt"]);
    await client.writeRemoteWorkspaceFile("project/session/main", "output.txt", Buffer.from("changed after capture"), "overwrite");
    return `cancelled; next/upload/legacy completed; version=${completed.version.digest}; all three files listed`;
  });
  await step("重启后查回结果且禁止重放", "相同 ID 的结果和日志仍可查询；重新提交旧 ID 被拒绝，不执行旧命令。", async () => {
    await stop();
    await start();
    assert.equal((await client.getShellExecution("next", owner)).state, "completed");
    assert.ok((await client.shellExecutionLogs("training", owner)).chunks.some((chunk) => chunk.text.includes("progress")));
    await assert.rejects(client.startShellExecution(request("next", "echo replay")), /already been used/);
    const chunks = []; for await (const bytes of await client.streamWorkspaceSnapshot(captured, "output.txt")) chunks.push(Buffer.from(bytes));
    assert.equal(Buffer.concat(chunks).toString(), "delivered\n", "export survives restart and live source overwrite");
    return "result, logs and immutable source export retained; duplicate submission rejected";
  });
  outcome = "PASS";
} catch (error) {
  process.exitCode = 1;
  console.error(redact(error.message));
} finally {
  await stop();
  await writeFile(resolve(root, "report.md"), [
    "# Detached Runner operator journey", "", `Result: ${outcome}`, `Commit: ${sha}`, "",
    "Invocation: `node test/api/detached-runner-journey.mjs` (repository root).",
    "Scope: production Runner CLI + HTTP controls. Does not certify main/subagent wakeups, managed environments or browser UI.",
    "Isolation: own loopback port, temporary data, in-memory credential; no model/MCP/package/network side effects.", "",
    ...steps.flatMap((entry, i) => [`## ${i + 1}. ${entry.name}`, "", `Expected: ${entry.expectation}`, `Actual: ${redact(entry.actual)}`, `Result: ${entry.result}`, ""]),
    "## Service evidence", "", "```text", serviceLog, "```", "",
  ].join("\n"));
  await rm(dataDir, { recursive: true, force: true });
  console.log(`${outcome}: ${steps.filter((entry) => entry.result === "PASS").length}/${steps.length} steps; report saved under .tmp/detached-runner-journey-*/report.md`);
}
