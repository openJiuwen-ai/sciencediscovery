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
 * Purpose: Grant scoped sandbox egress and recover an observed denial without replaying side effects.
 * Steps: Start production API/Runner CLIs; deny and approve explicit hosts in none mode; approve a live allowlist denial; issue a safe new retrieval and inspect output, execution audit and unchanged settings.
 * Environment: Committed/built task worktree; Linux bubblewrap; isolated native API/Runner; ephemeral ports/data; localhost.localdomain must resolve to loopback (no fake-IP DNS).
 * Type: mocked
 * LLM: Local scripted OpenAI-compatible model only.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: Local HTTP fixture reached as localhost.localdomain; isolated allowlist scenario explicitly enables private addresses. No public upstream requests.
 * Credentials: Random local tokens, no external credentials.
 * CostSideEffects: Temporary files/processes cleaned up; no paid calls.
 * Run: node test/api/sandbox-network-consent-journey.mjs
 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit candidate before E2E");
const root = resolve(".tmp", `sn-${randomUUID().slice(0, 8)}`);
await mkdir(root, { recursive: true });
const dataDir = resolve(root, "data"), token = randomUUID(), processes = [], steps = [];
let api, logs = "", calls = 0;
const redact = value => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
let targetCalls = 0, configuredCalls = 0;
const target = createServer((_req, res) => { targetCalls++; res.end("LOCAL_RETRIEVAL_OK"); });
const configuredTarget = createServer((_req, res) => { configuredCalls++; res.end("CONFIGURED_HOST_OK"); });
const field = (content, name) => {
  const text = String(content).replaceAll('\\"', '"');
  const match = text.match(new RegExp('"' + name + '"\\s*:\\s*"([^"\\n]*)"'));
  assert.ok(match, `Missing ${name}: ${text.slice(0, 1500)}`); return match[1];
};
const stub = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); calls++;
    assert.ok(input.tools?.some(x => x.function?.name === "request_sandbox_network"), "Missing model-facing consent tool");
    const messages = input.messages ?? [], lastUser = messages.findLastIndex(x => x.role === "user");
    const history = messages.slice(lastUser + 1), toolCalls = history.flatMap(x => x.tool_calls ?? []);
    const previous = toolCalls.at(-1)?.function?.name;
    const content = String(history.filter(x => x.role === "tool").at(-1)?.content ?? "").replaceAll('\\"', '"');
    if (previous) console.log(`Model observed ${previous}: ${redact(content).slice(0, 1400)}`);
    const gateway = String(messages[lastUser]?.content).includes("gateway recovery");
    let call;
    const configuredCommand = `python3 -c 'import urllib.request; print(urllib.request.urlopen("http://localhost.localdomain:${configuredTarget.address().port}/configured",timeout=3).read().decode())'`;
    const retrievalCommand = `python3 -c 'import urllib.request; print(urllib.request.urlopen("http://localhost.localdomain:${target.address().port}/records",timeout=3).read().decode())'`;
    const command = `${configuredCommand}; ${retrievalCommand}`;
    if (!String(messages[lastUser]?.content).includes("[Execution notifications]")) {
      if (!previous) call = gateway
        ? { name: "run_shell", arguments: { command: "printf 'initial-side-effect\\n' >> attempt.txt; " + command } }
        : { name: "request_sandbox_network", arguments: { hosts: ["pubmed.ncbi.nlm.nih.gov:443"], purpose: "Retrieve requested PubMed records" } };
      else if (previous === "request_sandbox_network" && /"state"\s*:\s*"allowed"/.test(content)) {
        call = { name: "run_shell", arguments: { command: "printf CONSENT_OK", network_authorization_id: field(content, "authorizationId") } };
      } else if (["run_shell", "execution_status"].includes(previous)) {
        if (/"state"\s*:\s*"(?:running|queued)"/.test(content)) {
          call = { name: "execution_status", arguments: { execution_id: field(content, "id"), wait_ms: 10000 } };
        } else if (gateway && toolCalls.filter(x => x.function?.name === "run_shell").length === 1 && String(content).includes('"authorizationId"')) {
          call = { name: "run_shell", arguments: { command, network_authorization_id: field(content, "authorizationId") } };
        }
      }
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: /"state"\s*:\s*"blocked"/.test(content) ? "Required retrieval is blocked and incomplete; no web-search fallback." : "Decision handled. Inspect the recorded retrieval outcome; no automatic replay." };
    const frame = (value, finish_reason) => ({ id: "network-journey", object: "chat.completion.chunk", created: 1, model: "network-journey", choices: [{ index: 0, delta: value, finish_reason }] });
    response.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(frame({}, call ? "tool_calls" : "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) { response.writeHead(500).end(redact(error.stack)); }
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
    SCIENCE_AGENT_BWRAP_PATH: "/usr/bin/bwrap", SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"),
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
async function json(path, body, method = "POST") {
  const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
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
  const local = await lookup("localhost.localdomain");
  assert.ok(["::1", "127.0.0.1"].includes(local.address), "Fixture host must resolve locally");
  await new Promise(done => target.listen(0, local.address, done));
  await new Promise(done => configuredTarget.listen(0, local.address, done));
  await step("1. Start isolated production API/Runner", "Sandbox is usable; default policy is none.", async () => {
    const runner = await start("runner"); api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner });
    assert.equal((await json("/api/sandbox-network-settings")).mode, "none"); return "Production services started; default none confirmed";
  });
  const model = await json("/api/models", { name: "Network consent", model: "network-journey", apiToken: token, baseUrl: `http://127.0.0.1:${stub.address().port}/v1` });
  const project = await json("/api/projects", { name: "Network consent" });
  for (const scenario of ["deny", "allow_once", "allow_matching", "always_allow", "gateway recovery"]) {
    await step(`${steps.length + 1}. ${scenario}`, "Consent is scoped; no egress before approval, denial stays offline, approval never replays previous side effects.", async () => {
      if (scenario === "gateway recovery") await json("/api/sandbox-network-settings", { mode: "domain-allowlist", allowedDomains: [`localhost.localdomain:${configuredTarget.address().port}`], allowPrivateNetwork: true }, "PUT");
      const before = await json("/api/sandbox-network-settings");
      const session = await json(`/api/projects/${project.id}/sessions`, { title: scenario, modelId: model.id, runnerIds: ["local"], approvalMode: scenario === "always_allow" ? "always_allow" : "ask_for_dangerous" });
      // Approve ordinary code separately so this journey focuses on network consent.
      if (scenario !== "always_allow") {
        const check = await json(`/api/sessions/${session.id}/permission-requests`, { action: "code", resource: "workspace-code", summary: "Run local journey fixture" });
        await json(`/api/permission-requests/${check.request.id}/decision`, { decision: "allow_matching" });
      }
      const initial = await json(`/api/sessions/${session.id}/runs`, { content: scenario === "gateway recovery" ? "gateway recovery: retrieve the local records and reconcile the first attempt before retry." : "Explicitly request sandbox access for PubMed. Report denial as blocked." });
      let card;
      if (scenario !== "always_allow") {
        await until(async () => {
          card = (await json(`/api/permission-requests?sessionId=${session.id}`)).find(x => x.action === "sandbox_network" && x.state === "pending");
          return card;
        });
        assert.match(card.summary, scenario === "gateway recovery" ? /localhost.localdomain/ : /pubmed.ncbi.nlm.nih.gov:443.*Retrieve requested PubMed/);
        assert.equal(targetCalls, 0);
        if (scenario === "gateway recovery") assert.equal(configuredCalls, 1, "configured host is available before new consent");
        const executions = (await json(`/api/sessions/${session.id}/agent-activity`)).executions;
        assert.equal(executions.length, scenario === "gateway recovery" ? 1 : 0);
        await json(`/api/permission-requests/${card.id}/decision`, { decision: scenario === "gateway recovery" ? "allow_once" : scenario });
      }
      await until(async () => {
        const run = (await json(`/api/sessions/${session.id}/runs`)).find(x => x.id === initial.id);
        assert.notEqual(run.status, "failed", run.error); return run.status === "completed";
      });
      const recorded = await json(`/api/sessions/${session.id}/execution-runs`);
      assert.deepEqual(await json("/api/sandbox-network-settings"), before);
      if (scenario === "deny") {
        assert.equal(recorded.length, 0); return "Denied: no execution, no network connection, global none unchanged";
      }
      assert.equal(recorded.length, scenario === "gateway recovery" ? 2 : 1);
      assert.ok(recorded.every(x => x.networkPolicy === "domain-allowlist"));
      assert.equal(recorded.filter(x => x.exitCode === 0).length, 1);
      if (scenario === "gateway recovery") {
        assert.equal(targetCalls, 1, "only safe new call reaches target after consent");
        assert.equal(configuredCalls, 2, "retry keeps configured capability and approved extra host together");
        const fs = await import("node:fs/promises");
        const path = resolve(dataDir, "projects", project.id, "sessions", session.id, "workspace", "attempt.txt");
        assert.equal(await fs.readFile(path, "utf8"), "initial-side-effect\n", "the side-effecting first command must never be replayed");
        const activity = await json(`/api/sessions/${session.id}/agent-activity`);
        assert.equal(activity.executions.filter(x => x.state === "failed").length, 1);
        assert.equal(activity.executions.filter(x => x.state === "completed").length, 1);
        const stdout = await json(`/api/sessions/${session.id}/agent-activity/executions/${activity.executions.find(x => x.state === "completed").id}/logs`);
        assert.match(stdout.chunks.map(x => x.text).join(""), /LOCAL_RETRIEVAL_OK/);
        return "Denied execution recorded as failed; one approved new retrieval reached local target exactly once; first command was never replayed; configured host remains available on retry";
      }
      return "Explicit consent produced one new scoped execution; global none unchanged";
    });
  }
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
finally {
  await writeFile(resolve(root, "report.md"), `# Sandbox network consent journey\n\nResult: ${outcome}\n\nTarget: ${sha}\n\nCommand: node test/api/sandbox-network-consent-journey.mjs\n\nEnvironment: production native API/Runner CLIs, local scripted model and HTTP target; no paid calls. Model requests: ${calls}.\n\n${steps.map(item => `## ${item.name}\n\nExpected: ${item.expected}\n\nActual: ${item.actual}\n\n${item.status}\n`).join("\n")}\n`);
  await writeFile(resolve(root, "services.log"), logs);
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise(resolveDone => child.once("exit", resolveDone)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await done; clearTimeout(timer);
  }
  stub.closeAllConnections(); await new Promise(done => stub.close(done));
  target.closeAllConnections(); await new Promise(done => target.close(done));
  configuredTarget.closeAllConnections(); await new Promise(done => configuredTarget.close(done));
  await rm(dataDir, { recursive: true, force: true });
  console.log(`${outcome}: ${steps.filter(item => item.status === "PASS").length}/${steps.length} steps; report ${resolve(root, "report.md")}`);
}
