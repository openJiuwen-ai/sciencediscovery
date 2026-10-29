// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
/** E2E-META
 * Purpose: On-demand settings discovery produces a real card and resumes the original research task within bounded model context.
 * Steps: register owned loopback model/MCP; submit normal task; observe search/describe/propose and the running original task waiting on the configuration card;
 * confirm the supported persisted choice, separately allow tool execution and observe actual MCP result; reject another request; Stop a third; clean exact owned records.
 * Environment: committed isolated JiuwenSwarm product with ordinary upstream core, API/Runner healthy, E2E_BASE_URL/E2E_API_TOKEN required.
 * Type: mocked; LLM: owned loopback SSE model; MCP: owned loopback protocol server; WebSearch/PaperSources/OtherExternal: none.
 * Credentials: synthetic model key only; API token used only for the specified loopback product.
 * CostSideEffects: no paid calls; exact UUID-owned model/project/MCP records removed; existing defaults and records preserved.
 * Run: E2E_BASE_URL=http://127.0.0.1:4420 E2E_API_TOKEN=<local token> E2E_STARTUP_COMMAND='<actual startup>' node test/api/jiuwen-configuration-on-demand.mjs
 * --browser prepares an owned session and keeps fixtures alive for a CUA browser journey; SIGTERM cleans its exact records.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(new URL("../../services/api/package.json", import.meta.url));
const { Server: McpServer } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const marker = `jiuwen-on-demand-${randomUUID()}`;
const token = process.env.E2E_API_TOKEN;
const origin = process.env.E2E_BASE_URL;
const directory = `.tmp/${marker}`;
await mkdir(directory, { recursive: true });
const sha = execFileSync("git", ["-c", "core.autocrlf=true", "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const steps = [], requests = [], projects = [], sessions = [], metrics = [];
let model, source, modelServer, mcpServer, baselineModels, baselineDefault, baselineSettings;
let toolCalls = 0, outcome = "FAIL";
const diagnostic = process.env.E2E_DIAGNOSTIC_DIRTY === "1";
const key = `synthetic-${randomUUID()}`;
async function api(path, body, method = body === undefined ? "GET" : "POST", expected = body === undefined ? 200 : 201) {
  const response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(60000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${path}: HTTP ${response.status} ${value.error ?? value.code ?? "unexpected status"}`);
  requests.push({ method, path, status: response.status }); return value;
}
async function step(name, work) {
  try { await work(); steps.push({ name, status: "PASS" }); console.log(`PASS ${name}`); }
  catch (error) { steps.push({ name, status: "FAIL", error: String(error) }); throw error; }
}
async function until(read, label) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Timed out: ${label}`);
}
async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; }
function modelResponse(body) {
  const tools = body.tools ?? [], messages = body.messages ?? [];
  const task = tools.some(tool => tool.function?.name === "configuration");
  let call, content = "Owned fixture title";
  if (task) {
    const completed = new Set(messages.filter(message => message.role === "tool").map(message => message.tool_call_id));
    const toolText = id => String(messages.find(message => message.role === "tool" && message.tool_call_id === id)?.content ?? "");
    const action = (name, id, args) => ({ name, id, args });
    const mode = messages.some(message => message.role === "user" && String(message.content).includes("DECLINE")) ? "DECLINE" : "ALLOW";
    if (!completed.has("cfg-search")) call = action("configuration", "cfg-search", { action: "search", query: marker });
    else if (!completed.has("cfg-describe")) {
      assert.ok(toolText("cfg-search").includes(source.sourceId), "Search discovers owned connector");
      call = action("configuration", "cfg-describe", { action: "describe", capabilityId: "connector.enable", targetId: source.sourceId });
    } else if (!completed.has("cfg-propose")) {
      assert.ok(toolText("cfg-describe").includes(source.sourceId), "Describe identifies owned connector");
      call = action("configuration", "cfg-propose", { action: "propose", capabilityId: "connector.enable", values: { connectorId: source.sourceId } });
    } else if (mode === "DECLINE") {
      assert.ok(toolText("cfg-propose").includes("dismissed"));
      content = `${marker}:DECLINED_CONTINUED`;
    } else if (!completed.has("cfg-readiness")) {
      assert.ok(toolText("cfg-propose").includes("same_run"));
      call = action("mcp_readiness", "cfg-readiness", { action: "check", sourceIds: [source.sourceId], reason: "Use the approved source for this original task" });
    } else if (!completed.has("cfg-invoke")) {
      assert.ok(toolText("cfg-readiness").includes("lookup"), "Readiness exposes the exact recovered tool");
      const recoveredToolId = toolText("cfg-readiness").match(/"toolId"\s*:\s*"([^"]+)"/)?.[1];
      assert.ok(recoveredToolId, "Use the product's exact recovered tool identifier");
      call = action("mcp_recovered_call", "cfg-invoke", { sourceId: source.sourceId, toolId: recoveredToolId, input: {} });
    } else {
      assert.ok(toolText("cfg-invoke").includes("OWNED_RESEARCH_RESULT"));
      content = `${marker}:RESEARCH_COMPLETE`;
    }
    if (call) assert.ok(tools.some(tool => tool.function?.name === call.name), `Tool is actually exposed: ${call.name}`);
    metrics.push({ action: call?.args?.action ?? call?.name ?? "answer", mode });
  }
  return { call, content };
}
async function createSession(mode) {
  const project = await api("/api/projects", { name: `${marker}-${mode}` }); projects.push(project);
  const session = await api(`/api/projects/${project.id}/sessions`, { title: `${marker}-${mode}`, modelId: model.id, enabledConnectorIds: [], enabledSkillIds: [], approvalMode: "always_allow" });
  sessions.push(session);
  await api(`/api/sessions/${session.id}`, { approvalMode: mode === "ALLOW" ? "ask_for_dangerous" : "always_allow" }, "PATCH", 200);
  return session;
}
async function start(session, mode) {
  const run = await api(`/api/sessions/${session.id}/runs`, { content: `${mode}: 使用 ${marker} 资料源获取一条研究结果，然后给出结果。请在主 Agent 中完成，不使用子 Agent。` });
  const card = await until(async () => {
    const value = (await api(`/api/sessions/${session.id}/runs`)).find(item => item.id === run.id);
    if (["failed", "completed", "cancelled"].includes(value.status)) throw new Error(`Expected live waiting task, got ${value.status}: ${value.error}`);
    const { items: cards } = await api(`/api/sessions/${session.id}/configuration-requests`);
    const pending = cards.find(item => item.runId === run.id && item.state === "awaiting_confirmation");
    if (pending) {
      assert.equal(value.status, "running", "Jiuwen waits in the live tool call, not a durable core interrupt");
      assert.ok(!value.configurationCheckpoint, "No legacy core checkpoint is introduced");
    }
    return pending;
  }, "live configuration card");
  assert.equal(card.capabilityId, "connector.enable"); return { run, card };
}
async function decide(session, card, option, decision) {
  if (card.selectedOptionId !== option) card = await api(`/api/sessions/${session.id}/configuration-requests/${card.id}/preview`,
    { expectedRevision: card.revision, values: { connectorId: source.sourceId }, selectedOptionId: option }, "POST", 200);
  return api(`/api/sessions/${session.id}/configuration-requests/${card.id}/decision`,
    { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: option, decision }, "POST", 200);
}
async function completed(session, run) {
  return until(async () => {
    const current = (await api(`/api/sessions/${session.id}/runs`)).find(item => item.id === run.id);
    if (["failed", "cancelled", "interrupted"].includes(current.status)) throw new Error(`Task failed: ${current.error}`);
    return current.status === "completed" ? current : undefined;
  }, "same task completion");
}
async function report() {
  await writeFile(`${directory}/report.md`, `# Configuration on-demand: ${outcome}\n\nCandidate: ${sha}${diagnostic ? " (dirty diagnostic; not immutable acceptance)" : ""}\nBackend: actual JiuwenSwarm; model and MCP are local deterministic fixtures.\nStartup: ${process.env.E2E_STARTUP_COMMAND ?? "missing"}\n\nOwned loopback model and MCP; no commercial model or external requests.\n\n${steps.map((item, i) => `${i + 1}. ${item.name}: ${item.status}${item.error ? ` — ${item.error}` : ""}`).join("\n")}\n`);
  await writeFile(`${directory}/evidence.json`, JSON.stringify({ sha, outcome, steps, metrics, toolCalls, requests, projects: projects.map(item => item.id), sessions: sessions.map(item => item.id) }, null, 2));
}
async function cleanup() {
  for (const session of sessions) {
    await api(`/api/sessions/${session.id}/runs/current/cancel`, undefined, "POST", 200);
    for (const run of await api(`/api/sessions/${session.id}/runs`)) if (!["completed", "failed", "cancelled", "interrupted"].includes(run.status)) await api(`/api/sessions/${session.id}/runs/${run.id}/cancel`, undefined, "POST", [200, 202]);
  }
  for (const session of sessions) await until(async () => (await api(`/api/sessions/${session.id}/runs`)).every(run => ["completed", "failed", "cancelled", "interrupted"].includes(run.status)), "owned runs stop before cleanup");
  for (const project of projects) { assert.ok(project.name.startsWith(marker)); await api(`/api/projects/${project.id}`, { confirmationId: project.id }, "DELETE", 200); }
  if (model) {
    // The first profile becomes the default on an empty stack. Restore only
    // references to this fixture, retaining every unrelated current override.
    const current = await api("/api/settings");
    const overrides = { ...current.overrides };
    let changed = false;
    for (const field of ["modelId", "reviewModelId"]) {
      if (overrides[field] !== model.id) continue;
      if (Object.hasOwn(baselineSettings.overrides, field)) overrides[field] = baselineSettings.overrides[field];
      else delete overrides[field];
      changed = true;
    }
    if (changed) await api("/api/settings", overrides, "PUT", 200);
    await api(`/api/models/${model.id}`, undefined, "DELETE", 200);
  }
  if (source) { const own = (await api("/api/mcp/servers")).find(item => item.id === source.id); assert.equal(own.name, marker); await api(`/api/mcp/servers/${source.id}`, undefined, "DELETE", 200); }
  if (baselineModels) assert.deepEqual((await api("/api/models")).map(item => item.id).sort(), baselineModels.map(item => item.id).sort());
  if (baselineSettings) {
    const restored = await api("/api/settings");
    assert.equal(restored.effective.modelId, baselineDefault, "Restore even an initially absent default");
    for (const field of ["modelId", "reviewModelId"]) {
      assert.equal(restored.overrides[field], baselineSettings.overrides[field]);
    }
  }
}
try {
  await step("Verify isolated Jiuwen product and candidate mode", async () => {
    assert.ok(token && process.env.E2E_STARTUP_COMMAND && origin && ["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    if (!diagnostic) assert.equal(dirty, "", "Formal journey requires an immutable candidate; E2E_DIAGNOSTIC_DIRTY=1 only labels diagnostic worktree runs");
    assert.equal(process.env.E2E_SWARM_TASK, "1", "Actual Jiuwen stack required");
    await api("/health"); baselineModels = await api("/api/models"); baselineSettings = await api("/api/settings"); baselineDefault = baselineSettings.effective.modelId;
  });
  await step("Install only owned loopback model and ready MCP resource", async () => {
    mcpServer = createServer(async (request, response) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = new McpServer({ name: marker, version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "lookup", description: "Owned local research lookup", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => { toolCalls++; return { content: [{ type: "text", text: "OWNED_RESEARCH_RESULT" }] }; });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport); await transport.handleRequest(request, response);
    });
    const mcpOrigin = await listen(mcpServer);
    source = await api("/api/mcp/servers", { name: marker, description: marker, transport: "http", enabled: true, command: "", args: [], cwd: "", url: `${mcpOrigin}/mcp`, env: {}, headers: {}, timeoutSeconds: 15 });
    source = await api(`/api/mcp/servers/${source.id}/test`, {}, "POST", 200); assert.equal(source.status, "ready");
    modelServer = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/fixture-stats") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ toolCalls, modelCalls: metrics.length, errors: metrics.filter(item => item.fixtureError) })); return; }
      try {
        let raw = ""; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw || "{}"); const { call, content } = modelResponse(body);
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content };
          const chunk = (value, reason) => ({ id: marker, choices: [{ index: 0, delta: value, finish_reason: reason }] });
          response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, call ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`);
        } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
      } catch (error) { metrics.push({ fixtureError: String(error) }); response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
    });
    const modelOrigin = await listen(modelServer);
    model = await api("/api/models", { name: marker, model: marker, baseUrl: `${modelOrigin}/v1`, apiToken: key, apiProtocol: "openai-chat-completions", apiVariant: "openai", proxyPolicy: "none" });
  });
  if (process.argv.includes("--browser")) {
    const fixtures = [];
    for (const mode of ["ALLOW", "DECLINE", "STOP"]) {
      const session = await createSession(mode);
      fixtures.push({ mode, sessionId: session.id, projectId: session.projectId,
        url: `${origin}/projects/${session.projectId}/sessions/${session.id}?panel=open`,
        prompt: `${mode}: 使用 ${marker} 资料源获取一条研究结果，然后给出结果。请在主 Agent 中完成，不使用子 Agent。` });
    }
    const info = { sha, marker, directory, fixtures, sourceId: source.sourceId,
      statsUrl: `${model.baseUrl?.replace(/\/v1$/, "") ?? `http://127.0.0.1:${modelServer.address().port}`}/fixture-stats` };
    console.log(JSON.stringify(info));
    await new Promise(resolve => process.once("SIGTERM", resolve));
    outcome = "BROWSER_EVIDENCE_SEPARATE";
  } else {
    await step("Discover one resource, show a card and pause before mutation", async () => {
      const session = await createSession("ALLOW"); const { run, card } = await start(session, "ALLOW");
      assert.equal(toolCalls, 0); assert.equal(card.state, "awaiting_confirmation");
      const modelCallsWhileWaiting = metrics.length;
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(metrics.length, modelCallsWhileWaiting, "The same tool call waits without another model turn");
      await decide(session, card, "persist", "apply");
      const permission = await until(async () => (await api(`/api/permission-requests?sessionId=${session.id}`)).find(item => item.state === "pending"), "independent MCP execution permission");
      assert.equal(toolCalls, 0, "Configuration approval never grants execution permission");
      await api(`/api/permission-requests/${permission.id}/decision`, { decision: "allow_once" }, "POST", 200);
      const done = await completed(session, run); assert.equal(done.id, run.id);
      assert.equal(toolCalls, 1); const detail = await api(`/api/sessions/${session.id}`);
      assert.ok(detail.messages.some(item => item.content.includes(`${marker}:RESEARCH_COMPLETE`)));
      assert.ok((await api(`/api/sessions/${session.id}/settings`)).effective.enabledConnectorIds.includes(source.sourceId));
      const settled = await api(`/api/sessions/${session.id}/configuration-requests/${card.id}`);
      assert.equal(settled.activation.mode, "same_run");
      assert.equal(settled.activation.state, "active");
      const repeated = await decide(session, settled, "persist", "apply");
      assert.equal(repeated.id, settled.id);
      assert.equal((await api(`/api/sessions/${session.id}/runs`)).length, 1);
      assert.equal(toolCalls, 1);
    });
    await step("Refusal continues the same task without invoking the resource", async () => {
      const before = toolCalls, session = await createSession("DECLINE"); const { run, card } = await start(session, "DECLINE");
      await decide(session, card, "dismiss", "dismiss"); await completed(session, run); assert.equal(toolCalls, before);
      assert.ok((await api(`/api/sessions/${session.id}`)).messages.some(item => item.content.includes("DECLINED_CONTINUED")));
    });
    await step("Stop suppresses a pending configuration and never resumes it", async () => {
      const before = toolCalls, session = await createSession("STOP"); const { run, card } = await start(session, "STOP");
      await api(`/api/sessions/${session.id}/runs/${run.id}/cancel`, undefined, "POST", [200, 202]);
      const current = await until(async () => {
        const value = await api(`/api/sessions/${session.id}/configuration-requests/${card.id}`);
        return value.state === "cancelled" ? value : undefined;
      }, "Stop lifecycle reconciliation");
      assert.equal(current.state, "cancelled");
      await until(async () => {
        const stopped = (await api(`/api/sessions/${session.id}/runs`)).find(item => item.id === run.id);
        assert.ok(!["completed", "failed", "interrupted"].includes(stopped.status), `Stop must cancel, not ${stopped.status}`);
        return stopped.status === "cancelled";
      }, "asynchronous Stop reaches cancelled Run");
      assert.equal(toolCalls, before);
    });
    assert.ok(!metrics.some(item => item.fixtureError)); outcome = diagnostic ? "DIAGNOSTIC_PASS" : "PASS";
  }
} catch (error) { console.error(String(error)); steps.push({ name: "Journey failure", status: "FAIL", error: String(error) }); process.exitCode = 1; }
finally {
  await report();
  try { await cleanup(); steps.push({ name: "Remove exact owned records and preserve defaults", status: "PASS" }); }
  catch (error) { outcome = "FAIL"; process.exitCode = 1; steps.push({ name: "Cleanup", status: "FAIL", error: String(error) }); }
  for (const server of [modelServer, mcpServer].filter(Boolean)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await report(); console.log(JSON.stringify({ outcome, sha, report: `${directory}/report.md` }));
}
