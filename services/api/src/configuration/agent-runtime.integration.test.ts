// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock", "isolation:fresh"] });
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import { NativeWebProviderClient, type McpTransportClient } from "@sciencediscovery/data-source";
import { createPublicBiomedSources } from "@sciencediscovery/mcp-sources";
import type { ConfigurationRequestView, McpCatalog, McpInvocation, McpInvokeResponse, ModelProfile, Project, Session, SessionDetail, SessionRun, SessionRunEvent } from "@sciencediscovery/schema";
import { createApiServer, closeApiServer } from "../http/index.js";
import type { ServerConfig } from "../bootstrap/config.js";

type ModelMessage = { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
type ModelRequest = { stream?: boolean; tools?: Array<{ function?: { name?: string } }>; messages?: ModelMessage[] };
async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); }
async function body(request: IncomingMessage): Promise<ModelRequest> {
  const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) as ModelRequest : {};
}
async function fixture(context: TestContext, decision: "apply" | "dismiss", automatic = false,
  choiceOptions: { choice?: "run-only" | "use-web"; web?: boolean; repeatNeed?: boolean; crashBeforeActivation?: boolean } = {}) {
  const tmp = resolve(process.cwd(), ".tmp"); await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(resolve(tmp, "configuration-agent-"));
  const oldExecutor = process.env.SCIENCE_AGENT_EXECUTOR; process.env.SCIENCE_AGENT_EXECUTOR = "native";
  const modelRequests: ModelRequest[] = []; const issued: string[] = []; let invocations = 0, webInvocations = 0;
  const provider = createServer(async (request, response) => {
    const input = await body(request); const task = Boolean(input.tools?.length);
    if (task) modelRequests.push(input);
    const results = new Set((input.messages ?? []).filter(item => item.role === "tool").map(item => item.tool_call_id));
    const inspection = (input.messages ?? []).find(item => item.role === "tool" && item.tool_call_id === "cfg-inspect");
    let discovered: Array<{ id: string; ready: boolean; runtimeEnabled: boolean; canPropose: boolean; sameRunSupported: boolean }> = [];
    try { discovered = JSON.parse(typeof inspection?.content === "string" ? inspection.content : "{}").items?.map((item: { resource?: unknown }) => item.resource).filter(Boolean) ?? []; } catch { /* Missing discovery evidence must not be replaced with a guessed ID. */ }
    let selectedConnector = discovered.find(item => item.ready && !item.runtimeEnabled && item.canPropose && item.sameRunSupported);
    // After proposing, discovery details are elided; the model still has its own exact proposal arguments.
    if (!selectedConnector && results.has("cfg-propose")) for (const message of input.messages ?? []) for (const call of message.tool_calls ?? []) {
      try { const value = JSON.parse(call.function?.arguments ?? "{}");
        if (call.function?.name === "configuration" && value.action === "propose" && value.capabilityId === "connector.enable")
          selectedConnector = { id: value.values.connectorId, ready: true, runtimeEnabled: false, canPropose: true, sameRunSupported: true };
      } catch { /* Invalid previous arguments cannot fabricate discovery. */ }
    }
    const queued = (input.messages ?? []).some(item => item.role === "user" && String(item.content).includes("QUEUE_MARKER"));
    let name: string | undefined, id: string | undefined, args: unknown, text = "Fixture title";
    if (task && queued) text = "QUEUED_TASK_DONE";
    else if (task && !results.has("cfg-inspect")) { name = "configuration"; id = "cfg-inspect"; args = { action: "search", query: "PubMed" }; }
    else if (task && !selectedConnector) text = "DISCOVERY_HAS_NO_READY_CONFIGURABLE_CONNECTOR";
    else if (task && !results.has("cfg-propose")) { name = "configuration"; id = "cfg-propose"; args = { action: "propose", capabilityId: "connector.enable", values: { connectorId: selectedConnector!.id } }; }
    else if (task && choiceOptions.repeatNeed && !results.has("cfg-repeat")) { name = "configuration"; id = "cfg-repeat"; args = { action: "propose", capabilityId: "connector.enable", values: { connectorId: selectedConnector!.id } }; }
    else if (task && decision === "dismiss") text = "CONFIGURATION_DECLINED_CONTINUED";
    else if (task && choiceOptions.choice === "use-web" && !results.has("cfg-web")) { name = "web_search"; id = "cfg-web"; args = { query: "diabetes systematic review" }; }
    else if (task && choiceOptions.choice === "use-web") text = "CONFIGURATION_WEB_ALTERNATIVE_COMPLETE";
    else if (task && !results.has("cfg-discover")) { name = "tool_search"; id = "cfg-discover"; args = { query: `select:mcp__${selectedConnector!.id}__search` }; }
    else if (task && !results.has("cfg-pubmed")) { name = `mcp__${selectedConnector!.id}__search`; id = "cfg-pubmed"; args = { query: "diabetes systematic review", limit: 1 }; }
    else if (task) text = "CONFIGURATION_TASK_COMPLETE: the offline PubMed search completed.";
    if (name) issued.push(name);
    if (!input.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: text };
    const chunk = (value: unknown, finish: string | null) => ({ id: `fixture-${id ?? "final"}`, object: "chat.completion.chunk", created: 1, model: "configuration-agent-fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, name ? "tool_calls" : "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const providerOrigin = await listen(provider);
  const runner = createServer((request, response) => { request.resume(); response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health" ? { npuBroker: { enabled: false }, scientificEnvs: { available: false, enabled: false }, sandbox: { available: false } } : {})); });
  const runnerOrigin = await listen(runner);
  const manifest = createPublicBiomedSources(["pubmed"])[0]!.manifest;
  const catalog = { loadedAt: "2026-10-19T00:00:00.000Z", revision: "configuration-agent-offline-pubmed",
    servers: [{ enabled: true, id: manifest.transport.mcpServerId, transport: "stdio", tools: Object.values(manifest.tools)
      .map(tool => ({ name: tool.mcpToolName ?? tool.id, description: tool.description, schemaHash: `fixture-${tool.id}`, inputSchema: tool.inputSchema })) }] } as unknown as McpCatalog;
  const mcpTransport: McpTransportClient = { catalog: async () => catalog, reload: async () => catalog,
    invoke: async request => {
      assert.equal(request.toolName, "pubmed_search"); assert.equal(request.context.toolCallId, "cfg-pubmed");
      invocations++;
      return { requestId: request.requestId, serverId: request.serverId, toolName: request.toolName, durationMs: 1, isError: false, attempts: [],
        content: [{ type: "json", value: { attribution: "Offline fixture", license: "Fixture data", records: [], retrievedAt: "2026-10-19T00:00:00.000Z", sourceId: "pubmed", toolId: "search", untrusted: true, warnings: [] } }] } as unknown as McpInvokeResponse;
    } };
  const config: ServerConfig = { authToken: "configuration-agent-token", dataDir: root, host: "127.0.0.1", port: 0,
    modelCatalogPath: resolve(root, "absent-models.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    // This suite tests configuration recovery, not gateway idle limits. Keep a
    // bounded budget large enough for child startup and first assembly under
    // the full API suite's concurrent workload.
    gatewayIdleTimeoutMs: 60_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0, permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240, runnerToken: "runner-token", runnerUrl: runnerOrigin,
    sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"), workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "", internalToken: "" }, evolve: { url: "", internalToken: "" } };
  let api: Server | undefined, child: ChildProcess | undefined, childOutput = "";
  let committed!: (value: { requestId: string; receiptId: string }) => void;
  const activationCommitted = new Promise<{ requestId: string; receiptId: string }>(done => { committed = done; });
  async function killChild() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  }
  async function startChild(pauseActivation: boolean): Promise<string> {
    childOutput = "";
    child = fork(fileURLToPath(new URL("./runtime-crash.fixture.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout?.on("data", part => { childOutput = (childOutput + String(part)).slice(-4000); });
    child.stderr?.on("data", part => { childOutput = (childOutput + String(part)).slice(-4000); });
    const ready = new Promise<string>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Crash fixture did not start: ${childOutput}`)), 60_000);
      child!.once("error", error => { clearTimeout(timeout); reject(error); });
      child!.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`Crash fixture exited ${code}/${signal}: ${childOutput}`)); });
      child!.on("message", (message: { type: string; origin?: string; requestId?: string; receiptId?: string; toolCallId?: string; event?: string; fields?: unknown }) => {
        if (message.type === "ready") { clearTimeout(timeout); done(message.origin!); }
        else if (message.type === "committed") committed({ requestId: message.requestId!, receiptId: message.receiptId! });
        else if (message.type === "invocation") { assert.equal(message.toolCallId, "cfg-pubmed"); invocations++; }
        else if (message.type === "diagnostic") childOutput = (childOutput + JSON.stringify({ event: message.event, fields: message.fields })).slice(-4000);
      });
    });
    child.send({ type: "start", config, pauseActivation });
    return ready;
  }
  context.after(async () => {
    try { if (api) await closeApiServer(api); await killChild(); } finally {
      await close(provider); await close(runner);
      if (oldExecutor === undefined) delete process.env.SCIENCE_AGENT_EXECUTOR; else process.env.SCIENCE_AGENT_EXECUTOR = oldExecutor;
      assert.ok(root.startsWith(tmp + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const webProvider = new NativeWebProviderClient();
  webProvider.invoke = async input => { webInvocations++; assert.equal(input.operation, "search");
    return { content: JSON.stringify({ results: [{ title: "Offline web literature", url: "https://example.org/paper", content: "Offline source" }] }), durationMs: 1, isError: false }; };
  let origin: string;
  if (choiceOptions.crashBeforeActivation) origin = await startChild(true);
  else { api = createApiServer(config, { mcpTransport, webProvider }); origin = await listen(api); }
  async function call<T>(path: string, input?: unknown, method = input === undefined ? "GET" : "POST") {
    let response: Response;
    try { response = await fetch(origin + path, { method, headers: { authorization: "Bearer configuration-agent-token", "content-type": "application/json", "Idempotency-Key": randomUUID() },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(60_000) }); }
    catch { throw new Error(`Fixture HTTP timeout: ${method} ${path}; issued=${issued.join(",")}`); }
    const text = await response.text(); return { status: response.status, value: JSON.parse(text) as T, text };
  }
  async function ok<T>(path: string, input?: unknown, method?: string, status = input === undefined ? 200 : 201): Promise<T> {
    const result = await call<T>(path, input, method); assert.equal(result.status, status, `${path}: ${result.text}`); return result.value;
  }
  const model = await ok<ModelProfile>("/api/models", { name: "Configuration agent fixture", model: "configuration-agent-fixture", baseUrl: `${providerOrigin}/v1`, apiToken: "fixture-token" });
  await ok("/api/settings", { modelId: model.id, enabledConnectorIds: choiceOptions.web ? ["web"] : [], semanticReviewEnabled: false }, "PUT", 200);
  const project = await ok<Project>("/api/projects", { name: "Configuration agent runtime", settingsOverrides: { enabledSkillIds: [], skillSelectionMode: "selected" } });
  const session = await ok<Session>(`/api/projects/${project.id}/sessions`, { title: "Configuration runtime fixture", approvalMode: "always_allow", autoApplyLowRiskConfiguration: automatic });
  const path = `/api/sessions/${session.id}`;
  async function waitRun(id: string, status: SessionRun["status"], timeoutMs = 60_000): Promise<SessionRun> {
    let last: SessionRun | undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      last = (await ok<SessionRun[]>(`${path}/runs`)).find(item => item.id === id);
      if (last?.status === status) return last;
      if (last && ["failed", "cancelled", "completed"].includes(last.status)) throw new Error(`Run ended as ${last.status} instead of ${status}: ${last.error ?? ""}; issued=${issued.join(",")}${choiceOptions.crashBeforeActivation ? `; child=${childOutput}` : ""}`);
      if (choiceOptions.crashBeforeActivation && last?.configurationCheckpoint) {
        const phase = await ok<ConfigurationRequestView>(`${path}/configuration-requests/${last.configurationCheckpoint.requestId}`);
        if (["suppressed", "failed"].includes(phase.activation.state)) throw new Error(`Crash recovery activation ${phase.activation.state}; error=${phase.error?.code}; child=${childOutput}`);
      }
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`Timed out waiting for ${status}; latest=${JSON.stringify(last)}; issued=${issued.join(",")}`);
  }
  async function start() {
    // A research request, with no instruction to open a card or resume after confirmation.
    const prompt = "Find recent systematic reviews of diabetes in PubMed and summarize their evidence. Work in the main Agent without delegating.";
    const run = await ok<SessionRun>(`${path}/runs`, { content: prompt });
    const blocked = await waitRun(run.id, "blocked"); assert.equal(blocked.configurationWait, true); assert.ok(blocked.configurationCheckpoint?.historyRef);
    const cards = await ok<{ items: ConfigurationRequestView[] }>(`${path}/configuration-requests`);
    const card = cards.items.find(item => item.runId === run.id && item.capabilityId === "connector.enable");
    assert.ok(card, "The model's generic proposal must expose a card after checkpoint commit");
    assert.equal(card.state, "awaiting_confirmation"); assert.ok(card.previewDigest); assert.ok(card.revision);
    if (!automatic) assert.equal(card.autoApplyAt, undefined, "Tool Always Allow does not authorize configuration changes");
    const events = await ok<SessionRunEvent[]>(`${path}/runs/${run.id}/events`);
    assert.equal(events.filter(item => item.event.type === "run.completed").length, 0);
    assert.equal(blocked.finishedAt, undefined);
    return { run: blocked, card, prompt };
  }
  const select = async (card: ConfigurationRequestView, optionId: string) => {
    const field = card.fields.find(item => item.id === "connectorId");
    if (!field || field.kind !== "enum" || typeof field.value !== "string") throw new Error("The discovered connector card has no exact target field");
    return ok<ConfigurationRequestView>(`${path}/configuration-requests/${card.id}/preview`,
      { expectedRevision: card.revision, values: { connectorId: field.value }, selectedOptionId: optionId }, "POST", 200);
  };
  const decide = async (card: ConfigurationRequestView) => {
    const selected = decision === "dismiss" ? "dismiss" : choiceOptions.choice;
    if (selected && card.protocolVersion === 3 && card.selectedOptionId !== selected) card = await select(card, selected);
    return call<ConfigurationRequestView>(`${path}/configuration-requests/${card.id}/decision`, { revision: card.revision, previewDigest: card.previewDigest, decision,
      ...(card.protocolVersion === 3 ? { selectedOptionId: card.selectedOptionId } : {}) });
  };
  const restart = async () => {
    if (choiceOptions.crashBeforeActivation) { await killChild(); origin = await startChild(false); }
    else { await closeApiServer(api!); api = createApiServer(config, { mcpTransport, webProvider }); origin = await listen(api); }
  };
  return { root, path, session, origin, modelRequests, issued, ok, call, start, select, decide, waitRun, restart,
    activationCommitted, invocations: () => invocations, webInvocations: () => webInvocations };
}

test("CFG Agent runtime: generic proposal blocks, approval resumes the same run, real MCP search executes once, queue follows", async context => {
  const f = await fixture(context, "apply"); const original = await f.start();
  const later = await f.ok<SessionRun>(`${f.path}/runs`, { content: "QUEUE_MARKER: respond after the original task finishes." });
  await new Promise(done => setTimeout(done, 150));
  const held = (await f.ok<SessionRun[]>(`${f.path}/runs`)).find(item => item.id === later.id)!;
  assert.equal(held.status, "queued"); assert.equal(held.startedAt, undefined);
  const decision = await f.decide(original.card); assert.equal(decision.status, 200, decision.text);
  const completed = await f.waitRun(original.run.id, "completed"); const laterCompleted = await f.waitRun(later.id, "completed");
  assert.ok(laterCompleted.startedAt! >= completed.finishedAt!, "The queued run must start only after the original run ends");
  assert.equal(completed.id, original.run.id); assert.equal(completed.userMessageId, original.run.userMessageId);
  assert.equal(f.invocations(), 1);
  for (const [name, count] of [["configuration", 2], ["mcp__pubmed__search", 1]] as const) assert.equal(f.issued.filter(item => item === name).length, count, `${name} must not replay`);
  const events = await f.ok<SessionRunEvent[]>(`${f.path}/runs/${completed.id}/events`);
  assert.equal(events.filter(item => item.event.type === "run.completed").length, 1);
  const searches = await f.ok<McpInvocation[]>(`${f.path}/mcp/invocations`); assert.equal(searches.filter(item => item.sourceId === "pubmed").length, 1);
  const detail = await f.ok<SessionDetail>(f.path);
  assert.equal(detail.messages.filter(message => message.role === "user" && message.content === original.prompt).length, 1);
  assert.equal(detail.messages.filter(message => message.role === "assistant" && message.content.includes("CONFIGURATION_TASK_COMPLETE")).length, 1);
  const saved = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`); assert.equal(saved.activation.state, "active");
  assert.ok(f.modelRequests.some(request => JSON.stringify(request.messages).includes("The user approved enabling")), "The actual resumed model receives the committed decision");
});

test("CFG Agent runtime: refusing the selected option continues original history without enabling or replaying tools", async context => {
  const f = await fixture(context, "dismiss"); const original = await f.start();
  assert.equal((await f.decide(original.card)).status, 200);
  const completed = await f.waitRun(original.run.id, "completed"); assert.equal(completed.userMessageId, original.run.userMessageId);
  assert.equal(f.invocations(), 0); assert.equal(f.issued.filter(name => name === "configuration").length, 2);
  const detail = await f.ok<SessionDetail>(f.path);
  assert.equal(detail.messages.filter(message => message.role === "assistant" && message.content.includes("CONFIGURATION_DECLINED_CONTINUED")).length, 1);
  assert.ok(f.modelRequests.some(request => JSON.stringify(request.messages).includes("The user declined enabling")));
});

test("CFG Agent runtime: Stop invalidates a pending card and never resumes the stopped source run", async context => {
  const f = await fixture(context, "apply"); const original = await f.start();
  const stop = await f.call(`${f.path}/run/cancel`, {}, "POST"); assert.ok([200, 202].includes(stop.status), stop.text);
  await f.waitRun(original.run.id, "cancelled");
  const lateDecision = await f.decide(original.card); assert.ok([409, 410].includes(lateDecision.status), lateDecision.text);
  await new Promise(done => setTimeout(done, 200));
  const runs = await f.ok<SessionRun[]>(`${f.path}/runs`);
  assert.equal(runs.find(item => item.id === original.run.id)!.status, "cancelled"); assert.equal(runs.length, 1);
  assert.equal(f.invocations(), 0); assert.equal(f.issued.length, 2);
});

test("CFG-T36: a v3 choice cannot inherit the previous PubMed thirty-second authorization", async context => {
  const f = await fixture(context, "apply", true); const original = await f.start();
  assert.equal(original.card.protocolVersion, 3); assert.equal(original.card.autoApplyAt, undefined);
  const invalid = await f.call(`${f.path}/configuration-requests/${original.card.id}/decision`, {
    revision: original.card.revision, previewDigest: original.card.previewDigest, decision: "apply" });
  assert.equal(invalid.status, 409, invalid.text);
  await new Promise(done => setTimeout(done, 31_000));
  const during = (await f.ok<SessionRun[]>(`${f.path}/runs`)).find(item => item.id === original.run.id)!;
  assert.equal(during.status, "blocked"); assert.equal(during.configurationWait, true);
  assert.equal(f.invocations(), 0, "No v3 option may be chosen by the old server timer");
  assert.equal((await f.decide(original.card)).status, 200);
  const completed = await f.waitRun(original.run.id, "completed");
  assert.equal(completed.id, original.run.id); assert.equal(completed.userMessageId, original.run.userMessageId);
  assert.equal(f.invocations(), 1); assert.equal(f.issued.filter(name => name === "configuration").length, 2);
  const saved = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  assert.equal(saved.state, "applied"); assert.equal(saved.decisionSource, "user"); assert.equal(saved.activation.state, "active");
  const events = await f.ok<SessionRunEvent[]>(`${f.path}/runs/${original.run.id}/events`);
  assert.equal(events.filter(item => item.event.type === "run.completed").length, 1);
  const detail = await f.ok<SessionDetail>(f.path);
  assert.equal(detail.messages.filter(message => message.role === "assistant" && message.content.includes("CONFIGURATION_TASK_COMPLETE")).length, 1);
});

test("CFG-T31: run-only uses real MCP tools after restart without changing session, frozen run or queued/later tasks", async context => {
  const f = await fixture(context, "apply", false, { choice: "run-only" }); const original = await f.start();
  assert.equal(original.card.protocolVersion, 3); assert.ok(original.card.options?.some(option => option.id === "run-only"));
  assert.equal(original.card.options?.some(option => option.id === "use-web"), false, "No Web alternative may be fabricated when Web is absent");
  const before = await f.ok(`${f.path}/settings`);
  const later = await f.ok<SessionRun>(`${f.path}/runs`, { content: "QUEUE_MARKER: finish after the original task." });
  // Browser reload is read-only, and API restart must retain the paused task and its available choices.
  await f.restart();
  const reloaded = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  assert.equal(reloaded.state, "awaiting_confirmation");
  const decided = await f.decide(reloaded); assert.equal(decided.status, 200, decided.text);
  const completed = await f.waitRun(original.run.id, "completed"); await f.waitRun(later.id, "completed");
  assert.equal(completed.id, original.run.id); assert.equal(completed.userMessageId, original.run.userMessageId); assert.equal(f.invocations(), 1);
  assert.deepEqual(completed.settingsSnapshot, original.run.settingsSnapshot, "Historical base snapshot is immutable");
  assert.deepEqual(await f.ok(`${f.path}/settings`), before, "No temporary session write and rollback is allowed");
  const queued = (await f.ok<SessionRun[]>(`${f.path}/runs`)).find(run => run.id === later.id)!;
  assert.equal(queued.settingsSnapshot.enabledConnectorIds.includes("pubmed"), false);
  const next = await f.ok<SessionRun>(`${f.path}/runs`, { content: "QUEUE_MARKER: ordinary later task." }); await f.waitRun(next.id, "completed");
  assert.equal(next.settingsSnapshot.enabledConnectorIds.includes("pubmed"), false);
  let saved = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  const acknowledgedBy = Date.now() + 5_000;
  while (["queued", "pending"].includes(saved.resumption.state) && Date.now() < acknowledgedBy) {
    await new Promise(done => setTimeout(done, 50));
    saved = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  }
  assert.equal(saved.choiceReceipt?.kind, "run_overlay"); assert.equal(saved.choiceReceipt?.configurationWritten, false);
  assert.equal(saved.activation.state, "active"); assert.equal(saved.resumption.state === "completed" || saved.resumption.state === "started", true);
});

test("CFG-T32: verified Web alternative resumes the original task and invokes existing Web without enabling PubMed", async context => {
  const f = await fixture(context, "apply", false, { choice: "use-web", web: true }); const original = await f.start();
  assert.ok(original.card.options?.some(option => option.id === "use-web" && option.available));
  const before = await f.ok(`${f.path}/settings`);
  const decision = await f.decide(original.card); assert.equal(decision.status, 200, decision.text);
  const completed = await f.waitRun(original.run.id, "completed");
  assert.equal(completed.userMessageId, original.run.userMessageId); assert.equal(f.invocations(), 0); assert.equal(f.webInvocations(), 1);
  assert.deepEqual(await f.ok(`${f.path}/settings`), before);
  const saved = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  assert.equal(saved.state, "dismissed"); assert.equal(saved.choiceReceipt?.kind, "alternative");
  assert.ok(f.modelRequests.some(request => JSON.stringify(request.messages).includes("verified existing Web search alternative")));
});

test("CFG-T32: same task and unchanged need cannot repeatedly prompt after dismissal", async context => {
  const f = await fixture(context, "dismiss", false, { repeatNeed: true }); const original = await f.start();
  assert.equal((await f.decide(original.card)).status, 200);
  await f.waitRun(original.run.id, "completed");
  const cards = await f.ok<{ items: ConfigurationRequestView[] }>(`${f.path}/configuration-requests`);
  assert.equal(cards.items.length, 1); assert.equal(cards.items[0]!.state, "dismissed");
  assert.ok(f.modelRequests.some(request => JSON.stringify(request.messages).includes("CONFIGURATION_NEED_ALREADY_DECIDED")));
  assert.equal(f.invocations(), 0);
});

test("CFG-T31: SIGKILL after durable run-only approval recovers activation and the same original run exactly once", async context => {
  const f = await fixture(context, "apply", false, { choice: "run-only", crashBeforeActivation: true });
  const original = await f.start();
  const before = await f.ok(`${f.path}/settings`);
  const pendingDecision = f.decide(original.card).catch(error => error as Error);
  const committed = await new Promise<{ requestId: string; receiptId: string }>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error("The fixture did not reach its post-commit crash boundary")), 60_000);
    f.activationCommitted.then(value => { clearTimeout(timeout); done(value); }, error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(committed.requestId, original.card.id); assert.ok(committed.receiptId);
  const durable = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  assert.equal(durable.state, "applied"); assert.equal(durable.activation.state, "pending");
  assert.equal(durable.choiceReceipt?.kind, "run_overlay"); assert.equal(f.invocations(), 0);
  const paused = (await f.ok<SessionRun[]>(`${f.path}/runs`)).find(run => run.id === original.run.id)!;
  assert.equal(paused.status, "blocked"); assert.equal(paused.configurationWait, true);
  await f.restart(); await pendingDecision;
  const completed = await f.waitRun(original.run.id, "completed", 80_000);
  assert.equal(completed.id, original.run.id); assert.equal(completed.userMessageId, original.run.userMessageId);
  assert.deepEqual(completed.settingsSnapshot, original.run.settingsSnapshot);
  assert.deepEqual(await f.ok(`${f.path}/settings`), before);
  assert.equal(f.invocations(), 1); assert.equal(f.issued.filter(name => name === "configuration").length, 2);
  const runs = await f.ok<SessionRun[]>(`${f.path}/runs`); assert.equal(runs.length, 1);
  const events = await f.ok<SessionRunEvent[]>(`${f.path}/runs/${original.run.id}/events`);
  assert.equal(events.filter(event => event.event.type === "run.completed").length, 1);
  const saved = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${original.card.id}`);
  assert.equal(saved.activation.state, "active"); assert.equal(saved.choiceReceipt?.configurationWritten, false);
});
