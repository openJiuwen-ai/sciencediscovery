// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Delegate selected input to an independent child Workspace and retrieve its local Artifact.
 * Steps: Start isolated CLI services; create Session/input; delegate; verify child output/parent isolation; legacy sync; Evolution export during a write.
 * Environment: Built and committed task worktree; production API/Runner CLI, ephemeral loopback ports and .tmp data.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible stub.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: local bubblewrap Shell and journey-owned Evolution sidecar stub; scientific package setup disabled.
 * Credentials: randomly generated in memory; no external credentials.
 * CostSideEffects: temporary local processes and records, removed in finally; no external calls or charges.
 * Run: node test/api/child-workspace-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { RunnerClient } from "../../packages/executor/dist/index.js";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Error("Commit candidate before E2E");
const root = resolve(".tmp", `child-workspace-journey-${randomUUID()}`);
await mkdir(root, { recursive: true });
const dataDir = resolve(root, "data");
const token = randomUUID();
const processes = [];
const steps = [];
const requests = [];
const evolutionExports = [];
let api;
let runnerOrigin;
let remoteRunnerId;
let logs = "";
const redact = (value) => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const stub = createServer(async (request, response) => {
  try {
    if (request.url === "/evolve/health") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === "/evolve/probe" || request.url === "/evolve/runs") {
      evolutionExports.push({ baseline: input.baseline_code,
        solver: await readFile(resolve(input.workspace_dir, "solver.py"), "utf8"),
        test: await readFile(resolve(input.workspace_dir, "test.py"), "utf8") });
      if (request.url.endsWith("/probe")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ baseline: 0.4, worsened: 0.1, flat: false, label: "constant" }));
      return response.writeHead(200, { "content-type": "application/x-ndjson" }).end(JSON.stringify({ sequence: 1, createdAt: new Date().toISOString(),
        event: { type: "search_finished", status: "succeeded", candidates: 0, bestNodeIndex: null } }) + "\n");
    }
    requests.push(input);
    const child = input.messages?.some((message) => message.role === "system" && message.content?.includes("Applied subagent preset general-purpose"));
    const legacy = input.messages?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Legacy sync roundtrip"));
    const evolution = input.messages?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Evolution committed export"));
    const results = input.messages?.filter((message) => message.role === "tool") ?? [];
    let call;
    if (!child && !results.length) call = { name: "task", arguments: {
      description: "Inspect selected file", prompt: "Use selected.txt; verify no hidden.txt is available, change your copy, and declare result.txt as an Artifact.",
      inputPaths: ["selected.txt"], subagent_type: "general-purpose",
    } };
    if (child && results.length === 0) call = { name: "run_shell", arguments: { command:
      "test -f selected.txt && test ! -f hidden.txt && printf 'child copy' > selected.txt && printf 'isolated result' > result.txt && echo isolated" } };
    if (child && results.length === 1) call = { name: "workspace_transfer", arguments: { operation: "workspaces" } };
    if (child && results.length === 2) {
      const workspace = JSON.stringify(results[1]).match(/ws_[a-z0-9]+/)?.[0];
      assert.ok(workspace, "child must discover its owned Workspace ID");
      call = { name: "workspace_transfer", arguments: { operation: "start", source_workspace_id: workspace, target_workspace_id: workspace,
        files: [{ source_path: "result.txt", target_path: "copied-result.txt" }] } };
    }
    if (child && results.length >= 3) {
      const text = JSON.stringify(results.at(-1)).replaceAll('\\"', '"');
      const artifactDone = text.includes("Independent child result");
      if (!artifactDone) {
        const id = JSON.stringify(results[2]).replaceAll('\\"', '"').match(/"id"\s*:\s*"([a-f0-9-]{36})"/)?.[1];
        assert.ok(id, "Transfer submission must return an ID");
        call = /"state"\s*:\s*"completed"/.test(text)
          ? { name: "declare_artifact", arguments: { path: "copied-result.txt", name: "Independent child result" } }
          : { name: "workspace_transfer", arguments: { operation: "status", transfer_id: id } };
      }
    }
    if (legacy) {
      call = results.length < 2
        ? { name: "sync_remote_workspace", arguments: { runner_id: remoteRunnerId, operation: results.length ? "pull" : "push",
            paths: ["roundtrip.txt"], conflict: "overwrite" } }
        : results.length === 2 ? { name: "workspace_transfer", arguments: { operation: "list" } } : undefined;
      if (results.length === 3) {
        const records = JSON.stringify(results[2]).replaceAll('\\"', '"');
        assert.equal((records.match(/"state"\s*:\s*"completed"/g) ?? []).length >= 2, true, records);
      }
    }
    if (evolution) {
      call = results.length ? undefined : { name: "create_evolve_run", arguments: {
        statement: "Improve solver against committed tests", howScored: "Fraction of frozen tests passed", mode: "test_gate",
        startingPointPath: "solver.py", entrypointPath: "solver.py", testCmd: "python test.py", frozenGlobs: ["test.py"],
        caseSplit: { gateGroups: 8, rolloutGroups: 4, testGroups: 2 }, expansions: 12, workers: 1,
      } };
      if (results.length) assert.ok(!JSON.stringify(results).includes("refusedBecause"), JSON.stringify(results));
    }
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
    SCIENCE_AGENT_EVOLVE_URL: `http://127.0.0.1:${stub.address().port}/evolve`, SCIENCE_AGENT_EVOLVE_INTERNAL_TOKEN: token, ...extra,
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
    runnerOrigin = runner;
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
    assert.ok(tools.every((item) => item.status === "completed"), redact(JSON.stringify(tools)));
    assert.equal(tools[0].toolName, "run_shell");
    assert.ok(tools.filter((item) => item.toolName === "workspace_transfer").length >= 3);
    assert.equal(tools.at(-1).toolName, "declare_artifact");
    assert.match(tools[0].content, /isolated/);
    const artifacts = await json(`/api/sessions/${session.id}/artifacts`);
    assert.equal(artifacts.filter((artifact) => artifact.logicalName === "Independent child result").length, 1);
    return "Child completed; discovered its own Workspace; submitted and queried a durable Transfer; copied local Artifact declared";
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
  await step("5. 旧同步工具与 Transfer 共用记录", "主 Agent 经旧 push/pull 完成回传，随后通过新工具查到两笔持久完成记录。", async () => {
    const url = new URL(runnerOrigin);
    const host = await json("/api/remote-hosts", { alias: "journey-direct-runner", connectionKind: "direct",
      endpoint: { host: url.hostname, port: Number(url.port), protocol: "http" }, token });
    remoteRunnerId = host.id;
    await json(`/api/remote-hosts/${host.id}/runner/connect`, {});
    const model = await json("/api/models", { name: "Sync journey", model: "journey", apiToken: token,
      baseUrl: `http://127.0.0.1:${stub.address().port}/v1` });
    const project = await json("/api/projects", { name: "Legacy sync compatibility" });
    const target = await json(`/api/projects/${project.id}/sessions`, { title: "Sync", modelId: model.id,
      remoteRunnerHostIds: [host.id], approvalMode: "always_allow" });
    await json(`/api/sessions/${target.id}/files`, { path: "roundtrip.txt", content: "stable roundtrip" });
    // User upload is itself an explicit Artifact action; sync must not add a
    // second Artifact or silently advance that uploaded Artifact's version.
    const artifactsBeforeSync = await json(`/api/sessions/${target.id}/artifacts`);
    const response = await fetch(`${api}/api/sessions/${target.id}/messages`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "Legacy sync roundtrip: push, pull, then inspect Transfers." }), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"type":"run.completed"/);
    const records = await json(`/api/sessions/${target.id}/remote-workspace/sync-records`);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.status === "completed" && record.fileCount === 1 && record.bytes === 16));
    const file = await fetch(`${api}/api/sessions/${target.id}/file?path=roundtrip.txt`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await file.text(), "stable roundtrip");
    assert.deepEqual(await json(`/api/sessions/${target.id}/artifacts`), artifactsBeforeSync);
    return "Main Agent pushed/pulled through the legacy tool and inspected durable Transfers; local bytes preserved; no implicit Artifact";
  });
  await step("6. 后台写入期间导出 Evolution 输入", "主 Agent 发起搜索；基线代码和测试目录都来自已提交树，不读取后台任务的半成品。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Evolution export", modelId: session.modelId, approvalMode: "full-auto" });
    for (const [name, content] of [["solver.py", "committed solver"], ["test.py", "committed tests"]]) {
      const form = new FormData(); form.append("files", new Blob([content]), name);
      const uploaded = await fetch(`${api}/api/sessions/${target.id}/workspace/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
      assert.equal(uploaded.status, 201);
    }
    const runner = new RunnerClient(runnerOrigin, token);
    const owner = { sessionId: target.id, agentId: "main" };
    const executionId = randomUUID();
    await runner.startShellExecution({ agentId: "main", executionId,
      workspaceRoot: resolve(dataDir, "projects", target.projectId, "sessions", target.id, "workspace"),
      code: "printf unfinished > solver.py; printf unfinished > test.py; echo writer-ready; while :; do sleep 1; done",
      permissionEpoch: { id: "export-journey", sessionId: target.id, createdAt: new Date().toISOString(), environmentRevisionId: "audit-only",
        mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", secretRefs: [], reason: "journey" },
    });
    try {
      await until(async () => (await runner.shellExecutionLogs(executionId, owner)).chunks.some((chunk) => chunk.text.includes("writer-ready")));
      const response = await fetch(`${api}/api/sessions/${target.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: "Evolution committed export: improve solver against the committed tests." }), signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200); assert.match(await response.text(), /"type":"run.completed"/);
      await until(async () => (await json(`/api/evolve/runs?sessionId=${target.id}`)).some((run) => run.status === "succeeded"));
      assert.equal(evolutionExports.length, 2, "probe and search both stage the Workspace");
      assert.deepEqual(evolutionExports, Array.from({ length: 2 }, () => ({ baseline: "committed solver", solver: "committed solver", test: "committed tests" })));
      assert.equal((await runner.getShellExecution(executionId, owner)).state, "running");
    } finally { await runner.cancelShellExecution(executionId, owner); }
    return "Main Agent created Evolution; probe/search consumed committed baseline and tests while the writer remained running; writer explicitly cancelled afterwards";
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
  console.log(`${outcome}: ${steps.filter((item) => item.status === "PASS").length}/${steps.length} steps; report under .tmp/child-workspace-journey-*/report.md`);
}
