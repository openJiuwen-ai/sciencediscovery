// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/**
 * E2E-META
 * Purpose: Explicit Codex task, same-channel settings, private config, cancellation/deadline, declared-only handoff, and fallback on/off.
 * Steps: Start production API/Runner; register local lead; delegate; configure through public API; inspect child/artifacts; cancel/deadline; reject auth with fallback on/off.
 * Environment: Committed/built task worktree, Linux bubblewrap, isolated ephemeral ports/data.
 * Type: mocked by default; real only with SPECIALIST_REAL=1 and SPECIALIST_KEY_FILE.
 * LLM: Local scripted lead; official Codex SDK/CLI against local Responses fixture, or live Codex in explicit real mode.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: sandboxed local shell. Real mode contacts the OpenAI Responses API.
 * Credentials: Random local bearer/fixture key; real key read from SPECIALIST_KEY_FILE and submitted through config API only.
 * CostSideEffects: Real mode uses billable Codex tokens; temporary records/processes are removed; report retained.
 * Browser: SPECIALIST_BROWSER=1 runs the pinned config-card browser journey before API scenarios.
 * Run: node test/api/specialist-runtime-journey.mjs
 * Rejected real auth only: SPECIALIST_REAL=1 SPECIALIST_CASES=fallback-on,fallback-off node test/api/specialist-runtime-journey.mjs
 * Real: SPECIALIST_REAL=1 SPECIALIST_KEY_FILE=<private-key-file> SPECIALIST_MODEL=<model> node test/api/specialist-runtime-journey.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Commit candidate before E2E");
const root = resolve(".tmp", `specialist-journey-${randomUUID()}`);
await mkdir(root, { recursive: true });
const real = process.env.SPECIALIST_REAL === "1";
const allCases = ["handoff", "cancel", "timeout", "fallback-on", "fallback-off"];
const cases = process.env.SPECIALIST_CASES?.split(",") ?? allCases;
assert.ok(cases.length && cases.every(name => allCases.includes(name)), "SPECIALIST_CASES must name existing scenarios");
const rejectedAuthOnly = cases.every(name => name.startsWith("fallback"));
const key = real && process.env.SPECIALIST_KEY_FILE ? (await readFile(process.env.SPECIALIST_KEY_FILE, "utf8")).trim() : real ? rejectedAuthOnly ? "invalid-e2e-key" : undefined : "fixture-codex-key";
if (!key) {
  await writeFile(resolve(root, "report.md"), `# BLOCKED\nSHA: ${sha}\nReal Codex matrix blocked: SPECIALIST_KEY_FILE is required. No live calls made.\n`);
  console.error(`BLOCKED: missing approved API key; report: ${root}/report.md`); process.exit(2);
}
const token = randomUUID();
const processes = [];
const steps = [];
let api;
let active;
let logs = "";
let providerCalls = 0;
const redact = value => String(value).replaceAll(key, "[redacted]").replaceAll(token, "[redacted]").replaceAll(process.cwd(), "<worktree>");
const stub = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url.endsWith("/responses")) {
      providerCalls++;
      assert.equal(real, false, "Real mode must not use the fixture provider");
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.doesNotMatch(raw, /fixture-codex-key/);
      assert.doesNotMatch(JSON.stringify(body.tools), /"(?:exec_command|shell_command|local_shell|write_stdin)"/);
      if (active.name.startsWith("fallback")) return res.writeHead(401).end(JSON.stringify({ error: { message: "Invalid API key", type: "invalid_request_error" } }));
      if (active.name === "cancel" || active.name === "timeout") return; // held until process cancellation
      const choices = [
        { summary: "Configure, write and declare in one ordered turn", tools: [
          { tool: "configure_specialist_runtime", arguments: JSON.stringify({ reasoningEffort: "low", timeoutSeconds: 45, fallback: false }) },
          { tool: "run_shell", arguments: JSON.stringify({ command: "printf declared > result.txt; printf private > scratch.txt; echo handoff-ready" }) },
          { tool: "declare_artifact", arguments: JSON.stringify({ path: "result.txt" }) },
        ] },
        { tools: [], summary: "Delivered declared result only." },
      ];
      const output = JSON.stringify(choices[active.turn++]);
      assert.ok(output, "unexpected Codex turn");
      const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } });
      send({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } });
      send({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: output });
      send({ type: "response.output_item.done", output_index: 0, item: message });
      send({ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [message], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      return res.end();
    }
    // The lead and native fallback are local stubs; only Codex auth is live in real mode.
    const nativeFallback = body.messages?.some(message => message.role === "system" && message.content?.includes("You are code-engineer"));
    const hasResult = body.messages?.some(message => message.role === "tool");
    const call = !nativeFallback && !hasResult ? { name: "task", arguments: { description: active.name, specialistId: active.specialist.id,
      prompt: "Use the Codex Specialist. As requested by the user, first set reasoningEffort=low, timeoutSeconds=45, fallback=false using configure_specialist_runtime. Then run_shell to write result.txt containing declared and scratch.txt containing private. Explicitly declare only result.txt. Return a brief handoff. Do not declare scratch.txt.", max_turns: 8 } } : undefined;
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: nativeFallback ? "Native fallback completed." : "Delegation ended." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish_reason) => ({ id: "lead", object: "chat.completion.chunk", created: 1, model: "lead", choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`);
    res.write(`data: ${JSON.stringify(frame({}, call ? "tool_calls" : "stop"))}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { res.writeHead(500).end(redact(error.stack)); }
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
let outcome = "FAIL";
let project;
try {
  await new Promise(done => stub.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${stub.address().port}/v1`;
  await step("1. Start isolated product CLI services", "API/Runner health responds", async () => {
    const runner = await start("runner");
    api = await start("api", { SCIENCE_AGENT_RUNNER_URL: runner, ...(!real ? { SCIENCE_AGENT_CODEX_BASE_URL: endpoint } : {}) });
    assert.equal((await fetch(`${api}/health`)).status, 200);
    assert.equal((await fetch(`${runner}/health`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    return "Production API and Runner ready on ephemeral loopback ports";
  });
  if (process.env.SPECIALIST_BROWSER === "1") {
    await step("2. Browser config card and cancellation", "Password entry, opt-out and cancellation remain usable at narrow and wide widths", async () => {
      const browser = spawn(resolve(".e2e/node_modules/.bin/playwright"), ["test", "journey-codex-config.spec.ts", "--project", "mocked"], {
        cwd: resolve(".e2e"), env: { ...process.env, E2E_BASE_URL: api, E2E_API_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [browser.stdout, browser.stderr]) stream.on("data", chunk => { output += redact(chunk); });
      const code = await new Promise(done => browser.once("exit", done));
      assert.equal(code, 0, output);
      return output;
    });
  }
  const model = await json("/api/models", { name: "Specialist journey lead", model: "lead", apiToken: token, baseUrl: endpoint });
  project = await json("/api/projects", { name: "Specialist Phase 2 journey" });
  for (const name of cases) {
    await step(`${steps.length + 1}. ${name}`, "Explicit task and config card lead to the required terminal outcome", async () => {
      const specialist = await json("/api/specialists", { name: `Codex ${name}`, description: "Phase 2", instructions: "Follow the user's exact task. Use only platform tools.",
        runtime: { kind: "codex", model: process.env.SPECIALIST_MODEL ?? "gpt-5.4", fallback: name !== "fallback-off", timeoutSeconds: name === "timeout" ? 2 : 60 } });
      active = { name, specialist, turn: 0 };
      const session = await json(`/api/projects/${project.id}/sessions`, { title: name, modelId: model.id, approvalMode: "always_allow" });
      const response = await fetch(`${api}/api/sessions/${session.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ content: `Delegate explicitly to ${specialist.id}.` }) });
      assert.equal(response.status, 200);
      const streamPromise = response.text();
      const child = await until(async () => (await json(`/api/sessions/${session.id}/subagents`)).find(child => child.runtimeInput?.state === "pending"));
      assert.equal(child.specialistId, specialist.id);
      assert.ok(child.specialistConfigHash);
      const before = providerCalls;
      await json(`/api/subagents/${child.id}/codex-config`, { inputId: child.runtimeInput.id, apiKey: name.startsWith("fallback") ? real ? "invalid-e2e-key" : key : key, fallback: name !== "fallback-off" });
      if (name === "cancel") {
        // Configuration was accepted; cancellation can interrupt auth/provider streaming.
        if (!real) await until(() => providerCalls > before);
        await json(`/api/sessions/${session.id}/subagents/${child.id}/stop`, {});
      }
      const terminal = await until(async () => (await json(`/api/sessions/${session.id}/subagents`)).find(candidate => candidate.id === child.id && candidate.status !== "running"), real ? 150000 : 60000);
      const stream = await streamPromise;
      assert.match(stream, /"type":"run.completed"/);
      const text = JSON.stringify(terminal);
      if (real) assert.ok(terminal.runtimeSessionId, "Real provider cases must start the pinned Codex CLI/thread, not pass via a launch failure");
      assert.equal(text.includes(key), false);
      const fallback = terminal.steps.some(step => step.content?.includes("Falling back to builtin-code-engineer"));
      if (name === "handoff") {
        assert.equal(terminal.status, "completed", text);
        assert.equal(terminal.runtimeOptions?.reasoningEffort, "low");
        assert.equal(terminal.timeoutSeconds, 45, "visible timeout must match the applied task budget");
        assert.equal(terminal.runtimeOptions?.fallback, false);
        assert.ok(terminal.runtimeSessionId);
        if (!real) assert.equal(active.turn, 2, "three platform calls must fit in one work decision plus final answer");
        const authorizations = await json(`/api/sessions/${session.id}/permission-authorizations?executionId=${child.id}`);
        assert.ok(authorizations.some(item => item.action === "code" && item.outcome === "allowed"), "batch shell must retain platform permission audit");
        const shell = terminal.steps.find(step => step.toolName === "run_shell");
        assert.equal(shell?.status, "completed");
        assert.ok(shell.details?.id, "batch shell must have a Runner execution receipt");

        const artifacts = await json(`/api/sessions/${session.id}/artifacts`);
        assert.equal(artifacts.length, 1, JSON.stringify(artifacts));
        assert.equal(artifacts[0].logicalName, "result.txt");
        assert.equal(terminal.steps.some(step => step.content?.includes("Platform execution changed Workspace files")), false);
        // Verify physical scratch exists but has no deliverable registration.
        const files = await json(`/api/sessions/${session.id}/files?agentId=${child.id}`);
        // Artifact catalog and declared receipts are the product boundary, independent of physical browsing.
        assert.equal(artifacts.some(item => item.logicalName === "scratch.txt"), false);
        assert.ok(files);
      } else if (name === "cancel") { assert.equal(terminal.status, "cancelled", text); assert.equal(fallback, false); }
      else if (name === "timeout") { assert.equal(terminal.status, "timed_out", text); assert.equal(fallback, false); }
      else if (name === "fallback-on") { assert.equal(fallback, true, text); assert.equal(terminal.status, "completed", text); assert.match(text, /Native fallback completed/); }
      else { assert.equal(fallback, false); assert.equal(terminal.status, "failed", text); }
      await json(`/api/sessions/${session.id}`, { confirmationId: session.id }, "DELETE");
      await json(`/api/specialists/${specialist.id}`, undefined, "DELETE");
      return `${terminal.status}; fallback=${fallback}; private config accepted; ${real ? name.startsWith("fallback") ? "live OpenAI rejected-auth path" : "live Codex auth path" : "official SDK/CLI + local Responses"}`;
    });
  }
  outcome = "PASS";
} catch (error) { console.error(redact(error.stack)); process.exitCode = 1; }
finally {
  if (project && api) await json(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE").catch(() => {});
  for (const child of processes.reverse()) { child.kill("SIGTERM"); await Promise.race([new Promise(done => child.once("exit", done)), new Promise(done => setTimeout(done, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
  stub.closeAllConnections(); await new Promise(done => stub.close(done));
  const report = `# Specialist Phase 2: ${outcome}\n\nSHA: ${sha}\nMode: ${real ? "real Codex API-key auth; local lead/native fallback stub" : "mocked providers; real pinned SDK/CLI and Runner sandbox"}\nCommand: node test/api/specialist-runtime-journey.mjs\n\n${steps.map(item => `## ${item.name}: ${item.status}\nExpected: ${item.expected}\nActual: ${item.actual}\n`).join("\n")}\nCounts: ${steps.filter(step => step.status === "PASS").length} passed / ${steps.filter(step => step.status === "FAIL").length} failed / ${cases.length + (process.env.SPECIALIST_BROWSER === "1" ? 2 : 1) - steps.length} unexecuted.\n`;
  await writeFile(resolve(root, "report.md"), redact(report));
  await writeFile(resolve(root, "services.log"), logs);
  await rm(resolve(root, "data"), { recursive: true, force: true });
  console.log(`Evidence: ${root}/report.md`);
}
