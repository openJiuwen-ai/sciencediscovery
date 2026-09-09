// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * Production Runner HTTP journey for Issue #71. No LLM, SSH or live stack.
 * Build runner first, then: node test/api/sandbox-disconnect-journey.mjs
 * For contention run under taskset on a single CPU alongside bounded workers.
 * Uses an ephemeral loopback port/token, ignored private data, and finally cleanup.
 * Reports request disconnect, descendant side effects and committed writer handoff.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createExecutionSignature } from "../../services/runner/dist/request-auth.js";

const root = resolve(".tmp", "sandbox-disconnect-" + randomUUID());
const token = randomUUID();
const sha = execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {encoding: "utf8"}).trim());
await mkdir(root, {recursive: true});
const steps = [];
const controllers = [];
const headers = {authorization: "Bearer " + token};
let origin;
let log = "";
const runner = spawn(process.execPath, ["services/runner/dist/server.js"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH, TMPDIR: root,
    SCIENCE_AGENT_DATA_DIR: resolve(root, "data"),
    SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
    SCIENCE_AGENT_RUNNER_TOKEN: token, SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0",
  },
});
for (const stream of [runner.stdout, runner.stderr]) stream.on("data", (chunk) => {
  log += chunk.toString().replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
  origin ??= chunk.toString().match(/runner listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
});
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, budget = 5000) {
  const deadline = Date.now() + budget;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Runner outcome exceeded " + budget + " ms");
    await delay(15);
  }
}
async function api(path, init = {}) {
  const response = await fetch(origin + path, {...init, headers: {...headers, ...init.headers}});
  assert.ok(response.ok, path + ": " + response.status + " " + (response.ok ? "" : await response.text()));
  return response.json();
}
function execution(id, code) {
  return {agentId: "main", executionId: id, code, runnerWorkspaceKey: id,
    workspaceRoot: "unused", executionTimeoutMs: 0,
    permissionEpoch: {id: "epoch", sessionId: "journey", createdAt: new Date().toISOString(),
      environmentRevisionId: "audit-only", mounts: [{source: "workspace", mode: "read-write"}],
      networkPolicy: "none", secretRefs: [], reason: "test"}};
}
function submit(path, body, signal) {
  const payload = JSON.stringify(body);
  const timestamp = String(Date.now());
  return fetch(origin + path, {method: "POST", signal, body: payload, headers: {
    ...headers, "content-type": "application/json",
    "x-science-execution-timestamp": timestamp,
    "x-science-execution-signature": createExecutionSignature(token, timestamp, payload),
  }});
}
async function fileExists(workspace, path) {
  const listing = await api("/remote-workspace/files?workspace=" + workspace);
  return listing.some((file) => file.path === path);
}
async function step(name, operation) {
  const started = Date.now();
  try {
    const result = await operation();
    steps.push({name, result: "PASS", elapsedMs: Date.now() - started, detail: result});
  } catch (error) {
    steps.push({name, result: "FAIL", detail: String(error).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>")});
    throw error;
  }
}
try {
  await step("独立生产 Runner 就绪", async () => {
    await until(() => {
      if (runner.exitCode !== null) throw new Error(log);
      return origin;
    }, 15000);
    assert.equal((await api("/health")).status, "ok");
  });
  await step("Python 启动阶段断开，执行不等待自然结束", async () => {
    const times = [];
    for (let i = 0; i < 10; i++) {
      const id = "early-" + i;
      const controller = new AbortController(); controllers.push(controller);
      const pending = submit("/execute", execution(id, "import time; time.sleep(60)"), controller.signal)
        .then(() => "unexpected response", (error) => error.name);
      await until(async () => (await api("/status")).activeExecutions.some((item) => item.executionId === id && item.status === "running"));
      const started = Date.now();
      controller.abort();
      assert.equal(await pending, "AbortError");
      await until(async () => (await api("/status")).activeExecutions.length === 0);
      times.push(Date.now() - started);
    }
    return {disconnectToIdleMs: times};
  });
  await step("Python 派生进程另起会话，断开后也不得继续写文件", async () => {
    const controller = new AbortController(); controllers.push(controller);
    const code = "import os,time\nif os.fork()==0:\n os.setsid()\n open('ready','w').write('ready')\n time.sleep(2)\n open('late','w').write('leaked')\n time.sleep(60)\nelse:\n time.sleep(60)";
    const pending = submit("/execute", execution("descendant", code), controller.signal).catch((error) => error.name);
    await until(() => fileExists("descendant", "ready"));
    controller.abort();
    assert.equal(await pending, "AbortError");
    await until(async () => (await api("/status")).activeExecutions.length === 0);
    await delay(2200);
    assert.equal(await fileExists("descendant", "late"), false);
  });
  await step("同步 Shell 断开并释放后续 writer", async () => {
    const controller = new AbortController(); controllers.push(controller);
    const pending = submit("/execute-shell", execution("shell", "echo ready > ready; sleep 60"), controller.signal).catch((error) => error.name);
    await until(() => fileExists("shell", "ready"));
    controller.abort();
    assert.equal(await pending, "AbortError");
    await until(async () => (await api("/status")).activeExecutions.length === 0);
    const next = execution("shell-next", "echo committed > output");
    next.runnerWorkspaceKey = "shell";
    const response = await submit("/execute-shell", next);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).exitCode, 0);
    assert.equal(await fileExists("shell", "output"), true);
  });
  await step("后台任务不随提交断开，显式取消后产生版本回执", async () => {
    const response = await submit("/shell-executions", execution("background", "echo progress; sleep 60"));
    assert.equal(response.status, 202);
    await response.json();
    const owner = "?sessionId=journey&agentId=main";
    await until(async () => (await api("/shell-executions/background/logs" + owner)).chunks.some((chunk) => chunk.text.includes("progress")));
    assert.equal((await api("/shell-executions/background" + owner)).state, "running");
    await api("/shell-executions/background/cancel" + owner, {method: "POST"});
    await until(async () => (await api("/shell-executions/background" + owner)).state === "cancelled");
    assert.ok((await api("/shell-executions/background" + owner)).version);
  });
} catch (error) {
  process.exitCode = 1;
  console.error(String(error).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>"));
} finally {
  for (const controller of controllers) controller.abort();
  if (runner.exitCode === null && runner.signalCode === null) {
    const exited = once(runner, "exit");
    runner.kill("SIGTERM");
    await exited;
  }
  await writeFile(resolve(root, "report.md"), "# Sandbox disconnect journey\n\nSHA: " + sha + "\nDirty: " + dirty + "\n\n" +
    steps.map((item) => "- " + item.result + " " + item.name + ": " + JSON.stringify(item)).join("\n") + "\n");
  await writeFile(resolve(root, "runner.log"), log);
  await rm(resolve(root, "data"), {recursive: true, force: true});
  console.log(JSON.stringify({passed: steps.filter((item) => item.result === "PASS").length, total: steps.length, report: resolve(root, "report.md")}));
}
