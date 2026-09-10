// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Delegate selected input to an independent child Workspace and retrieve its local Artifact.
 * Steps: Start isolated CLI services; create Session/input; delegate; verify child output/parent isolation; legacy sync; Evolution export during a write; delete Session/Project safely during background execution; manage foreground/background Shell through Agent tools.
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
import { DatabaseSync } from "node:sqlite";
import { RunnerClient } from "../../packages/executor/dist/index.js";
import { VersionStore } from "../../packages/cas/dist/index.js";

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
let childReplyHeld = false;
let releaseChildReply;
const redact = (value) => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const stub = createServer(async (request, response) => {
  try {
    if (request.url === "/evolve/health") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === "/evolve/probe" || request.url === "/evolve/runs") {
      evolutionExports.push({ baseline: input.baseline_code,
        ...(input.workspace_dir ? { solver: await readFile(resolve(input.workspace_dir, "solver.py"), "utf8"),
          test: await readFile(resolve(input.workspace_dir, "test.py"), "utf8") } : {}) });
      if (request.url.endsWith("/probe")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ baseline: 0.4, worsened: 0.1, flat: false, label: "constant" }));
      return response.writeHead(200, { "content-type": "application/x-ndjson" }).end(JSON.stringify({ sequence: 1, createdAt: new Date().toISOString(),
        event: { type: "search_finished", status: "succeeded", candidates: 0, bestNodeIndex: null } }) + "\n");
    }
    requests.push(input);
    const child = input.messages?.some((message) => message.role === "system" && message.content?.includes("Applied subagent preset general-purpose"));
    const legacy = input.messages?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Legacy sync roundtrip"));
    const evolution = input.messages?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Evolution committed export"));
    const managed = input.messages?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Managed execution journey"));
    const latestUser = input.messages?.findLast((message) => message.role === "user")?.content ?? "";
    const wake = typeof latestUser === "string" && latestUser.includes("[Execution notifications]");
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
    if (legacy && !wake) {
      call = results.length < 2
        ? { name: "sync_remote_workspace", arguments: { runner_id: remoteRunnerId, operation: results.length ? "pull" : "push",
            paths: ["roundtrip.txt"], conflict: "overwrite" } }
        : results.length === 2 ? { name: "workspace_transfer", arguments: { operation: "list" } } : undefined;
      if (results.length === 3) {
        const records = JSON.stringify(results[2]).replaceAll('\\"', '"');
        assert.equal((records.match(/"state"\s*:\s*"completed"/g) ?? []).length >= 2, true, records);
      }
    }
    if (evolution && !wake) {
      call = results.length === 0 ? { name: "create_evolve_run", arguments: {
        statement: "Improve solver against committed tests", howScored: "Fraction of frozen tests passed", mode: "test_gate",
        startingPointPath: "solver.py", entrypointPath: "solver.py", testCmd: "python test.py", frozenGlobs: ["test.py"],
        caseSplit: { gateGroups: 8, rolloutGroups: 4, testGroups: 2 }, expansions: 12, workers: 1,
      } } : results.length === 1 ? { name: "create_evolve_run", arguments: {
        statement: "Score the committed solver", howScored: "Independent scripted cases", mode: "custom_script", startingPointPath: "solver.py",
        evaluatorSource: 'import os, json\nshards = os.environ["SCIENCE_AGENT_SHARDS"]\nwith open(os.environ["SCIENCE_AGENT_RESULT"], "w") as output:\n    json.dump({"score": 0.4}, output)', direction: "maximize",
        split: { gateShards: 8, rolloutShards: 4, testShards: 2, seed: 0, shardRows: 1, trainRows: null }, expansions: 12, workers: 1,
      } } : undefined;
      if (results.length) assert.ok(!JSON.stringify(results).includes("refusedBecause"), JSON.stringify(results));
    }
    const childBackground = input.messages?.some((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("Child background journey"));
    const restartActive = input.messages?.some((message) => typeof message.content === "string" && message.content.includes("Restart active child"));
    if (childBackground && !wake) {
      call = !results.length ? (child
        ? { name: "run_shell", arguments: { command: "sleep 2; printf child-once >> child-background.txt", background: true } }
        : { name: "task", arguments: { description: "Background child", prompt: `Child background journey: start one job and report its ID.${restartActive ? " Restart active child" : ""}`, subagent_type: "general-purpose" } }) : undefined;
      if (child && restartActive && results.length) {
        childReplyHeld = true;
        await new Promise((done) => { releaseChildReply = done; });
      }
    }
    if (managed && !wake) {
      const data = (index) => JSON.parse(results[index].content);
      const first = results.length ? data(0) : undefined;
      const second = results.length > 3 ? data(3) : undefined;
      if (first) assert.ok(first.accepted && ["queued", "running"].includes(first.state), "background submission must return before completion");
      if (second) assert.ok(second.accepted && ["queued", "running"].includes(second.state), "foreground deadline must leave its command alive");
      call = [
        { name: "run_shell", arguments: { command: "echo managed-ready; sleep 0.3; printf managed > managed.txt", background: true } },
        { name: "execution_status", arguments: { execution_id: first?.id, wait_ms: 3000 } },
        { name: "execution_logs", arguments: { execution_id: first?.id } },
        { name: "run_shell", arguments: { command: "echo waiting-ready; while :; do sleep 1; done", wait_ms: 1 } },
        { name: "execution_cancel", arguments: { execution_id: second?.id } },
        { name: "execution_status", arguments: { execution_id: second?.id, wait_ms: 3000 } },
        { name: "execution_status", arguments: {} },
      ][results.length];
      if (results.length > 1) { assert.equal(data(1).state, "completed"); assert.equal(data(1).provenance, "committed"); }
      if (results.length > 2) assert.ok(data(2).chunks.some((chunk) => chunk.text.includes("managed-ready")));
      if (results.length > 5) { assert.equal(data(5).state, "cancelled"); assert.equal(data(5).provenance, "committed"); }
      if (results.length > 6) assert.equal(data(6).length, 2);
    }
    if (latestUser.includes("Wake execution journey") && !wake) call = results.length ? undefined : {
      name: "run_shell", arguments: { command: "sleep 2; printf wake-complete >> wake.txt", background: true },
    };
    if (latestUser.includes("Timer wake journey") && !wake) call = [
      { name: "timer_create", arguments: { after_ms: 1500, message: "timer-wake-marker" } },
      { name: "timer_create", arguments: { after_ms: 60000, message: "cancelled-reminder" } },
      { name: "timer_list", arguments: {} },
      { name: "timer_cancel", arguments: { timer_id: results.length > 1 ? JSON.parse(results[1].content).id : undefined } },
    ][results.length];
    if (wake) call = undefined; // acknowledge facts, never rerun the original command
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${child ? "child" : "main"}-${results.length}`,
      type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: wake ? "Received retained notification; no command replay." : child ? "Delivered isolated result." : "Child result is available." };
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
  child.serviceKind = kind;
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
      assert.equal(evolutionExports.length, 4, "test-gated and scripted searches each probe and run");
      assert.deepEqual(evolutionExports.filter((value) => value.solver), Array.from({ length: 2 }, () => ({ baseline: "", solver: "committed solver", test: "committed tests" })));
      assert.deepEqual(evolutionExports.filter((value) => !value.solver), Array.from({ length: 2 }, () => ({ baseline: "committed solver" })));
      assert.equal((await runner.getShellExecution(executionId, owner)).state, "running");
    } finally { await runner.cancelShellExecution(executionId, owner); }
    return "Main Agent created Evolution; probe/search consumed committed baseline and tests while the writer remained running; writer explicitly cancelled afterwards";
  });
  await step("7. 后台任务期间安全删除 Session 和 Project", "删除等待进程退出和版本提交；期间仍可查日志、取消；删除后执行记录保留且目录不会被排队写入重建。", async () => {
    const runner = new RunnerClient(runnerOrigin, token);
    for (const kind of ["session", "project"]) {
      const project = kind === "project" ? await json("/api/projects", { name: "Delete while running" }) : { id: session.projectId };
      const target = await json(`/api/projects/${project.id}/sessions`, { title: "Delete while running", modelId: session.modelId });
      const workspaceRoot = resolve(dataDir, "projects", project.id, "sessions", target.id, "workspace");
      const scope = kind === "project" ? resolve(dataDir, "projects", project.id) : resolve(workspaceRoot, "..");
      const executionId = randomUUID(); const owner = { sessionId: target.id, agentId: "main" };
      await runner.startShellExecution({ agentId: "main", executionId, workspaceRoot,
        code: "printf retained > result.txt; echo deletion-writer-ready; while :; do sleep 1; done",
        permissionEpoch: { id: "deletion-journey", sessionId: target.id, createdAt: new Date().toISOString(), environmentRevisionId: "audit-only",
          mounts: [{ source: "workspace", mode: "read-write" }], networkPolicy: "none", secretRefs: [], reason: "journey" } });
      let deletion;
      try {
        await until(async () => (await runner.shellExecutionLogs(executionId, owner)).chunks.some((chunk) => chunk.text.includes("deletion-writer-ready")));
        let settled = false;
        const path = kind === "project" ? `/api/projects/${project.id}` : `/api/sessions/${target.id}`;
        deletion = fetch(`${api}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ confirmationId: kind === "project" ? project.id : target.id }), signal: AbortSignal.timeout(30_000) })
          .then((response) => { settled = true; return response; });
        await until(async () => {
          const db = new DatabaseSync(resolve(dataDir, ".workspace-lifecycle", "registry.sqlite"), { readOnly: true });
          try { return Boolean(db.prepare("SELECT scope FROM fences WHERE scope = ?").get(scope)); }
          finally { db.close(); }
        });
        assert.equal(settled, false, "delete must not move a live writer's root");
        assert.equal((await runner.getShellExecution(executionId, owner)).state, "running");
        assert.ok((await runner.shellExecutionLogs(executionId, owner)).chunks.length, "management channel remains usable");
        await runner.cancelShellExecution(executionId, owner);
        const response = await deletion;
        assert.equal(response.status, 200, await response.text());
        const execution = await runner.getShellExecution(executionId, owner);
        assert.equal(execution.state, "cancelled"); assert.ok(execution.version, "execution receipt committed before deletion completed");
        const missing = await fetch(`${api}/api/sessions/${target.id}`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(missing.status, 404);
        await assert.rejects(readFile(resolve(workspaceRoot, "result.txt")), { code: "ENOENT" });
      } finally {
        await runner.cancelShellExecution(executionId, owner).catch(() => {});
        await deletion?.catch(() => {});
      }
    }
    return "Session and Project DELETE each waited behind a live production Runner, logs remained queryable, explicit cancellation committed a version, HTTP deletion completed, and Session/root disappeared";
  });
  await step("8. Agent 管理前后台 Shell 执行", "后台提交及前台等待到期都返回仍运行的 ID；专用工具可读日志、取消并查询已提交结果。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Managed execution", modelId: session.modelId, approvalMode: "always_allow" });
    const response = await fetch(`${api}/api/sessions/${target.id}/messages`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "Managed execution journey: start background work, inspect its logs and result, then cancel a foreground task whose waiting deadline elapsed." }),
      signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const stream = await response.text(); assert.match(stream, /"type":"run.completed"/);
    assert.ok(!stream.includes('"type":"run.failed"'), redact(stream));
    const file = await fetch(`${api}/api/sessions/${target.id}/file?path=managed.txt`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(file.status, 200); assert.equal(await file.text(), "managed");
    const managedRequests = requests.filter((input) => input.messages?.some((message) => message.role === "user" && message.content?.includes?.("Managed execution journey")));
    assert.ok(managedRequests.some((input) => input.messages.filter((message) => message.role === "tool").length === 7), "Agent must finish all execution management steps");
    return "Main Agent received live IDs from background and timed foreground calls, read retained logs, cancelled explicitly, and queried committed completion/cancellation without a second Shell for management";
  });
  await step("9. 完成通知真正唤醒主 Agent", "前一回合已结束后，后台完成自动创建新回合并调用模型，不重放命令。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Wake execution", modelId: session.modelId, approvalMode: "always_allow" });
    const initial = await json(`/api/sessions/${target.id}/runs`, { content: "Wake execution journey: finish this turn after background acceptance." });
    await until(async () => (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.id === initial.id)?.status === "completed");
    let automatic;
    await until(async () => { automatic = (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.automaticWake && run.status === "completed"); return automatic; });
    assert.ok(automatic.notificationDelivery.notifications.some((notice) => notice.kind === "execution"));
    assert.ok(requests.some((input) => input.messages?.some((message) => typeof message.content === "string" && message.content.includes(automatic.notificationDelivery.notifications[0].sourceId) && message.content.includes("[Execution notifications]"))), "completion must reach the model");
    const file = await fetch(`${api}/api/sessions/${target.id}/file?path=wake.txt`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await file.text(), "wake-complete");
    // The wake reaches the model but must never appear as something the user typed.
    const { messages } = await json(`/api/sessions/${target.id}`);
    assert.ok(!messages.some((message) => message.role === "user" && message.kind !== "wake_notice"
      && message.content.includes("[Execution notifications]")), JSON.stringify(messages.map((message) => ({ kind: message.kind, role: message.role, content: message.content.slice(0, 80) }))));
    const notice = messages.find((message) => message.kind === "wake_notice");
    assert.ok(notice, "the wake must be recorded as a wake notice");
    assert.equal(notice.content, "");
    assert.ok(notice.runtimeNotice.executions >= 1);
    assert.match(notice.runtimeNotice.prompt, /^\[Execution notifications\]/);
    return "Background completion created a distinct completed automatic run; model received its Execution ID; the transcript recorded a wake notice instead of a user message; command output was written exactly once";
  });
  await step("10. 一次性提醒到期唤醒", "模型创建、查询和取消提醒；未取消的提醒到期进入新回合，不执行 Shell。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Timer wake", modelId: session.modelId, approvalMode: "always_allow" });
    await json(`/api/sessions/${target.id}/runs`, { content: "Timer wake journey: create one reminder and cancel the other." });
    let automatic;
    await until(async () => { automatic = (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.automaticWake && run.status === "completed"); return automatic; });
    assert.deepEqual(automatic.notificationDelivery.notifications.map((notice) => notice.message), ["timer-wake-marker"]);
    assert.ok(requests.some((input) => input.messages?.some((message) => typeof message.content === "string" && message.content.includes("[Execution notifications]") && message.content.includes("timer-wake-marker"))));
    return "timer_create/list/cancel ran through Agent tools; only the uncancelled one-time reminder reached a new model turn";
  });
  await step("11. 停止与归档阻止自动唤醒，用户恢复汇总未读", "停门后命令可完成，但不能调用模型；用户恢复只接收记录，不重放 Shell。", async () => {
    for (const transition of ["stop", "archive"]) {
      const target = await json(`/api/projects/${session.projectId}/sessions`, { title: `Wake ${transition}`, modelId: session.modelId, approvalMode: "always_allow" });
      const initial = await json(`/api/sessions/${target.id}/runs`, { content: "Wake execution journey: return after background acceptance." });
      await until(async () => (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.id === initial.id)?.status === "completed");
      await json(`/api/sessions/${target.id}/${transition === "stop" ? "runs/current/cancel" : "archive"}`, {});
      await until(async () => {
        const response = await fetch(`${api}/api/sessions/${target.id}/file?path=wake.txt`, { headers: { authorization: `Bearer ${token}` } });
        return response.ok && (await response.text()) === "wake-complete";
      });
      const observationEnd = Date.now() + 1500;
      await until(async () => {
        assert.equal((await json(`/api/sessions/${target.id}/runs`)).length, 1, `${transition} must suppress automatic runs`);
        return Date.now() >= observationEnd;
      });
      if (transition === "archive") await json(`/api/sessions/${target.id}/restore`, {});
      const resume = await json(`/api/sessions/${target.id}/runs`, { content: "Please resume and summarize retained notifications without repeating commands." });
      let resumed;
      await until(async () => { resumed = (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.id === resume.id); return resumed?.status === "completed"; });
      assert.ok(resumed.notificationDelivery?.notifications.some((notice) => notice.kind === "execution"));
      // Retained records ride along with the user's request without being written into it.
      const { messages } = await json(`/api/sessions/${target.id}`);
      const request = messages.findLast((message) => message.role === "user");
      assert.equal(request.content, "Please resume and summarize retained notifications without repeating commands.");
      assert.match(request.runtimeNotice.prompt, /^\[Execution notifications\]/);
      const file = await fetch(`${api}/api/sessions/${target.id}/file?path=wake.txt`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(await file.text(), "wake-complete");
    }
    return "Both Stop and Archive suppressed automatic runs after real process completion; explicit user resume delivered unread execution facts and the command remained single-execution";
  });
  await step("12. 子 Agent 完成通知恢复原上下文", "后台完成唤醒原子 Agent，使用同一独立 Workspace 和历史，不重新交付或重放命令。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Child wake", modelId: session.modelId, approvalMode: "always_allow" });
    const initial = await json(`/api/sessions/${target.id}/runs`, { content: "Child background journey: delegate one background job." });
    await until(async () => (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.id === initial.id)?.status === "completed");
    let automatic;
    await until(async () => {
      automatic = (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.automaticWake && run.notificationDelivery?.agentId.startsWith("subagent:"));
      if (automatic && ["failed", "cancelled", "interrupted"].includes(automatic.status)) assert.fail(JSON.stringify(automatic));
      return automatic?.status === "completed";
    });
    const children = await json(`/api/sessions/${target.id}/subagents`);
    assert.equal(children.length, 1);
    const child = children[0];
    assert.equal(automatic.notificationDelivery.agentId, `subagent:${child.id}`);
    assert.equal(child.steps.filter((step) => step.toolName === "run_shell").length, 1);
    assert.equal(child.contextRef.pool, "agent-state");
    assert.ok(requests.some((input) => input.messages?.some((message) => message.role === "system" && message.content?.includes("Applied subagent preset general-purpose"))
      && input.messages.some((message) => message.role === "tool")
      && input.messages.some((message) => typeof message.content === "string" && message.content.includes("[Execution notifications]") && message.content.includes(automatic.notificationDelivery.notifications[0].sourceId))), "child wake must include its own closed tool history");
    assert.equal(await readFile(resolve(dataDir, "projects", target.projectId, "sessions", target.id, "agent-workspaces", child.handoff.workspaceId, "child-background.txt"), "utf8"), "child-once");
    assert.ok(!(await json(`/api/sessions/${target.id}/files`)).some((file) => file.path === "child-background.txt"));
    return "Original child ID/context/workspace resumed; one Shell invocation and one output write; parent Workspace unchanged";
  });
  await step("13. 用户管理子作业、停门和恢复", "用户能读日志而不另起 Shell；单独停止子 Agent 阻止完成唤醒，显式恢复后汇总未读；跨 Session ID 不能读取记录。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Child stop resume", modelId: session.modelId, approvalMode: "always_allow" });
    const initial = await json(`/api/sessions/${target.id}/runs`, { content: "Child background journey: delegate one background job." });
    await until(async () => (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.id === initial.id)?.status === "completed");
    const [child] = await json(`/api/sessions/${target.id}/subagents`);
    await json(`/api/sessions/${target.id}/subagents/${child.id}/stop`, {});
    let activity;
    await until(async () => { activity = await json(`/api/sessions/${target.id}/agent-activity`); return activity.executions[0]?.state === "completed"; });
    assert.equal(activity.agents.find((agent) => agent.agentId === `subagent:${child.id}`).stopped, true);
    const job = activity.executions[0];
    const output = await json(`/api/sessions/${target.id}/agent-activity/executions/${job.id}/logs`);
    assert.ok(Array.isArray(output.chunks));
    const inaccessible = await fetch(`${api}/api/sessions/${session.id}/agent-activity/executions/${job.id}/logs`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(inaccessible.status, 404);
    const end = Date.now() + 1200;
    await until(async () => { assert.equal((await json(`/api/sessions/${target.id}/runs`)).length, 1); return Date.now() >= end; });
    await json(`/api/sessions/${target.id}/subagents/${child.id}/resume`, {});
    await until(async () => (await json(`/api/sessions/${target.id}/runs`)).some((run) => run.automaticWake && run.status === "completed"));
    const [resumed] = await json(`/api/sessions/${target.id}/subagents`);
    assert.equal(resumed.steps.filter((step) => step.toolName === "run_shell").length, 1);
    assert.equal(await readFile(resolve(dataDir, "projects", target.projectId, "sessions", target.id, "agent-workspaces", child.handoff.workspaceId, "child-background.txt"), "utf8"), "child-once");
    return "User activity routes exposed owned logs, rejected foreign Session, retained completed child job while stopped, and resumed its unread context once";
  });
  await step("14. API 重启后保留停止门与子上下文", "重启不自动重放作业；用户恢复原子 Agent 后，仍使用已提交历史和同一 Workspace。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Child restart", modelId: session.modelId, approvalMode: "always_allow" });
    const initial = await json(`/api/sessions/${target.id}/runs`, { content: "Child background journey: delegate one background job." });
    await until(async () => (await json(`/api/sessions/${target.id}/runs`)).find((run) => run.id === initial.id)?.status === "completed");
    const [before] = await json(`/api/sessions/${target.id}/subagents`);
    await json(`/api/sessions/${target.id}/subagents/${before.id}/stop`, {});
    await until(async () => (await json(`/api/sessions/${target.id}/agent-activity`)).executions[0]?.state === "completed");
    const apiProcess = processes.findLast((child) => child.serviceKind === "api");
    const ended = new Promise((done) => apiProcess.once("exit", done)); apiProcess.kill("SIGTERM"); await ended;
    api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runnerOrigin });
    const [restored] = await json(`/api/sessions/${target.id}/subagents`);
    assert.deepEqual(restored.contextRef, before.contextRef);
    assert.equal(restored.handoff.workspaceId, before.handoff.workspaceId);
    assert.equal((await json(`/api/sessions/${target.id}/agent-activity`)).agents.find((item) => item.agentId === `subagent:${before.id}`).stopped, true);
    assert.equal((await json(`/api/sessions/${target.id}/runs`)).length, 1);
    await json(`/api/sessions/${target.id}/subagents/${before.id}/resume`, {});
    await until(async () => (await json(`/api/sessions/${target.id}/runs`)).some((run) => run.automaticWake && run.status === "completed"));
    const [after] = await json(`/api/sessions/${target.id}/subagents`);
    assert.equal(after.steps.filter((step) => step.toolName === "run_shell").length, 1);
    assert.equal(await readFile(resolve(dataDir, "projects", target.projectId, "sessions", target.id, "agent-workspaces", after.handoff.workspaceId, "child-background.txt"), "utf8"), "child-once");
    return "Production API restarted; stopped child stayed stopped; explicit resume loaded the retained CAS context and original Workspace, without command replay";
  });
  await step("15. 正在运行的子 Agent 遭遇 API 退出", "从已提交 turn 恢复上下文，不永久 busy、不重放已接受的 Shell。", async () => {
    const target = await json(`/api/projects/${session.projectId}/sessions`, { title: "Active child restart", modelId: session.modelId, approvalMode: "always_allow" });
    await json(`/api/sessions/${target.id}/runs`, { content: "Child background journey: Restart active child after accepting one job." });
    await until(() => childReplyHeld);
    const [before] = await json(`/api/sessions/${target.id}/subagents`);
    assert.equal(before.status, "running");
    const apiProcess = processes.findLast((child) => child.serviceKind === "api");
    const ended = new Promise((done) => apiProcess.once("exit", done)); apiProcess.kill("SIGKILL"); await ended;
    releaseChildReply();
    api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runnerOrigin });
    await until(async () => {
      const runs = await json(`/api/sessions/${target.id}/runs`);
      assert.ok(!runs.some((run) => run.automaticWake && run.status === "failed"), JSON.stringify(runs));
      return runs.some((run) => run.automaticWake && run.status === "completed");
    });
    const [after] = await json(`/api/sessions/${target.id}/subagents`);
    assert.equal(after.id, before.id);
    assert.equal(after.status, "completed");
    assert.equal(after.handoff.workspaceId, before.handoff.workspaceId);
    const versions = new VersionStore(dataDir);
    const context = (await versions.readRecord(after.contextRef, "SubagentContext")).value;
    assert.equal(context.history.filter((item) => item.role === "assistant").flatMap((item) => item.tool_calls ?? []).filter((call) => call.function?.name === "run_shell").length, 1);
    const file = resolve(dataDir, "projects", target.projectId, "sessions", target.id, "agent-workspaces", after.handoff.workspaceId, "child-background.txt");
    await until(async () => { try { return await readFile(file, "utf8") === "child-once"; } catch { return false; } });
    return "SIGKILL during the child model's second call; committed first turn restored, completion/unknown notice resumed original child, one Shell and one output write";
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
