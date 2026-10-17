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
 * Purpose: Recover local and configured remote sandbox failures through explicit conversation consent, with no implicit replay.
 * Steps: Start isolated production API/Runner CLIs with missing bwrap; deny one operation; approve once and approve matching in fresh sessions; inspect execution audit, logs and workspace artifacts.
 * Environment: Committed/built task worktree, ephemeral loopback ports, isolated data, native Agent backend.
 * Type: mocked
 * LLM: local scripted OpenAI-compatible model only.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: harmless local shell/Python; separately configured loopback remote Runner; no SSH.
 * Credentials: random journey-owned tokens; no external credentials.
 * CostSideEffects: temporary local files/processes, removed in finally; no paid calls.
 * Run: node test/api/direct-execution-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit candidate before E2E");
const root = resolve(".tmp", `direct-execution-${randomUUID()}`);
await mkdir(root, { recursive: true });
const dataDir = resolve(root, "data"), token = randomUUID(), processes = [], steps = [];
let api, remoteRunner, remoteRunnerId, logs = "", calls = 0, fault = "", submissions = 0;
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const command = "printf 'once\\n' >> execution-count.txt; python3 -c 'print(6 * 7)'";
function field(content, name) {
  const text = String(content).replaceAll('\\"', '"');
  const match = text.match(new RegExp('"' + name + '"\\s*:\\s*"([^"\\n]*)"'));
  assert.ok(match, `Missing ${name} in tool result: ${text.slice(0, 1000)}`);
  return match[1];
}
const stub = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); calls++;
    // Check the actual model-facing catalog, not only the tool factory: the
    // Agent needs interpreter guidance before proposing the consent command.
    for (const name of ["request_direct_execution", "run_direct_shell"]) {
      const tool = input.tools?.find(item => item.function?.name === name);
      assert.ok(tool, `Missing model-facing tool: ${name}`);
      assert.match(tool.function.description, /PATH=\/usr\/bin:\/bin/);
      assert.match(tool.function.description, /absolute interpreter path/);
      assert.match(tool.function.description, /new consent/);
    }
    const messages = input.messages ?? [];
    const lastUser = messages.findLastIndex(message => message.role === "user");
    const history = messages.slice(lastUser + 1);
    const toolCalls = history.flatMap(message => message.tool_calls ?? []);
    const result = history.filter(message => message.role === "tool").at(-1)?.content;
    const previous = toolCalls.at(-1)?.function?.name;
    const remote = String(messages[lastUser]?.content).includes("remote target");
    let call;
    if (!String(messages[lastUser]?.content).includes("[Execution notifications]")) {
      if (!previous) call = { name: "run_shell", arguments: { command, ...(remote ? { machine: remoteRunnerId } : {}) } };
      else if (previous === "run_shell") call = { name: "request_direct_execution", arguments: { operation_id: field(result, "operationId"), command, cwd: "" } };
      else if (previous === "request_direct_execution" && !String(result).includes("Permission denied") && !String(result).includes("unknown target execution outcome")) {
        call = { name: "run_direct_shell", arguments: { authorization_id: field(result, "authorizationId"), command,
          cwd: field(result, "cwd"), target: field(result, "target"), account: field(result, "account") } };
      } else if (previous === "execution_status" && remote && fault) {
        const failed = history.find(message => message.role === "tool" && String(message.content).includes("RUNNER_UNAVAILABLE"));
        call = { name: "request_direct_execution", arguments: { operation_id: field(failed.content, "operationId"), command, cwd: "" } };
      } else if (previous === "request_direct_execution" && String(result).includes("unknown target execution outcome")) { /* stop: reconcile, never replay */ }
      else if (previous === "execution_status" && remote) call = { name: "sync_remote_workspace", arguments: { runner_id: remoteRunnerId, operation: "pull", paths: ["execution-count.txt"] } };
      else if (previous === "run_direct_shell") call = { name: "execution_status", arguments: { execution_id: field(result, "id"), wait_ms: 10000 } };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: "Direct execution decision handled; no automatic replay." };
    const frame = (value, finish_reason) => ({ id: "direct-journey", object: "chat.completion.chunk", created: 1, model: "direct-journey",
      choices: [{ index: 0, delta: value, finish_reason }] });
    response.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(frame({}, call ? "tool_calls" : "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) { response.writeHead(500).end(redact(error.stack)); }
});
// Inject transport failures only at the direct submission boundary. Never retry.
const proxy = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/direct-shell-executions") {
      submissions++;
      if (fault === "before") { response.destroy(); return; }
    }
    const upstream = await fetch(`${remoteRunner}${request.url}`, { method: request.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        ...(request.headers["x-science-execution-timestamp"] ? { "x-science-execution-timestamp": request.headers["x-science-execution-timestamp"] } : {}),
        ...(request.headers["x-science-execution-signature"] ? { "x-science-execution-signature": request.headers["x-science-execution-signature"] } : {}) },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(30000) });
    const body = await upstream.text();
    if (request.url === "/direct-shell-executions" && fault === "after") {
      assert.equal(upstream.status, 202, body); response.destroy(); return;
    }
    response.writeHead(upstream.status, { "content-type": "application/json" }); response.end(body);
  } catch (error) { response.writeHead(502).end(JSON.stringify({ error: redact(error.message) })); }
});
async function until(check) {
  const deadline = Date.now() + 45000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for session continuation");
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function start(kind, extra = {}) {
  let origin;
  const child = spawn(process.execPath, [`services/${kind}/dist/server.js`], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, TMPDIR: root, SCIENCE_AGENT_DATA_DIR: dataDir,
    SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token,
    SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
    SCIENCE_AGENT_BWRAP_PATH: resolve(root, "missing-bwrap"), SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"),
    SCIENCE_AGENT_MODEL_CATALOG_PATH: resolve(root, "absent-models"),
    SCIENCE_AGENT_MEMORY_GRAPH_URL: `http://127.0.0.1:${stub.address().port}/unused`,
    SCIENCE_AGENT_EVOLVE_URL: `http://127.0.0.1:${stub.address().port}/unused`, ...extra,
  } });
  processes.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    logs += redact(chunk);
    const match = chunk.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) origin = match[1];
  });
  await until(() => {
    if (child.exitCode !== null) throw new Error(`${kind} exited: ${logs.slice(-3000)}`);
    return origin;
  });
  return origin;
}
async function json(path, body) {
  const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${response.status}: ${redact(text)}`);
  return JSON.parse(text);
}
async function step(name, expected, operation) {
  try { steps.push({ name, expected, actual: await operation(), status: "PASS" }); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}
let outcome = "FAIL";
try {
  await new Promise(done => stub.listen(0, "127.0.0.1", done));
  await step("1. Start isolated API and unavailable-sandbox Runner", "Health remains available; sandbox cannot execute.", async () => {
    const runner = await start("runner"); api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner });
    assert.equal((await fetch(`${api}/health`)).status, 200);
    return "Production CLI services started on ephemeral loopback ports";
  });
  const model = await json("/api/models", { name: "Direct recovery", model: "direct-journey", apiToken: token,
    baseUrl: `http://127.0.0.1:${stub.address().port}/v1` });
  const project = await json("/api/projects", { name: "Direct recovery" });
  remoteRunner = await start("runner", { SCIENCE_AGENT_DATA_DIR: resolve(root, "remote-data") });
  await new Promise(done => proxy.listen(0, "127.0.0.1", done));
  const host = await json("/api/remote-hosts", { alias: "direct-recovery-remote", connectionKind: "direct",
    endpoint: { host: "127.0.0.1", port: proxy.address().port, protocol: "http" }, token });
  remoteRunnerId = host.id;
  await json(`/api/remote-hosts/${host.id}/runner/connect`, {});
  for (const machine of ["local", "remote"]) for (const decision of ["deny", "allow_once", "allow_matching"]) {
    await step(`${steps.length + 1}. ${decision} after ${machine} sandbox failure`, "Separate direct consent appears despite sandbox Always Allow; only approval plus a new tool submission executes.", async () => {
      const session = await json(`/api/projects/${project.id}/sessions`, { title: decision, modelId: model.id, runnerIds: machine === "local" ? ["local"] : [remoteRunnerId], remoteRunnerHostIds: machine === "local" ? [] : [remoteRunnerId], approvalMode: "always_allow" });
      const initial = await json(`/api/sessions/${session.id}/runs`, { content: `Direct recovery on ${machine} target: run the harmless calculation, ask me before host execution, then report its result.` });
      let pending;
      await until(async () => {
        pending = (await json(`/api/permission-requests?sessionId=${session.id}`)).find(item => item.action === "direct_code" && item.state === "pending");
        return pending;
      });
      assert.match(pending.summary, /DIRECT HOST EXECUTION.*account/);
      assert.ok(pending.summary.includes(command));
      assert.equal((await json(`/api/sessions/${session.id}/agent-activity`)).executions.length, 0);
      await json(`/api/permission-requests/${pending.id}/decision`, { decision });
      await until(async () => {
        const run = (await json(`/api/sessions/${session.id}/runs`)).find(item => item.id === initial.id);
        assert.notEqual(run.status, "failed", run.error);
        return run.status === "completed";
      });
      const activity = await json(`/api/sessions/${session.id}/agent-activity`);
      if (decision === "deny") {
        assert.equal(activity.executions.length, 0);
        assert.equal((await json(`/api/sessions/${session.id}/execution-runs`)).length, 0);
        return "Denied: no execution or execution audit was created";
      }
      assert.equal(activity.executions.length, 1);
      assert.equal(activity.executions[0].state, "completed");
      const recorded = await json(`/api/sessions/${session.id}/execution-runs`);
      assert.equal(recorded.length, 1); assert.equal(recorded[0].exitCode, 0);
      assert.equal(recorded[0].sandbox, "none"); assert.equal(recorded[0].networkPolicy, "host");
      assert.ok(recorded[0].directAuthorization.authorizationId);
      assert.equal(recorded[0].tool, "run_direct_shell");
      assert.equal(recorded[0].runnerId, machine === "local" ? "local" : remoteRunnerId);
      assert.equal(activity.executions[0].runnerId, recorded[0].runnerId);
      assert.ok(activity.executions[0].result.workspaceVersion);
      if (machine === "remote") {
        assert.equal(activity.executions[0].result.workspaceVersion.runnerId, remoteRunnerId);
        assert.ok(recorded[0].directAuthorization.runnerWorkspaceKey);
        const transfers = await json(`/api/sessions/${session.id}/remote-workspace/sync-records`);
        assert.equal(transfers.length, 1); assert.equal(transfers[0].status, "completed");
        const file = await fetch(`${api}/api/sessions/${session.id}/file?path=execution-count.txt`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(await file.text(), "once\n");
      }
      const provenance = await json(`/api/sessions/${session.id}/workspace/provenance?path=execution-count.txt`);
      if (machine === "local") {
        assert.equal(provenance.currentRevision.toolName, "run_direct_shell");
        assert.equal(provenance.currentRevision.executionRunId, recorded[0].id);
      } else assert.ok(provenance.currentRevision, "explicitly transferred remote file has provenance");
      const output = await json(`/api/sessions/${session.id}/agent-activity/executions/${activity.executions[0].id}/logs`);
      assert.match(output.chunks.map(chunk => chunk.text).join(""), /42/);
      const listing = await json(`/api/runners/${machine === "local" ? "local" : remoteRunnerId}/workspaces/${session.id}/files`);
      assert.ok(listing.files.some(file => file.path === "execution-count.txt"));
      return "One committed execution, exit 0, stdout 42, explicit direct audit and workspace artifact";
    });
  }
  for (const failure of ["before", "after"]) {
    await step(`${steps.length + 1}. Remote disconnect ${failure} acceptance`, "Lost dispatch outcome stays unknown; further host consent is blocked and side effects are never replayed.", async () => {
      fault = failure; submissions = 0;
      const session = await json(`/api/projects/${project.id}/sessions`, { title: `disconnect-${failure}`, modelId: model.id,
        runnerIds: [remoteRunnerId], remoteRunnerHostIds: [remoteRunnerId], approvalMode: "always_allow" });
      const initial = await json(`/api/sessions/${session.id}/runs`, { content: "Direct recovery on remote target; do the harmless calculation with consent." });
      let pending;
      await until(async () => (pending = (await json(`/api/permission-requests?sessionId=${session.id}`)).find(item => item.action === "direct_code" && item.state === "pending")));
      await json(`/api/permission-requests/${pending.id}/decision`, { decision: "allow_once" });
      await until(async () => {
        const run = (await json(`/api/sessions/${session.id}/runs`)).find(item => item.id === initial.id);
        assert.notEqual(run.status, "failed", run.error); return run.status === "completed";
      });
      const activity = await json(`/api/sessions/${session.id}/agent-activity`);
      assert.equal(activity.executions.length, 1); assert.equal(activity.executions[0].state, "unknown");
      assert.equal(submissions, 1);
      const recorded = await json(`/api/sessions/${session.id}/execution-runs`);
      assert.equal(recorded.length, 1); assert.equal(recorded[0].runnerId, remoteRunnerId);
      const pendingAgain = (await json(`/api/permission-requests?sessionId=${session.id}`)).filter(item => item.state === "pending");
      assert.equal(pendingAgain.length, 0);
      const listing = await json(`/api/runners/${remoteRunnerId}/workspaces/${session.id}/files`);
      if (failure === "after") {
        await until(async () => {
          const response = await fetch(`${remoteRunner}/shell-executions/${activity.executions[0].id}?${new URLSearchParams({ sessionId: session.id, agentId: "main" })}`,
            { headers: { authorization: `Bearer ${token}` } });
          const execution = await response.json(); assert.equal(response.status, 200);
          return execution.state === "completed";
        });
        const response = await fetch(`${remoteRunner}/remote-workspace/file?${new URLSearchParams({ workspace: listing.workspaceKey, path: "execution-count.txt" })}`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200); assert.equal(await response.text(), "once\n");
      } else assert.equal(listing.files.length, 0);
      fault = "";
      return `One submission attempt, unknown API outcome; ${failure === "after" ? "one remote side effect reconciled by original Execution ID" : "zero host side effects"}; no replay or second consent`;
    });
  }
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
finally {
  await writeFile(resolve(root, "report.md"), `# Direct execution journey\n\nResult: ${outcome}\n\nTarget: ${sha}\n\nCommand: node test/api/direct-execution-journey.mjs\n\nEnvironment: production API/Runner CLIs, native backend, local scripted model, missing bwrap; no paid calls; separately configured loopback remote Runner. Model requests: ${calls}.\n\n${steps.map(item => `## ${item.name}\n\nExpected: ${item.expected}\n\nActual: ${item.actual}\n\n${item.status}\n`).join("\n")}\n`);
  await writeFile(resolve(root, "services.log"), logs);
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise(resolveDone => child.once("exit", resolveDone)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await done; clearTimeout(timer);
  }
  proxy.closeAllConnections(); if (proxy.listening) await new Promise(done => proxy.close(done));
  stub.closeAllConnections(); await new Promise(done => stub.close(done));
  await rm(dataDir, { recursive: true, force: true });
  await rm(resolve(root, "remote-data"), { recursive: true, force: true });
  console.log(`${outcome}: ${steps.filter(item => item.status === "PASS").length}/${steps.length} steps; report ${resolve(root, "report.md")}`);
}
