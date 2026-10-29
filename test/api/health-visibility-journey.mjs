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
 * Purpose: Operators check public liveness without exposing deployment details, then authenticate to diagnose the stack.
 * Steps: Start isolated production API and Runner; probe missing/wrong tokens; inspect authenticated details; stop Runner and recheck liveness/diagnostics.
 * Environment: Linux, built committed worktree, ephemeral loopback ports and isolated .tmp data.
 * Type: real
 * LLM: none
 * MCP: none; empty extension configuration.
 * WebSearch: none
 * PaperSources: none
 * OtherExternal: none; scientific environments, sample session, exchange rates and sidecars disabled.
 * Credentials: generated local tokens only; never written to reports.
 * CostSideEffects: local processes/data removed in finally, report retained under .tmp.
 * Run: pnpm build && node test/api/health-visibility-journey.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit before E2E");
const root = resolve(".tmp", `health-visibility-${randomUUID()}`);
const token = randomUUID(), runnerToken = randomUUID(), processes = [], steps = [];
let logs = "", outcome = "FAIL";
await mkdir(root, { recursive: true });
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll(runnerToken, "[redacted]");
async function start(script, env, pattern) {
  let origin;
  const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  const exited = new Promise(done => child.once("exit", done));
  child.on("error", error => { logs += redact(error); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    logs += redact(chunk); origin ??= String(chunk).match(pattern)?.[1];
  });
  const deadline = Date.now() + 30_000;
  while (!origin) {
    assert.equal(child.exitCode, null, logs);
    assert.ok(Date.now() < deadline, `Startup timeout: ${logs}`);
    await new Promise(done => setTimeout(done, 25));
  }
  return { origin, child, exited };
}
async function stop(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  service.child.kill("SIGTERM");
  const timer = setTimeout(() => service.child.kill("SIGKILL"), 5_000);
  await service.exited;
  clearTimeout(timer);
}
async function get(origin, path, bearer) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(10_000),
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) });
  assert.equal(response.status, 200);
  return response.json();
}
async function step(name, operation) {
  try { steps.push({ name, status: "PASS", actual: await operation() }); }
  catch (error) { steps.push({ name, status: "FAIL", actual: redact(error.stack) }); throw error; }
}
let api, runner;
try {
  await step("1. Start isolated production API and Runner", async () => {
    const extensions = resolve(root, "extensions.json");
    await writeFile(extensions, '{"mcpServers":{}}');
    const env = { PATH: process.env.PATH, SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0",
      SCIENCE_AGENT_DATA_DIR: resolve(root, "data"), SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: runnerToken,
      SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_RUNNER_PORT: "0",
      SCIENCE_AGENT_EXTENSIONS_CONFIG_PATH: extensions, SCIENCE_AGENT_SAMPLE_SESSION: "false", SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: "false",
      SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"), SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
      SCIENCE_AGENT_MEMORY_GRAPH_AVAILABLE: "0", SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_EVOLVE_URL: "http://127.0.0.1:1" };
    runner = await start("services/runner/dist/server.js", env, /runner listening on (http:\/\/127\.0\.0\.1:\d+)/);
    api = await start("services/api/dist/server.js", { ...env, SCIENCE_AGENT_RUNNER_URL: runner.origin }, /ScienceDiscovery listening on (http:\/\/127\.0\.0\.1:\d+)/);
    return "Both production entry points listening on isolated loopback ports";
  });
  await step("2. Missing and wrong tokens expose exactly liveness", async () => {
    for (const bearer of [undefined, "wrong-token"]) {
      for (const path of ["/health", "/api/health"]) {
        assert.deepEqual(await get(api.origin, path, bearer), { service: "sciencediscovery-api", status: "ok" });
      }
      assert.deepEqual(await get(runner.origin, "/health", bearer), { status: "ok" });
    }
    return "6 responses: HTTP 200, exact public field sets, no deployment details";
  });
  await step("3. Valid tokens retain diagnostic and aggregated Runner details", async () => {
    const health = await get(runner.origin, "/health", runnerToken);
    assert.equal(health.platform, "linux");
    assert.ok(health.runnerVersion);
    for (const path of ["/health", "/api/health"]) {
      const detailed = await get(api.origin, path, token);
      assert.equal(detailed.runner.runnerVersion, health.runnerVersion);
      assert.equal(detailed.runner.platform, "linux");
      assert.ok(detailed.workspace);
      assert.ok(detailed.sandboxNetwork);
      assert.equal(typeof detailed.memoryGraph, "string");
    }
    return "3 authenticated responses retain capabilities and API-to-Runner authentication works";
  });
  await step("4. Public liveness survives Runner outage; authenticated diagnosis reports it", async () => {
    await stop(runner);
    for (const path of ["/health", "/api/health"]) {
      assert.deepEqual(await get(api.origin, path), { service: "sciencediscovery-api", status: "ok" });
      const detailed = await get(api.origin, path, token);
      assert.equal(detailed.status, "degraded");
      assert.equal(detailed.runner.status, "unavailable");
    }
    return "Token-free probes stay HTTP 200; authenticated diagnostics identify the unavailable Runner";
  });
  outcome = "PASS";
} finally {
  for (const service of [api, runner]) if (service) await stop(service);
  await writeFile(resolve(root, "report.md"), `# Health visibility journey\n\nSHA: ${sha}\nCommand: node test/api/health-visibility-journey.mjs\nOutcome: ${outcome}\nPassed: ${steps.filter(step => step.status === "PASS").length}; failed: ${steps.filter(step => step.status === "FAIL").length}\n\n${steps.map(step => `## ${step.name}\n\n${step.status}: ${step.actual}`).join("\n\n")}\n`);
  await writeFile(resolve(root, "services.log"), logs);
  await rm(resolve(root, "data"), { recursive: true, force: true });
  console.log(`${outcome}: ${resolve(root, "report.md")}`);
}
