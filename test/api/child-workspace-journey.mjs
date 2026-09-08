// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Delegate selected input to an independent child Workspace and retrieve its local Artifact.
 * Steps: Start isolated CLI services; create Session/input; delegate; verify child output and parent isolation.
 * Environment: Built and committed task worktree; production API/Runner CLI, ephemeral loopback ports and .tmp data.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible stub.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: local bubblewrap Shell; scientific package setup disabled.
 * Credentials: randomly generated in memory; no external credentials.
 * CostSideEffects: temporary local processes and records, removed in finally; no external calls or charges.
 * Run: node test/api/child-workspace-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Error("Commit candidate before E2E");
const root = resolve(".tmp", `child-workspace-journey-${randomUUID()}`);
await mkdir(root, { recursive: true });
const dataDir = resolve(root, "data");
const token = randomUUID();
const processes = [];
const steps = [];
const requests = [];
let api;
let logs = "";
const redact = (value) => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const stub = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(input);
    const child = input.messages?.some((message) => message.role === "system" && message.content?.includes("Applied subagent preset general-purpose"));
    const results = input.messages?.filter((message) => message.role === "tool") ?? [];
    let call;
    if (!child && !results.length) call = { name: "task", arguments: {
      description: "Inspect selected file", prompt: "Use selected.txt; verify no hidden.txt is available, change your copy, and declare result.txt as an Artifact.",
      inputPaths: ["selected.txt"], subagent_type: "general-purpose",
    } };
    if (child && results.length === 0) call = { name: "run_shell", arguments: { command:
      "test -f selected.txt && test ! -f hidden.txt && printf 'child copy' > selected.txt && printf 'isolated result' > result.txt && echo isolated" } };
    if (child && results.length === 1) call = { name: "declare_artifact", arguments: { path: "result.txt", name: "Independent child result" } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${child ? "child" : "main"}-${results.length}`,
      type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: child ? "Delivered isolated result." : "Child result is available." };
    const frame = (value, finish_reason) => ({ id: "journey", object: "chat.completion.chunk", created: 1, model: "journey",
      choices: [{ index: 0, delta: value, finish_reason }] });
    response.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(frame({}, call ? "tool_calls" : "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) { response.writeHead(500).end(String(error)); }
});
async function until(check) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out awaiting user-visible result");
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function start(kind, extra) {
  let origin;
  const child = spawn(process.execPath, [`services/${kind}/dist/server.js`], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, TMPDIR: root, SCIENCE_AGENT_DATA_DIR: dataDir,
    SCIENCE_AGENT_AUTH_TOKEN: token, SCIENCE_AGENT_RUNNER_TOKEN: token,
    SCIENCE_AGENT_HOST: "127.0.0.1", SCIENCE_AGENT_PORT: "0", SCIENCE_AGENT_RUNNER_HOST: "127.0.0.1", SCIENCE_AGENT_RUNNER_PORT: "0",
    SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-config"),
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
    if (child.exitCode !== null) throw new Error(`${kind} exited: ${logs}`);
    return origin;
  });
  return origin;
}
async function json(path, body) {
  const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  assert.ok(response.ok, `${path}: HTTP ${response.status}: ${redact(text)}`);
  return JSON.parse(text);
}
async function step(name, expected, operation) {
  try { steps.push({ name, expected, actual: await operation(), status: "PASS" }); }
  catch (error) { steps.push({ name, expected, actual: redact(error.stack), status: "FAIL" }); throw error; }
}
let session;
let outcome = "FAIL";
try {
  await new Promise((done) => stub.listen(0, "127.0.0.1", done));
  await step("1. 启动独立产品服务", "生产 API/Runner CLI 就绪，不复用现有部署。", async () => {
    const runner = await start("runner");
    api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner });
    const health = await fetch(`${runner}/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    assert.equal((await fetch(`${api}/health`)).status, 200);
    return `API ${api}; Runner ${runner}; health 200`;
  });
  await step("2. 创建会话并准备明确输入", "父 Workspace 有选定输入和未交付私有文件。", async () => {
    const model = await json("/api/models", { name: "Workspace journey", model: "journey", apiToken: token,
      baseUrl: `http://127.0.0.1:${stub.address().port}/v1` });
    const project = await json("/api/projects", { name: "Workspace isolation journey" });
    session = await json(`/api/projects/${project.id}/sessions`, { title: "Explicit handoff", modelId: model.id, approvalMode: "always_allow" });
    await json(`/api/sessions/${session.id}/files`, { path: "selected.txt", content: "parent original" });
    await json(`/api/sessions/${session.id}/files`, { path: "hidden.txt", content: "not delivered" });
    return "Project/Session created; selected.txt and hidden.txt saved through HTTP";
  });
  await step("3. 委派子 Agent 执行并声明本地产物", "子 Agent 只能看到选定文件，Shell 完成，产物可查询。", async () => {
    const response = await fetch(`${api}/api/sessions/${session.id}/messages`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ content: "Delegate selected.txt only and deliver the result." }),
      signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /"type":"run.completed"/);
    const children = await json(`/api/sessions/${session.id}/subagents`);
    assert.equal(children.length, 1);
    assert.equal(children[0].status, "completed");
    assert.match(children[0].handoff.workspaceId, /^ws_/);
    const tools = children[0].steps.filter((item) => item.kind === "tool");
    assert.deepEqual(tools.map((item) => [item.toolName, item.status]), [["run_shell", "completed"], ["declare_artifact", "completed"]], redact(JSON.stringify(tools)));
    assert.match(tools[0].content, /isolated/);
    const artifacts = await json(`/api/sessions/${session.id}/artifacts`);
    assert.equal(artifacts.filter((artifact) => artifact.logicalName === "Independent child result").length, 1);
    return "Child completed; independent Workspace ID; Shell and local Artifact declaration completed";
  });
  await step("4. 核对父目录未被隐式修改", "父输入仍为原内容，子 Agent 文件不作为父目录子树出现。", async () => {
    const files = await json(`/api/sessions/${session.id}/files`);
    assert.ok(files.some((file) => file.path === "selected.txt"));
    assert.equal(files.some((file) => file.path.startsWith("subagents/") || file.path === "result.txt"), false);
    const input = await fetch(`${api}/api/sessions/${session.id}/file?path=selected.txt`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(input.status, 200);
    assert.equal(await input.text(), "parent original");
    return "Parent selected.txt unchanged; no implicit child directory or result.txt";
  });
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
finally {
  await writeFile(resolve(root, "report.md"), `# Independent child Workspace journey\n\nResult: ${outcome}\n\nTarget: ${sha}\n\nCommand: node test/api/child-workspace-journey.mjs\n\nEnvironment: isolated task worktree, production API/Runner CLI, local stub model, scientific setup disabled; no Web/remote SSH/environment provisioning coverage.\n\n${steps.map((item) => `## ${item.name}\n\nExpected: ${item.expected}\n\nActual: ${item.actual}\n\n${item.status}\n`).join("\n")}\n## Diagnostic log\n\n\`\`\`text\n${logs.slice(-6000)}\n\`\`\`\n`);
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise((resolveDone) => child.once("exit", resolveDone));
    child.kill("SIGTERM"); await done;
  }
  stub.closeAllConnections();
  await new Promise((done) => stub.close(done));
  await rm(dataDir, { recursive: true, force: true });
  console.log(`${outcome}: ${steps.filter((item) => item.status === "PASS").length}/4 steps; report under .tmp/child-workspace-journey-*/report.md`);
}
