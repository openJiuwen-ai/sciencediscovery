// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: A new session's memory graph stays responsive after another session produces a folded subagent scope.
 * Steps: Start the isolated product stack; enable local memory; seed two child products through the sidecar's observe API; read folded and expanded products through the control API; read a new empty session.
 * Environment: Committed worktree, local stack, isolated ports/data/cache, production API/Runner/sidecars.
 * Type: mocked
 * LLM: none; observe events are journey fixtures, not model output.
 * WebSearch: none
 * PaperSources: none; local Paper fixture records only.
 * MCP: none; the observe API receives local fixture events.
 * OtherExternal: package installation during stack provisioning; no runtime external calls.
 * Credentials: random journey-owned API, Runner, and memory graph tokens.
 * CostSideEffects: temporary local processes and data only; report retained under .tmp.
 * Run: node test/api/memory-folded-subgraph-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit before E2E");
const root = resolve(".tmp", `memory-folded-subgraph-${randomUUID()}`);
const data = resolve(root, "data");
const token = randomUUID(), graphToken = randomUUID();
const steps = [];
let log = "", stack, outcome = "FAIL";
await mkdir(root, { recursive: true });
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll(graphToken, "[redacted]").replaceAll(process.cwd(), "<worktree>");

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => server.once("error", reject).listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
async function until(check, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (stack?.exitCode !== null) throw new Error(`stack exited: ${log.slice(-2500)}`);
    if (Date.now() > deadline) throw new Error(`stack health timeout: ${log.slice(-2500)}`);
    await new Promise(done => setTimeout(done, 100));
  }
}
async function call(origin, path, credential, method = "GET", body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method, signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${redact(payload)}`);
  return JSON.parse(payload);
}
async function step(name, expected, operation) {
  try { steps.push({ name, expected, actual: await operation(), status: "PASS" }); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}

let api, graph, sessionId, freshSessionId, scopeId;
try {
  const [apiPort, runnerPort, graphPort, evolvePort] = await Promise.all(Array.from({ length: 4 }, freePort));
  api = `http://127.0.0.1:${apiPort}`;
  graph = `http://127.0.0.1:${graphPort}`;
  const env = {
    ...process.env, SCIENCE_DISCOVERY_DATA_DIR: data, SCIENCE_AGENT_DATA_DIR: data,
    UV_CACHE_DIR: resolve(root, "uv-cache"),
    SCIENCE_AGENT_PORT: String(apiPort), SCIENCE_AGENT_HOST: "127.0.0.1",
    SCIENCE_AGENT_RUNNER_PORT: String(runnerPort), SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1",
    SCIENCE_AGENT_RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
    SCIENCE_AGENT_MEMORY_GRAPH_PORT: String(graphPort), SCIENCE_AGENT_MEMORY_GRAPH_URL: graph,
    SCIENCE_AGENT_MEMORY_GRAPH_DATA_DIR: resolve(data, "memory-graph"),
    SCIENCE_AGENT_EVOLVE_PORT: String(evolvePort), SCIENCE_AGENT_EVOLVE_URL: `http://127.0.0.1:${evolvePort}`,
    SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token,
    SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN: graphToken,
    SCIENCE_AGENT_MEMORY_GRAPH_BACKEND: "local", SCIENCE_AGENT_EVOLVE_STUB_ONLY: "1", SCIENTIFIC_ENVS: "0",
    SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_USAGE_EXCHANGE_RATES_ENABLED: "false",
    SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"),
    SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
  };
  stack = spawn("bash", ["scripts/start-stack.sh", "--mode", "local"], {
    env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [stack.stdout, stack.stderr]) stream.on("data", chunk => { log += redact(chunk); });

  await step("1. Start isolated product", "API, Runner, and local memory graph are healthy", async () => {
    await until(async () => {
      try {
        return (await fetch(`${api}/health`)).ok && (await fetch(`${graph}/health`)).ok;
      } catch { return false; }
    });
    const settings = await call(api, "/api/memory/settings", token, "PUT", { enabled: true, backend: "local" });
    assert.equal(settings.memoryGraphStatus, "healthy");
    await access(resolve(data, "memory-graph"));
    return "API and graph health 200; local memory enabled";
  });

  await step("2. Create sessions and observe scoped products", "Two Papers belong to one folded scope in the older session", async () => {
    const oldProject = await call(api, "/api/projects", token, "POST", { name: "Folded scope journey" }, 201);
    const newProject = await call(api, "/api/projects", token, "POST", { name: "Fresh scope journey" }, 201);
    sessionId = oldProject.firstSession.id;
    freshSessionId = newProject.firstSession.id;
    const subagent = `folded-journey-${randomUUID()}`;
    scopeId = `subtask:subagent:${subagent}`;
    const observed = await call(graph, "/observe/subagent", graphToken, "POST", {
      subagent_id: subagent, session_id: sessionId, turn_id: "turn-1", objective: "Collect two papers",
      created_at: "2026-09-26T00:00:00Z", status: "running",
    });
    assert.equal(observed.status, "healthy");
    for (const name of ["first", "second"]) {
      const product = await call(graph, "/observe/tool-call", graphToken, "POST", {
        task_id: `subtask:mcp:${name}`, session_id: sessionId, turn_id: "turn-1",
        tool_name: "local_fixture_search", tool_type: "search", source: "journey", status: "completed",
        result_count: 1, parent_subagent_id: subagent,
        products: [{ product_type: "paper", link: `paper:${name}`, title: `${name} paper` }],
      });
      assert.equal(product.status, "healthy");
    }
    return "Two isolated Sessions; one scope and two child Paper observations";
  });

  await step("3. Read folded and expanded products", "Folded aggregate has two unique members and each retains via_child", async () => {
    const folded = await call(api, `/api/memory/subgraph?session_id=${encodeURIComponent(sessionId)}`, token);
    assert.equal(folded.reason, undefined);
    const aggregateId = `_group:${scopeId}:Paper`;
    const aggregate = folded.nodes.find(node => node.id === aggregateId);
    assert.equal(aggregate?.extra?.count, 2, JSON.stringify({
      nodes: folded.nodes.map(node => ({ id: node.id, label: node.label })),
      edges: folded.edges.map(edge => ({ source: edge.source, target: edge.target, type: edge.type })),
    }));
    assert.deepEqual(new Set(aggregate.extra.members), new Set(["paper:first", "paper:second"]));
    const expansion = await call(api, "/api/memory/query/group-expansion", token, "POST", {
      group_id: aggregateId, session_id: sessionId,
    });
    assert.deepEqual(new Set(expansion.nodes.map(node => node.id)), new Set(["paper:first", "paper:second"]));
    assert.deepEqual(new Set(expansion.edges.map(edge => edge.extra.via_child)), new Set([
      `${scopeId}:exec:first`, `${scopeId}:exec:second`,
    ]));
    return "Aggregate count 2; expansion has two Papers and their distinct child identities";
  });

  await step("4. Read a new session", "Unrelated historical scope does not affect an empty session's subgraph", async () => {
    const started = Date.now();
    const fresh = await call(api, `/api/memory/subgraph?session_id=${encodeURIComponent(freshSessionId)}`, token);
    assert.deepEqual(fresh.nodes, []);
    assert.deepEqual(fresh.edges, []);
    assert.equal(fresh.reason, undefined);
    assert.ok(Date.now() - started < 2_000, "new session query must remain cheap");
    return `Empty subgraph in ${Date.now() - started} ms`;
  });
  outcome = "PASS";
} catch (error) {
  console.error(redact(error.stack));
  process.exitCode = 1;
} finally {
  if (stack) {
    const stopped = stack.exitCode === null && stack.signalCode === null
      ? new Promise(done => stack.once("exit", done)) : Promise.resolve();
    try { process.kill(-stack.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    let timer;
    await Promise.race([stopped, new Promise(done => { timer = setTimeout(done, 10_000); })]);
    clearTimeout(timer);
    // start-stack launches children in the same process group. The shell may
    // exit before all of them, so finish the group before removing its data.
    try { process.kill(-stack.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const report = ["# Folded memory subgraph API journey", "",
    `Outcome: ${outcome}; SHA: ${sha}; time: ${new Date().toISOString()}`, "",
    "Environment: production local stack; isolated ports, data and uv cache; local memory backend; no model or external runtime call.",
    "Command: `node test/api/memory-folded-subgraph-journey.mjs`", "",
    ...steps.flatMap(item => [`## ${item.name}`, "", `Expected: ${item.expected}`, "", `Actual (${item.status}): ${item.actual}`, ""]),
    "Stack stopped; journey data removed. Service log retained beside this report.", ""].join("\n");
  await writeFile(resolve(root, "report.md"), report);
  await writeFile(resolve(root, "stack.log"), log);
  await rm(data, { recursive: true, force: true });
  console.log(JSON.stringify({ outcome, sha, steps: steps.length, report: resolve(root, "report.md") }));
}
