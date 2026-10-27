// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Users inspect concurrent sources without amplifying upstream failures, see honest feedback, and recover.
 * Steps: Start production API; configure local MCP sources; share 429 cooldown; probe/recover; suppress sustained 406; isolate credentials; inspect healthy source.
 * Environment: Built committed task worktree, ephemeral loopback ports, isolated .tmp data.
 * Type: mocked
 * LLM: none; explicit MCP inspector and audit API journey.
 * MCP: local official SDK HTTP fixture, controlled 406/429; no arXiv/PubMed or other provider calls.
 * WebSearch: none
 * PaperSources: none
 * OtherExternal: none; exchange-rate refresh, memory graph, evolve and scientific environments disabled.
 * Credentials: ephemeral local API token and synthetic MCP headers, redacted from reports.
 * CostSideEffects: temporary local processes/data removed in finally; report retained in .tmp.
 * Run: pnpm build && node test/api/source-health-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit before E2E");
const root = resolve(".tmp", `source-health-journey-${randomUUID()}`);
const data = resolve(root, "data"), token = randomUUID();
const stateFile = resolve(root, "fault.json"), journal = resolve(root, "attempts.ndjson");
const steps = [], processes = [];
let api, source, healthySource, session, sibling, outcome = "FAIL", logs = "";
let state = { journal, endpoint: "http://127.0.0.1", statusCode: 429, retryAfterMs: 2000 };
await mkdir(root, { recursive: true });
await writeFile(journal, "");
await writeFile(stateFile, JSON.stringify(state));
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll("journey-credential-a", "[redacted]")
  .replaceAll("journey-credential-b", "[redacted]").replaceAll(process.cwd(), "<worktree>");
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Local journey timeout: " + logs.slice(-2000));
    await new Promise(done => setTimeout(done, 15));
  }
}
async function start(script, args, env, pattern) {
  let origin;
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  processes.push(child);
  child.on("error", error => { logs += redact(error); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    const text = redact(chunk); logs += text; origin ??= text.match(pattern)?.[1];
  });
  await until(() => {
    if (child.exitCode !== null) throw new Error("Product/fixture exited: " + logs.slice(-2000));
    return origin;
  });
  return origin;
}
async function json(path, body, expected = 200, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(api + path, { method, signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${redact(text)}`);
  return JSON.parse(text);
}
const inspect = (text, selected = source, sessionId = session.id) => json(`/api/mcp/servers/${selected.id}/inspect`, { sessionId, toolName: "echo", input: { text } });
const audit = sessionId => json(`/api/sessions/${sessionId}/mcp/invocations`);
const count = async () => (await readFile(journal, "utf8")).trim().split("\n").filter(Boolean).length;
async function setFault(patch) { state = { ...state, ...patch }; await writeFile(stateFile, JSON.stringify(state)); }
async function step(name, expected, operation) {
  try { steps.push({ name, expected, actual: await operation(), status: "PASS" }); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}
try {
  await step("1. 启动生产 API 并配置本地故障来源", "独立端口和数据；两个会话、两个可调用来源；不调用模型或真实数据源。", async () => {
    const baseEnv = { PATH: process.env.PATH, TMPDIR: root, SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0" };
    const faultPort = await start("test/fixtures/mcp-echo.mjs", ["--http", "0"], { ...baseEnv, MCP_FIXTURE_SOURCE_HEALTH_FILE: stateFile }, /"port":(\d+)/);
    const healthyPort = await start("test/fixtures/mcp-echo.mjs", ["--http", "0"], baseEnv, /"port":(\d+)/);
    const extensions = resolve(root, "extensions.json"); await writeFile(extensions, '{"mcpServers":{}}');
    api = await start("services/api/dist/server.js", [], { ...baseEnv,
      SCIENCE_AGENT_DATA_DIR: data, SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token,
      SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1",
      SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH: extensions, SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: "false",
      SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"), SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
      SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_EVOLVE_URL: "http://127.0.0.1:1",
    }, /ScienceDiscovery listening on (http:\/\/127\.0\.0\.1:\d+)/);
    assert.equal((await fetch(api + "/health")).status, 200);
    ({ firstSession: session } = await json("/api/projects", { name: "Source health" }, 201));
    ({ firstSession: sibling } = await json("/api/projects", { name: "Sibling research" }, 201));
    source = await json("/api/mcp/servers", { name: "Fault source", transport: "http", url: `http://127.0.0.1:${faultPort}/mcp`, enabled: true,
      headers: { Authorization: "Bearer journey-credential-a" } }, 201);
    healthySource = await json("/api/mcp/servers", { name: "Healthy source", transport: "http", url: `http://127.0.0.1:${healthyPort}/mcp`, enabled: true }, 201);
    assert.equal(source.status, "ready"); assert.equal(healthySource.status, "ready");
    return "生产 API 健康，两个独立会话和本地 HTTP MCP 来源就绪";
  });
  await step("2. 并发会话共享 429 冷却", "一条实际 MCP 请求；所有调用有界返回；后续回合不等待或放大请求。", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => inspect(`parallel-${i}`, source, i % 2 ? sibling.id : session.id)));
    assert.ok(responses.every(response => !response.ok && /temporarily unavailable/.test(response.error)));
    assert.equal(await count(), 1);
    assert.equal((await inspect("next-agent-round")).ok, false);
    assert.equal(await count(), 1);
    const records = [...await audit(session.id), ...await audit(sibling.id)];
    assert.equal(records.reduce((sum, record) => sum + record.attempts.length, 0), 1);
    assert.ok(records.every(record => record.error.sourceHealth.statusCode === 429 && record.error.retryAfterMs > 0));
    assert.ok(records.every(record => record.error.retryable === false));
    assert.ok(records.some(record => record.error.message.includes("blocked because no alternative source is available")));
    return "9 次用户调用只发出 1 次 MCP 请求；审计保留 429、重试时间和诚实受阻提示";
  });
  await step("3. 冷却后单探测失败，再恢复访问", "故障仍在时只发一个探测；恢复后真实工具结果可读取。", async () => {
    const first = (await audit(session.id)).find(record => record.error?.sourceHealth);
    await until(() => Date.now() > Date.parse(first.error.sourceHealth.retryAt));
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => inspect(`probe-${i}`)));
    assert.ok(responses.every(response => !response.ok)); assert.equal(await count(), 2);
    const latest = (await audit(session.id)).findLast(record => record.attempts.length);
    await setFault({ statusCode: 0 });
    await until(() => Date.now() > Date.parse(latest.error.sourceHealth.retryAt));
    const recovered = await inspect("recovered");
    assert.equal(recovered.ok, true); assert.match(JSON.stringify(recovered.result), /RECOVERED/);
    assert.equal((await inspect("normal")).ok, true); assert.equal(await count(), 4);
    return "持续故障只发 1 个恢复探测；上游恢复后两次访问成功，结果均由本地 MCP 实际返回";
  });
  await step("4. 请求特有 406 不抑制，持续端点 406 达阈值后抑制", "请求错误可继续；三个不同端点拒绝后不再触达上游。", async () => {
    await setFault({ statusCode: 406, failureScope: "request" });
    for (let i = 0; i < 4; i++) assert.equal((await inspect(`bad-query-${i}`)).ok, false);
    assert.equal(await count(), 8);
    await setFault({ failureScope: "endpoint" });
    for (let i = 0; i < 3; i++) assert.equal((await inspect(`valid-query-${i}`)).ok, false);
    assert.equal(await count(), 11);
    const suppressed = await inspect("later-round"); assert.equal(suppressed.ok, false); assert.equal(await count(), 11);
    const latest = (await audit(session.id)).at(-1);
    assert.equal(latest.attempts.length, 0); assert.equal(latest.error.sourceHealth.statusCode, 406);
    assert.match(suppressed.error, /^This source is temporarily unavailable/);
    return "4 个请求特有错误未停用来源；3 个不同端点拒绝触发冷却；后续回合实际请求为 0";
  });
  await step("5. 凭据隔离和健康来源持续可用", "不同凭据可尝试；恢复原凭据仍受冷却；其他来源返回真实成功结果。", async () => {
    await json(`/api/mcp/servers/${source.id}`, { ...source, headers: { Authorization: "Bearer journey-credential-b" } }, 200, "PUT");
    assert.equal((await inspect("credential-b")).ok, false); assert.equal(await count(), 12);
    await json(`/api/mcp/servers/${source.id}`, { ...source, headers: { Authorization: "Bearer journey-credential-a" } }, 200, "PUT");
    assert.equal((await inspect("credential-a")).ok, false); assert.equal(await count(), 12);
    const healthy = await inspect("alternative is available", healthySource);
    assert.equal(healthy.ok, true); assert.match(JSON.stringify(healthy.result), /ALTERNATIVE IS AVAILABLE/);
    const diagnostics = JSON.stringify([...await audit(session.id), ...await audit(sibling.id)]);
    assert.doesNotMatch(diagnostics, /journey-credential-a|journey-credential-b/);
    return "凭据 B 独立尝试，凭据 A 冷却保持；健康来源成功；公开诊断不含凭据";
  });
  outcome = "PASS";
} finally {
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(done => child.once("exit", done));
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 17_000);
    await exited; clearTimeout(timer);
  }
  await writeFile(resolve(root, "report.md"), `# 数据源共享冷却 API 旅程\n\n结论：${outcome}\n\n被测 SHA：${sha}\n\nplanned=5 executed=${steps.length} passed=${steps.filter(step => step.status === "PASS").length}\n\n`
    + steps.map(step => `## ${step.name}\n\n预期：${step.expected}\n\n实际：${redact(step.actual)}\n\n结果：${step.status}\n`).join("\n"));
  await writeFile(resolve(root, "services.log"), logs);
  await rm(data, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome, sha, planned: 5, executed: steps.length, passed: steps.filter(step => step.status === "PASS").length, report: resolve(root, "report.md") }));
}
