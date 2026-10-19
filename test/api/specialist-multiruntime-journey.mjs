// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Main-agent configuration and concurrent Claude Code/ACP specialists with independent Workspace/Runner execution.
 * Steps: Start isolated API/Runner; configure via main tool; delegate two tasks; submit private cards; inspect declared artifacts and diagnostics; cancel one child while its sibling completes.
 * Environment: Committed built worktree, Linux bubblewrap, ephemeral ports/data.
 * Type: mocked
 * LLM: Scripted main-agent HTTP model and executable Claude/ACP protocol fixtures; real platform tools and Runner.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: Local sandboxed shell only; no live provider API calls.
 * Credentials: Synthetic phase3-fixture-secret sent through config API only.
 * CostSideEffects: Creates and removes temporary project, sessions, specialists and child processes.
 * Run: node test/api/specialist-multiruntime-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";


const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit candidate before E2E");
const root = resolve(".tmp", `specialist-p3-${randomUUID()}`); await mkdir(root, { recursive: true });
const token = randomUUID(); const key = "phase3-fixture-secret";
const processes = []; const steps = []; let logs = ""; let api; let active;
const redact = value => String(value).replaceAll(key, "[redacted]").replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const stub = createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  assert.equal(raw.includes(key), false);
  const stage = active.stage++;
  const calls = stage === 0 ? active.specialists.map(specialist => ({ name: "configure_specialist_runtime", arguments: { specialistId: specialist.id, settings: { model: "fixture-model", fallback: active.fallback } } }))
    : stage === 1 ? active.specialists.map(specialist => ({ name: "task", arguments: { specialistId: specialist.id, description: specialist.runtime.kind,
      prompt: active.cancel && specialist.runtime.kind === "acp" ? "[hold]" : "Create and declare result.txt, keep scratch.txt private.", max_turns: 4 } })) : [];
  const delta = calls.length ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call_${randomUUID()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { role: "assistant", content: "Both delegations settled." };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (delta, finish_reason) => ({ id: "lead", object: "chat.completion.chunk", created: 1, model: "lead", choices: [{ index: 0, delta, finish_reason }] });
  res.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
  res.write(`data: ${JSON.stringify(frame({}, calls.length ? "tool_calls" : "stop"))}\n\n`);
  res.end("data: [DONE]\n\n");
});
async function until(check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 50)); }
  throw new Error("Timed out awaiting observable product state");
}
async function start(kind, extra = {}) {
  let origin;
  const child = spawn(process.execPath, [`services/${kind}/dist/server.js`], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, TMPDIR: root, SCIENCE_DISCOVERY_DATA_DIR: resolve(root, "data"), SCIENCE_AGENT_DATA_DIR: resolve(root, "data"),
    SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token, SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0",
    SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0", SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0",
    SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"), SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
    SCIENCE_AGENT_MEMORY_GRAPH_URL: "http://127.0.0.1:1", SCIENCE_AGENT_EVOLVE_URL: "http://127.0.0.1:1", ...extra,
  } });
  processes.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    logs += redact(chunk); const match = chunk.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/); if (match) origin = match[1];
  });
  return until(() => { assert.equal(child.exitCode, null, logs); return origin; });
}
async function json(path, body, method) {
  const response = await fetch(`${api}${path}`, { method: method ?? (body ? "POST" : "GET"), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await response.text(); assert.ok(response.ok, `${path}: HTTP ${response.status}: ${redact(text)}`); return text ? JSON.parse(text) : undefined;
}
async function step(name, expected, operation) {
  try { const actual = await operation(); steps.push({ name, expected, actual, status: "PASS" }); console.log(`PASS: ${name}`); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}

let outcome = "FAIL"; let project;
try {
  await new Promise(done => stub.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${stub.address().port}/v1`;
  await step("1. Start isolated production API and Runner", "Both health checks succeed", async () => {
    const runner = await start("runner");
    api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner,
      SCIENCE_AGENT_CLAUDE_BINARY: resolve("test/api/fixtures-specialist-runtime.cjs"), SCIENCE_AGENT_ACP_BINARY: resolve("test/api/fixtures-specialist-runtime.cjs") });
    assert.equal((await fetch(`${api}/health`)).status, 200); return "API and Runner healthy";
  });
  const model = await json("/api/models", { name: "Phase3 lead", model: "lead", apiToken: token, baseUrl: endpoint });
  for (const mode of ["handoff", "cancel", "fallback"]) {
    const cancel = mode === "cancel"; const fallback = mode === "fallback";
    project = await json("/api/projects", { name: "Phase3 independent runtimes" });
    await step(`${steps.length + 1}. ${cancel ? "Cancel ACP while Claude completes" : fallback ? "ACP unavailable with counted native recovery" : "Concurrent Claude/ACP handoff"}`, "Two pending children overlap, credentials stay private, independent results settle", async () => {
      const specialists = [];
      for (const kind of ["claude-code", "acp"]) specialists.push(await json("/api/specialists", { name: kind, description: "Phase3", instructions: "Use only platform tools", runtime: { kind, timeoutSeconds: 30 } }));
      active = { stage: 0, cancel, fallback, specialists };
      const session = await json(`/api/projects/${project.id}/sessions`, { title: cancel ? "Cancel sibling" : "Concurrent handoff", modelId: model.id, approvalMode: "always_allow" });
      const response = await fetch(`${api}/api/sessions/${session.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ content: `Configure both specialists with fixture-model and fallback=${fallback}, then delegate independent tasks concurrently.` }) });
      assert.equal(response.status, 200); const stream = response.text();
      const children = await until(async () => { const list = await json(`/api/sessions/${session.id}/subagents`); return list.length === 2 && list.every(child => child.runtimeInput?.state === "pending") && list; });
      assert.notEqual(children[0].id, children[1].id);
      for (const child of children) {
        assert.equal(child.runtimeOptions.model, "fixture-model"); assert.equal(child.runtimeOptions.fallback, fallback);
        await json(`/api/subagents/${child.id}/runtime-config`, { inputId: child.runtimeInput.id, apiKey: fallback && child.runtimeOptions.kind === "acp" ? "rejected-fixture-secret" : key });
      }
      if (cancel) {
        const acp = children.find(child => child.runtimeOptions.kind === "acp");
        await until(async () => { const list = await json(`/api/sessions/${session.id}/subagents`); return list.some(child => child.runtimeOptions.kind === "claude-code" && child.status === "completed") && list.some(child => child.id === acp.id && child.status === "running"); });
        await json(`/api/sessions/${session.id}/subagents/${acp.id}/stop`, {});
      }
      const terminal = await until(async () => { const list = await json(`/api/sessions/${session.id}/subagents`); return list.length === 2 && list.every(child => child.status !== "running") && list; });
      assert.match(await stream, /"type":"run.completed"/);
      assert.equal(JSON.stringify(terminal).includes(key), false);
      for (const child of terminal) {
        const stopped = cancel && child.runtimeOptions.kind === "acp";
        assert.equal(child.status, stopped ? "cancelled" : "completed", JSON.stringify(child));
        const recovered = fallback && child.runtimeOptions.kind === "acp";
        assert.equal(child.runtimeDiagnostics?.sandboxProbe?.ok, !recovered);
        assert.equal(child.runtimeDiagnostics?.fallbackCount, recovered ? 1 : 0);
        if (recovered) assert.equal(child.runtimeDiagnostics.failureReason, "unavailable");
        if (stopped) assert.equal(child.runtimeDiagnostics.failureReason, "cancelled");
        else if (!recovered) {
          const shell = child.steps.find(step => step.toolName === "run_shell");
          assert.equal(shell?.status, "completed"); assert.ok(shell.details?.id); assert.equal(shell.details.agentId, `subagent:${child.id}`); assert.ok(shell.details.workspaceId);
        }
      }
      if (!cancel && !fallback) {
        const executions = terminal.map(child => child.steps.find(step => step.toolName === "run_shell").details.id);
        assert.notEqual(executions[0], executions[1]);
        const shells = terminal.map(child => child.steps.find(step => step.toolName === "run_shell").details);
        assert.notEqual(shells[0].workspaceId, shells[1].workspaceId);
        assert.ok(Math.max(...shells.map(item => Date.parse(item.startedAt))) < Math.min(...shells.map(item => Date.parse(item.finishedAt))), "Runner execution intervals must overlap");
      }
      const artifacts = await json(`/api/sessions/${session.id}/artifacts`);
      assert.equal(artifacts.length, cancel || fallback ? 1 : 2); assert.ok(artifacts.every(item => ["claude-code-result.txt", "acp-result.txt"].includes(item.logicalName)));
      await json(`/api/sessions/${session.id}`, { confirmationId: session.id }, "DELETE");
      for (const specialist of specialists) await json(`/api/specialists/${specialist.id}`, undefined, "DELETE");
      await json(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE"); project = undefined;
      return `${terminal.map(child => `${child.runtimeOptions.kind}=${child.status}`).join(", ")}; ${artifacts.length} declared artifacts; isolated workspaces; no secret in records`;
    });
  }
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
finally {
  if (project && api) await json(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE").catch(() => {});
  for (const child of processes.reverse()) { child.kill("SIGTERM"); await Promise.race([new Promise(done => child.once("exit", done)), new Promise(done => setTimeout(done, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
  stub.closeAllConnections(); await new Promise(done => stub.close(done));
  await writeFile(resolve(root, "report.md"), redact(`# Phase3: ${outcome}\nSHA: ${sha}\nMode: mocked Claude/ACP protocol processes; production API/Runner/platform sandbox.\n\n${steps.map(item => `## ${item.name}: ${item.status}\nExpected: ${item.expected}\nActual: ${item.actual}\n`).join("\n")}\nCounts: ${steps.filter(step => step.status === "PASS").length} passed / ${steps.filter(step => step.status === "FAIL").length} failed / ${4 - steps.length} unexecuted.\n`));
  await writeFile(resolve(root, "services.log"), logs); await rm(resolve(root, "data"), { recursive: true, force: true });
  console.log(`Evidence: ${root}/report.md`);
}
