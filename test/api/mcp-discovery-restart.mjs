// Copyright (C) 2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: saved MCP routes survive API restarts and background configuration failures recover.
 * Steps: create owned local services and saved policies; restart actual API; inspect tools/routes; corrupt and repair extensions; delete owned records.
 * Environment: immutable committed build; actual services/api/dist/server.js entry; owned data and loopback ports. Runner/model not used.
 * Type: mocked; real HTTP/SSE MCP SDK fixtures and recording loopback proxy, no external network or model.
 * Credentials: generated local API token and synthetic MCP header only; never included in reports.
 * CostSideEffects: temporary directory and owned child processes; stop all processes in finally.
 * Run: node --import tsx test/api/mcp-discovery-restart.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startMcpFixture, startMcpProxy } from "../support/mcp-network-fixtures.ts";

const root = process.cwd();
await mkdir(resolve(root, ".tmp/pr1197"), { recursive: true });
const directory = await mkdtemp(resolve(root, ".tmp/pr1197/restart-"));
const token = randomBytes(32).toString("hex");
const extensionPath = resolve(directory, "extensions.json");
const steps = [], resources = [], log = [];
let child, origin, sha, outcome = "FAIL";

/** 为当前进程选择空闲端口。 */
async function freePort() {
  const reservation = createServer();
  await new Promise(done => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  return port;
}

/** 通过真实 HTTP 接口读取、保存本次测试的数据。 */
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return value;
}

/** 有界等待产品可观察状态，不依赖固定发现时长。 */
async function until(read, matches) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Product state did not converge before deadline");
}

/** 停止并等待当前测试专属 API 退出。 */
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  const exited = new Promise(done => current.once("exit", done));
  current.kill("SIGTERM");
  const timer = setTimeout(() => current.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

/** 用同一独立数据目录启动实际产品 API，模拟用户重启。 */
async function start(proxyUrl) {
  const port = await freePort(); origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: String(port),
    SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_DISCOVERY_DATA_DIR: resolve(directory, "data"), SCIENCE_AGENT_DATA_DIR: resolve(directory, "data"),
    SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH: extensionPath, SCIENCE_AGENT_SAMPLE_SESSION: "0", SCIENCE_AGENT_EXECUTOR: "native",
    SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_RUNNER_URL: "http://127.0.0.1:1" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) env[key] = "";
  env.http_proxy = proxyUrl;
  child = spawn(process.execPath, ["services/api/dist/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => log.push(String(data).replaceAll(token, "[redacted]")));
  await until(async () => {
    assert.equal(child.exitCode, null, "API exited unexpectedly");
    try { return (await fetch(`${origin}/health`)).ok; } catch { return false; }
  }, Boolean);
}

/** 保存按编号排列的用户步骤和结果。 */
async function step(name, run) {
  try { await run(); steps.push({ name, result: "PASS" }); }
  catch (error) { steps.push({ name, result: "FAIL", error: error.message }); throw error; }
}

try {
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit the candidate before formal E2E");
  sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeFile(extensionPath, "{}");
  const connectors = [];
  for (const transport of ["http", "sse"]) {
    const fixture = await startMcpFixture(transport); resources.push(fixture);
    const proxy = await startMcpProxy(fixture.origin); resources.push(proxy);
    connectors.push({ transport, fixture, proxy });
  }
  await step("1. 保存指定代理和直连连接器", async () => {
    await start(connectors[0].proxy.url);
    for (const item of connectors) {
      const proxy = await api("/api/proxy/servers", { name: `Owned ${item.transport}`, kind: "custom_url", url: item.proxy.url });
      item.remote = await api("/api/mcp/servers", { name: `Proxy ${item.transport}`, transport: item.transport,
        url: `http://mcp-fixture.invalid/${item.transport === "http" ? "mcp" : "sse"}`, enabled: false });
      item.direct = await api("/api/mcp/servers", { name: `Direct ${item.transport}`, transport: item.transport,
        url: `${item.fixture.origin}/${item.transport === "http" ? "mcp" : "sse"}`, enabled: false });
      const policies = (await api("/api/mcp/proxy-policies")).policies;
      await api("/api/mcp/proxy-policies", { policies: { ...policies, [item.remote.id]: `proxy:${proxy.id}`, [item.direct.id]: "none" } }, "PUT");
      for (const saved of [item.remote, item.direct]) await api(`/api/mcp/servers/${saved.id}`, { ...saved, enabled: true }, "PUT");
    }
    await until(() => api("/api/mcp/servers"), rows => rows.length === 4 && rows.every(row => row.status === "ready"));
    await stop();
  });
  await step("2. 重启后首次发现遵守保存的代理，并可读取全部工具", async () => {
    for (const item of connectors) item.proxy.requests.length = 0;
    await start(connectors[0].proxy.url);
    const rows = await api("/api/mcp/servers");
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.status, "ready", row.name);
      assert.equal((await api(`/api/mcp/sources/${row.id}/tools`)).length, 2);
    }
    for (const item of connectors) {
      assert.ok(item.proxy.requests.length > 0);
      assert.ok(item.proxy.requests.every(line => line.includes("mcp-fixture.invalid")), "Direct connector reached an environment proxy");
    }
  });
  for (const fault of ["invalid JSON", "missing file", "unreadable path"]) {
    await step(`3. ${fault} 不会终止服务，修复后再次保存可恢复`, async () => {
      await rm(extensionPath, { force: true, recursive: true });
      if (fault === "invalid JSON") await writeFile(extensionPath, "{");
      if (fault === "unreadable path") await mkdir(extensionPath);
      const row = (await api("/api/mcp/servers"))[0];
      await api(`/api/mcp/servers/${row.id}`, row, "PUT");
      await until(() => api("/api/mcp/servers"), rows => rows.find(item => item.id === row.id)?.status === "error");
      assert.equal(child.exitCode, null);
      await rm(extensionPath, { force: true, recursive: true }); await writeFile(extensionPath, "{}");
      await api(`/api/mcp/servers/${row.id}`, row, "PUT");
      await until(() => api("/api/mcp/servers"), rows => rows.every(item => item.status === "ready"));
    });
  }
  outcome = "PASS";
} catch (error) { steps.push({ name: "结果", result: "FAIL", error: error.message }); process.exitCode = 1; }
finally {
  await stop();
  for (const item of resources.reverse()) await item.close();
  await writeFile(resolve(directory, "startup.log"), log.join(""));
  await writeFile(resolve(directory, "report.json"), JSON.stringify({ outcome, sha, steps }, null, 2));
  await writeFile(resolve(directory, "report.md"), `# MCP 重启与异常恢复：${outcome}\n\n提交：${sha}\n\n入口：services/api/dist/server.js；仅 API 与本地 MCP/代理，无模型、Runner 调用。\n\n${steps.map(item => `- ${item.name}：${item.result}${item.error ? `，${item.error}` : ""}`).join("\n")}\n`);
  console.log(JSON.stringify({ outcome, sha, directory }));
}
