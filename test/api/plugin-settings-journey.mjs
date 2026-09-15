// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Safely save classic and plugin settings, reject stale edits, retain experiments, and recover settings after restart.
 * Steps: Start production API/Runner; create Project; save inherited settings; reject stale Bridge; race two editors; retain rejected experiments; restart and verify.
 * Environment: Built, committed task worktree; ephemeral loopback ports and isolated .tmp data.
 * Type: mocked
 * LLM: none; this is a settings-management journey, not an Agent execution test.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none; scientific environments and exchange-rate refresh disabled.
 * Credentials: random in-memory API/Runner tokens only.
 * CostSideEffects: temporary local processes and data, removed in finally; evidence retained under .tmp until archived.
 * Run: pnpm build && node test/api/plugin-settings-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit before E2E");
const root = resolve(".tmp", "plugin-settings-" + randomUUID());
const data = resolve(root, "data"), token = randomUUID();
await mkdir(root, { recursive: true });
const steps = [], processes = [];
let api, runner, apiProcess, logs = "", outcome = "FAIL";
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
async function until(check) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for service: " + logs.slice(-2000));
    await new Promise(done => setTimeout(done, 20));
  }
}
async function start(kind, extra = {}) {
  let origin;
  const child = spawn(process.execPath, [`services/${kind}/dist/server.js`], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, TMPDIR: root, SCIENCE_AGENT_DATA_DIR: data,
    SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token,
    SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
    SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: "false",
    SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-config"), SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
    SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_EVOLVE_URL: "http://127.0.0.1:1", ...extra,
  } });
  processes.push(child);
  let spawnError;
  child.on("error", error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    logs += redact(chunk);
    origin ??= logs.match(new RegExp(kind === "api" ? "ScienceDiscovery listening on (http://127\\.0\\.0\\.1:\\d+)" : "runner listening on (http://127\\.0\\.0\\.1:\\d+)"))?.[1];
  });
  await until(() => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`${kind} exited: ${logs.slice(-2000)}`);
    return origin;
  });
  return { child, origin };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once("exit", done));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 17_000);
  await exited; clearTimeout(timeout);
}
async function json(path, body, method = body === undefined ? "GET" : "POST", expected = 200) {
  const response = await fetch(api + path, { method, signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${redact(text)}`);
  return JSON.parse(text);
}
async function step(name, expected, operation) {
  try { steps.push({ name, expected, actual: await operation(), status: "PASS" }); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}
let project, session, base, experiments, saved;
try {
  await step("1. 启动并认证", "生产 API/Runner 健康；未认证的插件请求被拒绝。", async () => {
    runner = (await start("runner")).origin;
    ({ origin: api, child: apiProcess } = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner }));
    assert.equal((await fetch(api + "/health")).status, 200);
    assert.equal((await fetch(runner + "/health", { headers: { authorization: `Bearer ${token}` } })).status, 200);
    ({ project, firstSession: session } = await json("/api/projects", { name: "Plugin settings journey" }, "POST", 201));
    base = `/api/projects/${project.id}/plugins`;
    assert.equal((await fetch(api + base)).status, 401);
    return `API ${api}; Runner ${runner}; health 200; unauthenticated 401`;
  });
  await step("2. 保存继承设置并处理过期编辑", "经典全局/项目/会话保存生效，旧 Bridge 编辑得到 409 且不覆盖新设置。", async () => {
    const old = await json(base + `?sessionId=${session.id}`);
    await json("/api/settings", { plugins: { mcp: { enabled: false } } }, "PUT");
    await json(`/api/projects/${project.id}/settings`, { plugins: { plan: { enabled: false } } }, "PUT");
    const error = await json(base + `/bridge?sessionId=${session.id}`, { apiVersion: 1, pluginId: "host.settings",
      scope: { projectId: project.id, sessionId: session.id }, kind: "command", method: "replace",
      input: { expectedRevision: old.revision, overrides: {} } }, "POST", 409);
    assert.equal(error.code, "conflict");
    await json(`/api/sessions/${session.id}/settings`, { plugins: { plan: { enabled: true } } }, "PUT");
    await json(`/api/sessions/${session.id}`, { enabledSkillIds: [] }, "PATCH");
    const settings = await json(`/api/sessions/${session.id}/settings`);
    assert.equal(settings.effective.plugins.mcp.enabled, false);
    assert.equal(settings.effective.plugins.plan.enabled, true);
    assert.deepEqual(settings.overrides.enabledSkillIds, []);
    return "Global MCP=false / Project Plan=false / Session Plan=true; stale editor 409; Composer selection retained";
  });
  await step("3. 两个编辑者同时保存", "相同 revision 的两次 Bridge 保存只成功一次；冲突后重新读取可继续经典保存。", async () => {
    const before = await json(base);
    const edit = enabled => fetch(api + base + "/bridge", { method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ apiVersion: 1, pluginId: "skill", scope: { projectId: project.id }, kind: "command", method: "configure",
        input: { expectedRevision: before.revision, settings: { enabled } } }) });
    const responses = await Promise.all([edit(false), edit(true)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    await Promise.all(responses.map(response => response.arrayBuffer()));
    await json(`/api/projects/${project.id}/settings`, { plugins: { skill: { enabled: false }, plan: { enabled: false } } }, "PUT");
    assert.equal((await json(base)).settings.effective.plugins.skill.enabled, false);
    return "Concurrent editors: 200 + 409; deliberate later classic PUT succeeds";
  });
  await step("4. 拒绝候选但保留实验", "prepare 创建两个可查看的 Session；拒绝不改变活动配置，也不自动删除实验。", async () => {
    const before = await json(base);
    const candidate = await json(base + "/candidates", { expectedRevision: before.revision, patch: { plugins: { plan: { enabled: true } } } });
    const prepared = await json(base + `/candidates/${candidate.id}/prepare`, {});
    experiments = prepared.experiments;
    await json(base + `/candidates/${candidate.id}/reject`, {});
    assert.equal((await json(base)).revision, before.revision);
    await json(`/api/sessions/${experiments.baselineSessionId}`);
    await json(`/api/sessions/${experiments.candidateSessionId}`);
    assert.equal((await json(base + "/candidates"))[0].status, "rejected");
    saved = await json(`/api/sessions/${session.id}/settings`);
    return "Candidate rejected; active revision unchanged; both experiment Sessions readable";
  });
  await step("5. 重启后继续查看", "生产 API 重启后设置、继承和拒绝候选及实验仍可查询。", async () => {
    await stop(apiProcess);
    logs = "";
    ({ origin: api, child: apiProcess } = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner }));
    assert.deepEqual(await json(`/api/sessions/${session.id}/settings`), saved);
    assert.equal((await json(base + "/candidates"))[0].status, "rejected");
    await json(`/api/sessions/${experiments.baselineSessionId}`);
    await json(`/api/sessions/${experiments.candidateSessionId}`);
    return "Settings identical after restart; rejected candidate and both experiment Sessions retained";
  });
  outcome = "PASS";
} catch (error) {
  console.error(redact(error.stack)); process.exitCode = 1;
} finally {
  await Promise.all(processes.map(stop));
  const report = [`# 插件设置 API 用户旅程`, "", `结果：${outcome}；SHA：${sha}；时间：${new Date().toISOString()}`, "",
    "启动：生产 services/api/dist/server.js 与 services/runner/dist/server.js；独立数据、随机认证、回环动态端口；关闭汇率刷新与科学环境，无模型/外部调用。",
    "", "命令：`pnpm build`；`node test/api/plugin-settings-journey.mjs`。", "",
    "精确 ApplyPort/经典写入交错由 control.test.ts 屏障回归覆盖；本旅程验证真实 HTTP 的设置、冲突、保留和重启结果，不冒充运行实验或浏览器布局测试。", "",
    ...steps.flatMap(item => [`## ${item.name}`, "", `预期：${item.expected}`, "", `实际（${item.status}）：${item.actual}`, ""]),
    "进程已停止；专属业务数据已清理。", ""].join("\n");
  await writeFile(resolve(root, "report.md"), report);
  await writeFile(resolve(root, "service.log"), logs);
  await rm(data, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome, sha, steps: steps.length, report: resolve(root, "report.md") }));
}
