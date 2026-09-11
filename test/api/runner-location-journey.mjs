// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/**
 * E2E-META
 * Purpose: Use the same Runner catalog, connection, execution and workspace workflow locally and remotely.
 * Steps: Start API/local Runner plus a separate-store Runner; select each Runner and submit foreground/background jobs; inspect wake results and retained logs; continue the session.
 * Environment: Committed and built task worktree, production server CLIs, ephemeral loopback ports, separate API/remote CAS directories.
 * Type: mocked
 * LLM: journey-owned local OpenAI-compatible stub, which reads execution_status on wake.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: local bubblewrap commands; no SSH or NPU dependency.
 * Credentials: random journey-owned tokens; no external credentials.
 * CostSideEffects: local processes/data only, removed in finally; no external service charges.
 * Browser: add --browser to run the shared-location, SSH and NPU settings journeys against these same isolated product CLIs.
 * Run: pnpm --filter @sciencediscovery/api... --filter @sciencediscovery/runner build && node test/api/runner-location-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit candidate before E2E");
const root = resolve(".tmp", `runner-location-${randomUUID()}`);
await mkdir(root, { recursive: true });
const dataDir = resolve(root, "api-data");
const remoteDataDir = resolve(root, "remote-data");
const token = randomUUID();
const processes = [];
const steps = [];
const modelCalls = [];
let logs = "";
let api;
let runnerId;
let remoteRunnerId;
const redact = (value) => String(value).replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const stub = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const messages = input.messages ?? [];
    modelCalls.push(input);
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const prompt = messages[lastUser]?.content ?? "";
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool");
    const wake = prompt.includes("[Execution notifications]");
    let call;
    if (wake) {
      const previousCalls = messages.slice(0, lastUser).flatMap((message) => message.tool_calls ?? []);
      assert.equal(previousCalls.filter((item) => item.function.name === "run_shell").length, 1, "wake retains the completed submission's tool history");
      const notifications = JSON.parse(prompt.slice(prompt.indexOf('[{"')));
      if (!results.length) call = { name: "execution_status", arguments: { execution_id: notifications[0].sourceId } };
      else {
        const result = JSON.parse(results.at(-1).content);
        assert.equal(result.state, "completed");
        assert.equal(result.provenance, "committed");
        assert.match(result.result.stdout, /runner-location-complete/);
      }
    } else if (prompt.startsWith("Run remote") && !results.length) {
      const background = prompt.includes("background");
      call = { name: "run_shell", arguments: { runner_id: runnerId,
        command: `${background ? "sleep 3; " : ""}printf 'once\\n' >> execution-count.txt; echo runner-location-complete`,
        ...(background ? { background: true } : { wait_ms: 20000 }),
      } };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: wake ? "Remote command completed; results inspected without replay." : "Request handled." };
    const frame = (value, finish_reason) => ({ id: "wake-journey", object: "chat.completion.chunk", created: 1, model: "wake-journey",
      choices: [{ index: 0, delta: value, finish_reason }] });
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
    SCIENTIFIC_ENVS: "0", SCIENCE_AGENT_NPU_BROKER: "0", SCIENCE_AGENT_SSH_CONFIG_PATH: resolve(root, "absent-ssh"),
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
  await new Promise((done) => stub.listen(0, "127.0.0.1", done));
  await step("1. 启动存储隔离的产品服务", "API 与远程 Runner 使用不同 CAS，健康检查通过。", async () => {
    const local = await start("runner");
    const remote = await start("runner", { SCIENCE_AGENT_DATA_DIR: remoteDataDir });
    api = await start("api", { SCIENCE_AGENT_RUNNER_URL: local });
    for (const origin of [local, remote, api]) assert.equal((await fetch(`${origin}/health`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const url = new URL(remote);
    const host = await json("/api/runners", { alias: "separate-store", connectionKind: "direct",
      endpoint: { host: url.hostname, port: Number(url.port), protocol: "http" }, token });
    remoteRunnerId = host.id;
    const catalog = await json("/api/runners");
    assert.deepEqual(catalog.map((item) => item.id), ["local", host.id]);
    assert.deepEqual(catalog.map((item) => item.location), ["local", "remote"]);
    return `API ${api}; local ${local}; separate-store Runner ${remote}; health 200`;
  });
  const model = await json("/api/models", { name: "Remote wake journey", model: "wake-journey", apiToken: token,
    baseUrl: `http://127.0.0.1:${stub.address().port}/v1` });
  const project = await json("/api/projects", { name: "Remote execution wake" });
  for (const id of ["local", remoteRunnerId]) {
    runnerId = id;
    assert.equal((await json(`/api/runners/${id}/connect`, {})).state, "ready");
    for (const mode of ["foreground", "background"]) {
    await step(`${steps.length + 1}. ${id === "local" ? "本机" : "远程"} ${mode} 命令完成后查看工作区并继续会话`, "执行成功；wake 查询结果并回复；只提交一次命令；后续用户消息仍可完成。", async () => {
      const session = await json(`/api/projects/${project.id}/sessions`, { title: mode, modelId: model.id,
        runnerIds: [runnerId], approvalMode: "always_allow" });
      const initial = await json(`/api/sessions/${session.id}/runs`, { content: `Run remote ${mode} command once and report its result.` });
      let runs;
      await until(async () => {
        runs = await json(`/api/sessions/${session.id}/runs`);
        assert.ok(!runs.some((run) => run.status === "failed"), JSON.stringify(runs.map(({ id, status, error }) => ({ id, status, error }))));
        return runs.some((run) => run.id === initial.id && run.status === "completed") && runs.some((run) => run.automaticWake && run.status === "completed");
      });
      const wake = runs.find((run) => run.automaticWake);
      const { messages } = await json(`/api/sessions/${session.id}`);
      assert.ok(messages.some((message) => message.kind === "wake_notice"));
      assert.match(messages.find((message) => message.id === wake.assistantMessageId).content, /results inspected without replay/);
      const activity = await json(`/api/sessions/${session.id}/agent-activity`);
      assert.equal(activity.executions.length, 1, "there is exactly one accepted remote command");
      const execution = activity.executions[0];
      assert.equal(execution.state, "completed");
      const recorded = await json(`/api/sessions/${session.id}/execution-runs`);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].exitCode, 0);
      const output = await json(`/api/sessions/${session.id}/agent-activity/executions/${execution.id}/logs`);
      assert.match(output.chunks.map((chunk) => chunk.text).join(""), /runner-location-complete/);
      // Supplement the public result with proof this is not a shared-CAS false positive.
      const relative = `versioning/agent-state/blobs/sha256/${execution.runnerVersionId.slice(7)}`;
      if (id !== "local") {
        await access(resolve(remoteDataDir, relative));
        await assert.rejects(access(resolve(dataDir, relative)), { code: "ENOENT" });
      } else await access(resolve(dataDir, relative));
      const bindings = await json(`/api/runners/${id}/workspaces`);
      const binding = bindings.find((item) => item.sessionId === session.id);
      assert.equal(binding.runnerId, id);
      assert.equal(binding.location, id === "local" ? "local" : "remote");
      const listing = await json(`/api/runners/${id}/workspaces/${session.id}/files`);
      assert.equal(listing.workspaceKey, binding.workspaceKey);
      assert.ok(listing.files.some((file) => file.path === "execution-count.txt"), JSON.stringify(listing));
      const followup = await json(`/api/sessions/${session.id}/runs`, { content: "Thanks. Confirm the session can continue." });
      await until(async () => {
        const run = (await json(`/api/sessions/${session.id}/runs`)).find((item) => item.id === followup.id);
        assert.notEqual(run.status, "failed", run.error);
        return run.status === "completed";
      });
      assert.equal((await json(`/api/sessions/${session.id}/agent-activity`)).executions.length, 1);
      assert.equal((await json(`/api/sessions/${session.id}/runs`)).filter((run) => run.automaticWake).length, 1);
      return `Session ${session.id}; initial ${initial.id}, wake ${wake.id}, followup ${followup.id}: completed. Execution ${execution.id}: exit 0, one submission; Runner ${id}; workspace ${binding.workspaceKey}; execution-count.txt visible through the common workspace API.`;
    });
  }
  }
  if (process.argv.includes("--browser")) await step(`${steps.length + 1}. 浏览器验证相同位置交互与 SSH 兼容`, "共同目录、工作区、失败重试、窄屏、SSH/NPU 设置旅程均通过。", async () => {
    const child = spawn("npm", ["--prefix", ".e2e", "run", "test:mocked", "--", "journey-runner-locations.spec.ts", "journey-ssh-remote-runner.spec.ts", "journey-npu-cards.spec.ts"], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: root, E2E_BASE_URL: api, E2E_API_URL: api, E2E_API_TOKEN: token,
        PLAYWRIGHT_BROWSERS_PATH: resolve(".tmp/browsers"), npm_config_cache: resolve(".tmp/npm-cache"), E2E_JOURNEY_REPORTS: resolve(root, "browser") },
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { process.stdout.write(redact(chunk)); });
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
    assert.equal(code, 0, "affected browser journeys must pass");
    return "3 browser journeys passed; per-step screenshots and reports in browser/";
  });
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
finally {
  await writeFile(resolve(root, "report.md"), `# Runner location journey\n\nResult: ${outcome}\n\nTarget: ${sha}\n\nCommand: node test/api/runner-location-journey.mjs\n\nEnvironment: production API/Runner CLIs, separate remote CAS, loopback model stub; no SSH/NPU hardware or Web checks. Model calls: ${modelCalls.length}.\n\n${steps.map((item) => `## ${item.name}\n\nExpected: ${item.expected}\n\nActual: ${item.actual}\n\n${item.status}\n`).join("\n")}\n## Diagnostic log\n\n\`\`\`text\n${logs.slice(-5000)}\n\`\`\`\n`);
  for (const child of processes.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise((resolveDone) => child.once("exit", resolveDone));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await done;
    clearTimeout(timer);
  }
  stub.closeAllConnections();
  await new Promise((done) => stub.close(done));
  await rm(dataDir, { recursive: true, force: true });
  await rm(remoteDataDir, { recursive: true, force: true });
  console.log(`${outcome}: ${steps.filter((item) => item.status === "PASS").length}/${steps.length} steps; report ${resolve(root, "report.md")}`);
}
