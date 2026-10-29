// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ConfigurationCapabilityId, ConfigurationRequestView, CommitSkillLibraryVersionResult, ModelProfile, Project, Session, SessionRun, SkillLibrary, ScientificArtifact, ScientificArtifactVersion, ReviewCheckpointResult } from "@sciencediscovery/schema";
import { createApiServer, closeApiServer } from "../http/index.js";
import type { ServerConfig } from "../bootstrap/config.js";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";
const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock", "isolation:fresh"] });

type WireMessage = { role?: string; content?: unknown; tool_call_id?: string };
type WireRequest = { stream?: boolean; messages?: WireMessage[]; tools?: Array<{ function?: { name?: string } }>; thinking?: unknown; reasoning_effort?: unknown };
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); }
async function readRequest(request: IncomingMessage): Promise<WireRequest> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest : {};
}
const nextTaskPrompt = "Use the configured workflow to review literature and load both selected research methods. Work without delegation.";
const librarySkillId = "p1-runtime-method";
const witness = "P1_LIBRARY_RUNTIME_WITNESS_739";

async function fixture(context: TestContext, mode: "settings" | "review" | "capability" = "settings", proposal?: { capabilityId: ConfigurationCapabilityId; values: Record<string, unknown>; delayAfterDecisionMs?: number }) {
  const tmp = resolve(process.cwd(), ".tmp"); await mkdir(tmp, { recursive: true });
  const root = await mkdtemp(resolve(tmp, "configuration-p1-runtime-"));
  const oldExecutor = process.env.SCIENCE_AGENT_EXECUTOR; process.env.SCIENCE_AGENT_EXECUTOR = "native";
  const requests: WireRequest[] = [];
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>(done => { releaseBlocker = done; });
  let reportVersionId: string | undefined;
  const provider = createServer(async (request, response) => {
    const input = await readRequest(request);
    if (request.headers.authorization === "Bearer r16-bad-local-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock credential rejected" } })); return;
    }
    const task = Boolean(input.tools?.length);
    if (task) requests.push(input);
    const messages = input.messages ?? [];
    const completed = new Set(messages.filter(message => message.role === "tool").map(message => message.tool_call_id));
    const nextTask = messages.some(message => message.role === "user" && String(message.content).includes(nextTaskPrompt));
    let tool: string | undefined, id: string | undefined, args: unknown;
    let text = "Fixture title";
    const latestUser = messages.filter(message => message.role === "user").at(-1);
    if (mode === "capability" && task) {
      assert.ok(proposal);
      if (!completed.has("r16-search")) { tool = "configuration"; id = "r16-search"; args = { action: "search", query: proposal.capabilityId }; }
      else if (!completed.has("r16-describe")) { tool = "configuration"; id = "r16-describe"; args = { action: "describe", capabilityId: proposal.capabilityId }; }
      else if (!completed.has("r16-propose")) { tool = "configuration"; id = "r16-propose"; args = { action: "propose", capabilityId: proposal.capabilityId, values: proposal.values, reason: "Apply the user's bounded configuration and then finish the original task." }; }
      else { if (proposal.delayAfterDecisionMs) await new Promise(done => setTimeout(done, proposal.delayAfterDecisionMs)); text = "R16_ORIGINAL_TASK_COMPLETE"; }
    } else if (mode === "review" && task) {
      // Runtime review observations arrive as a later user-role data message.
      // Select the actual task instruction, not that observation or a quoted task.
      const taskInstruction = messages.filter(message => message.role === "user" && String(message.content).trim().startsWith("P1_REVIEW_")).at(-1);
      const prompt = String(taskInstruction?.content ?? latestUser?.content);
      const marker = ["P1_REVIEW_BLOCKER", "P1_REVIEW_OLD", "P1_REVIEW_NEW", "P1_REVIEW_GATE_DISABLED"]
        .map(value => ({ value, index: prompt.lastIndexOf(value) })).sort((left, right) => right.index - left.index)[0];
      if (marker?.index !== -1 && marker?.value === "P1_REVIEW_BLOCKER") { await blocker; text = "BLOCKER_RELEASED"; }
      else if (marker?.index !== -1 && (marker?.value === "P1_REVIEW_OLD" || marker?.value === "P1_REVIEW_NEW")) {
        const checkpointId = marker.value === "P1_REVIEW_OLD" ? "p1-checkpoint-old" : "p1-checkpoint-new";
        if (!completed.has(checkpointId)) { tool = "review_checkpoint"; id = checkpointId; args = { artifactVersionIds: [reportVersionId], reason: "Review this fixed report with the task's approved review policy." }; }
        else text = "FROZEN_REVIEW_COMPLETE";
      } else text = "GLOBAL_REVIEW_DISABLED";
    } else if (task && nextTask) {
      if (!completed.has("p1-read-method")) { tool = "read_skill"; id = "p1-read-method"; args = { skillId: librarySkillId }; }
      else if (!completed.has("p1-read-literature")) { tool = "read_skill"; id = "p1-read-literature"; args = { skillId: "literature-searcher" }; }
      else text = "CONFIGURED_WORKFLOW_COMPLETE";
    } else if (task && !completed.has("p1-inspect")) { tool = "configuration"; id = "p1-inspect"; args = { action: "search", query: "skill thinking" }; }
    else if (task && !completed.has("p1-skills")) { tool = "configuration"; id = "p1-skills"; args = { action: "propose",
      capabilityId: "skill.select", values: { skillSelectionMode: "selected", enabledSkillIds: ["literature-searcher"], enabledSkillLibraryIds: ["p1-runtime-library"] }, reason: "Use only the requested installed literature workflow and methods library for subsequent research." }; }
    else if (task && !completed.has("p1-thinking")) { tool = "configuration"; id = "p1-thinking"; args = { action: "propose",
      capabilityId: "thinking.configure", values: { thinkingMode: "enabled", thinkingEffort: "max" }, reason: "Enable the requested supported deep thinking mode for subsequent tasks." }; }
    else if (task) text = "SETTINGS_PROPOSED_FOR_FUTURE";
    if (!input.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] })); return;
    }
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: text };
    const chunk = (value: unknown, finish: string | null) => ({ id: `fixture-${id ?? "final"}`, object: "chat.completion.chunk", created: 1, model: "p1-fixture", choices: [{ index: 0, delta: value, finish_reason: finish }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, tool ? "tool_calls" : "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const providerOrigin = await listen(provider);
  const runner = createServer((request, response) => { request.resume(); response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health" ? { npuBroker: { enabled: false }, scientificEnvs: { available: false, enabled: false }, sandbox: { available: false } } : {})); });
  const runnerOrigin = await listen(runner);
  const config: ServerConfig = { authToken: "configuration-p1-runtime-token", dataDir: root, host: "127.0.0.1", port: 0,
    modelCatalogPath: resolve(root, "absent-models.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    gatewayIdleTimeoutMs: 60_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0, permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240, runnerToken: "runner-token", runnerUrl: runnerOrigin,
    sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"), workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "", internalToken: "" }, evolve: { url: "", internalToken: "" } };
  let api: Server | undefined;
  context.after(async () => {
    releaseBlocker();
    try { if (api) await closeApiServer(api); } finally {
      await close(provider); await close(runner);
      if (oldExecutor === undefined) delete process.env.SCIENCE_AGENT_EXECUTOR; else process.env.SCIENCE_AGENT_EXECUTOR = oldExecutor;
      assert.ok(root.startsWith(tmp + sep)); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  api = createApiServer(config, { mcpTransport: offlineMcpTransport }); let origin = await listen(api);
  async function restart() {
    await closeApiServer(api!);
    api = createApiServer(config, { mcpTransport: offlineMcpTransport }); origin = await listen(api);
  }
  async function ok<T>(path: string, input?: unknown, method = input === undefined ? "GET" : "POST", expected = input === undefined ? 200 : 201): Promise<T> {
    const response = await fetch(origin + path, { method, headers: { authorization: "Bearer configuration-p1-runtime-token", "content-type": "application/json", "Idempotency-Key": randomUUID() },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(60_000) });
    const text = await response.text(); assert.equal(response.status, expected, `${method} ${path}: ${text}`); return JSON.parse(text) as T;
  }
  const model = await ok<ModelProfile>("/api/models", { name: "P1 native wire fixture", model: "p1-fixture", baseUrl: `${providerOrigin}/v1`, apiToken: "fixture-token",
    apiProtocol: "openai-chat-completions", apiVariant: "deepseek", thinkingMode: "disabled", thinkingEffort: "low",
    facts: { thinkingSupported: true, thinkingEfforts: ["low", "max"] } });
  if (proposal?.values.modelId === "$current") proposal.values.modelId = model.id;
  if (proposal?.values.baseUrl === "$provider") proposal.values.baseUrl = `${providerOrigin}/v1`;
  if (proposal?.values.modelId === "$alternative") {
    const alternate = await ok<ModelProfile>("/api/models", { name: "Alternate mock model", model: "alternate-fixture", baseUrl: `${providerOrigin}/v1`, apiToken: "fixture-token" });
    proposal.values.modelId = alternate.id;
  }
  assert.deepEqual(model.facts?.thinkingEfforts, ["low", "max"], "The fixture explicitly declares only the effort values accepted by its provider");
  await ok("/api/settings", { modelId: model.id, enabledConnectorIds: [], semanticReviewEnabled: false }, "PUT", 200);
  await ok<SkillLibrary>("/api/skill-libraries", { id: "p1-runtime-library", name: "P1 methods library" });
  const committed = await ok<CommitSkillLibraryVersionResult>("/api/skill-libraries/p1-runtime-library/versions", { author: { kind: "user" }, operations: [{ type: "upsert", package: { files: [{ path: "SKILL.md",
    content: `---\nname: ${librarySkillId}\ndescription: Research literature review methods for configured workflow evidence\n---\n\n# Research literature methods\n\n${witness}\nUse bounded literature review methods.\n` }] } }] });
  assert.ok(committed.version?.id);
  const project = await ok<Project>("/api/projects", { name: "P1 real runtime assembly", settingsOverrides: { enabledSkillIds: [], skillSelectionMode: "selected" } });
  const session = await ok<Session>(`/api/projects/${project.id}/sessions`, { title: "P1 future run", approvalMode: "always_allow" });
  const path = `/api/sessions/${session.id}`;
  if (mode === "review") {
    await ok("/api/reviewer-specialist/settings", { enabled: true }, "PUT", 200);
    await ok(`${path}/reviewer-specialist/settings`, { automaticReviewEnabled: false, level: "quick" }, "PUT", 200);
    await ok(`${path}/files`, { path: "reports/frozen-review.md", content: "# Review routing fixture\n\nThis report describes a bounded research workflow without numerical or literature claims.\n" });
    const artifact = (await ok<ScientificArtifact[]>(`${path}/artifacts`)).find(item => item.logicalName.endsWith("frozen-review.md"));
    assert.ok(artifact);
    reportVersionId = (await ok<ScientificArtifactVersion[]>(`${path}/artifacts/${artifact.id}/versions`))[0]?.id;
    assert.ok(reportVersionId);
  }
  async function waitRun(id: string): Promise<SessionRun> {
    let latest: SessionRun | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      latest = (await ok<SessionRun[]>(`${path}/runs`)).find(run => run.id === id);
      if (latest?.status === "completed") return latest;
      if (latest && ["failed", "cancelled", "interrupted"].includes(latest.status)) throw new Error(`P1 run ${latest.status}: ${latest.error ?? ""}`);
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error(`P1 run timed out: ${latest?.status}`);
  }
  return { ok, path, requests, waitRun, releaseBlocker, restart, get origin() { return origin; }, model, config, libraryVersionId: committed.version.id };
}

test("CFG-T33 Native /runs: confirmed Skill/Library and thinking cards change actual next-run tool context and provider wire fields", async context => {
  const f = await fixture(context);
  const original = await f.ok<SessionRun>(`${f.path}/runs`, { content: "For future research, use only the installed literature-searcher workflow and the P1 methods library, and enable maximum supported deep thinking. Work in the main Agent." });
  for (const capabilityId of ["skill.select", "thinking.configure"]) {
    const card = await waitPendingCard(f, original.id, capabilityId);
    const before = f.requests.length;
    await new Promise(done => setTimeout(done, 150));
    assert.equal(f.requests.length, before, "No model round runs while the user's configuration decision is pending");
    await decideCard(f, card, "persist");
  }
  await f.waitRun(original.id);
  const originalRequests = [...f.requests];
  assert.ok(originalRequests.length >= 4);
  assert.ok(originalRequests.every(request => request.reasoning_effort !== "max"));
  const originalSystem = originalRequests.flatMap(request => request.messages ?? []).filter(message => message.role === "system").map(message => String(message.content)).join("\n");
  assert.equal(originalSystem.includes("<name>literature-searcher</name>"), false, "The original task cannot acquire a proposed future Skill before approval");
  assert.equal(originalSystem.includes(`<name>${librarySkillId}</name>`), false);
  const boundary = f.requests.length;
  const next = await f.ok<SessionRun>(`${f.path}/runs`, { content: nextTaskPrompt });
  const finished = await f.waitRun(next.id);
  assert.equal(finished.settingsSnapshot.enabledSkillLibraries[0]?.versionId, f.libraryVersionId);
  const actual = f.requests.slice(boundary);
  assert.ok(actual.length >= 3, "Both real read_skill calls must reach the native runtime");
  assert.ok(actual.every(request => JSON.stringify(request.thinking) === JSON.stringify({ type: "enabled" }) && request.reasoning_effort === "max"), "Confirmed thinking fields must be sent to the real provider client");
  const system = actual.flatMap(request => request.messages ?? []).filter(message => message.role === "system").map(message => String(message.content)).join("\n");
  assert.ok(system.includes("<name>literature-searcher</name>")); assert.ok(system.includes(`<name>${librarySkillId}</name>`), "The selected library skill must be recalled into actual runtime skill metadata");
  const methodRead = actual.flatMap(request => request.messages ?? []).find(message => message.role === "tool" && message.tool_call_id === "p1-read-method");
  assert.ok(String(methodRead?.content).includes(witness), "read_skill must return the frozen library instructions, not merely a saved settings ID");
  const installedRead = actual.flatMap(request => request.messages ?? []).find(message => message.role === "tool" && message.tool_call_id === "p1-read-literature");
  assert.ok(String(installedRead?.content).includes("# Literature Searcher Skill"), "The installed Skill must load its actual frozen instructions");
});

test("CFG-T33 Native /runs: queued quick and deep tasks consume their own frozen review policy while the global gate remains live", async context => {
  const f = await fixture(context, "review");
  const blocker = await f.ok<SessionRun>(`${f.path}/runs`, { content: "P1_REVIEW_BLOCKER: wait briefly before completing this independent task." });
  for (let attempt = 0; attempt < 300 && !f.requests.some(request => JSON.stringify(request.messages).includes("P1_REVIEW_BLOCKER")); attempt++)
    await new Promise(done => setTimeout(done, 50));
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes("P1_REVIEW_BLOCKER")));
  const quick = await f.ok<SessionRun>(`${f.path}/runs`, { content: "P1_REVIEW_OLD: use Reviewer Specialist to review the fixed report using this task's saved review policy." });
  assert.equal(quick.settingsSnapshot.sessionReviewer?.level, "quick");
  await f.ok(`${f.path}/reviewer-specialist/settings`, { automaticReviewEnabled: false, level: "deep" }, "PUT", 200);
  const deep = await f.ok<SessionRun>(`${f.path}/runs`, { content: "P1_REVIEW_NEW: use Reviewer Specialist to review the fixed report using this task's saved review policy." });
  assert.equal(deep.settingsSnapshot.sessionReviewer?.level, "deep");
  f.releaseBlocker(); await f.waitRun(blocker.id); await f.waitRun(quick.id); await f.waitRun(deep.id);
  const result = (id: string) => {
    const message = f.requests.flatMap(request => request.messages ?? []).find(item => item.role === "tool" && item.tool_call_id === id);
    assert.ok(message, `The actual Native review_checkpoint result ${id} must return to the model; captured tool results: ${f.requests.flatMap(request => request.messages ?? []).filter(item => item.role === "tool").map(item => item.tool_call_id).join(",")}`);
    return JSON.parse(String(message.content)) as ReviewCheckpointResult;
  };
  const oldResult = result("p1-checkpoint-old"), newResult = result("p1-checkpoint-new");
  assert.equal(oldResult.checkpoint.parentRunId, quick.id); assert.equal(newResult.checkpoint.parentRunId, deep.id);
  assert.equal(oldResult.reviews[0]?.reviewLevel, "quick", "An already queued task must not adopt a later session Deep setting");
  assert.equal(newResult.reviews[0]?.reviewLevel, "deep", "The newly queued task must actually invoke Deep review routing");
  await f.ok("/api/reviewer-specialist/settings", { enabled: false }, "PUT", 200);
  const boundary = f.requests.length;
  const disabled = await f.ok<SessionRun>(`${f.path}/runs`, { content: "P1_REVIEW_GATE_DISABLED: use Reviewer Specialist if it is available, otherwise explain its current availability." });
  await f.waitRun(disabled.id);
  assert.equal(disabled.settingsSnapshot.sessionReviewer?.level, "deep");
  assert.ok(f.requests.slice(boundary).length);
  assert.ok(f.requests.slice(boundary).every(request => !request.tools?.some(tool => tool.function?.name === "review_checkpoint")), "Frozen Deep preferences cannot bypass the live global Reviewer Specialist gate");
});


type RuntimeFixture = Awaited<ReturnType<typeof fixture>>;
async function waitPendingCard(f: RuntimeFixture, runId: string, capabilityId: string): Promise<ConfigurationRequestView> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = (await f.ok<SessionRun[]>(`${f.path}/runs`)).find(item => item.id === runId)!;
    const card = (await f.ok<{ items: ConfigurationRequestView[] }>(`${f.path}/configuration-requests`)).items
      .find(item => item.runId === runId && item.capabilityId === capabilityId && ["awaiting_confirmation", "collecting_input"].includes(item.state));
    if (card && run.status === "blocked" && run.configurationWait && run.configurationCheckpoint?.requestId === card.id) return card;
    assert.ok(!["completed", "failed", "cancelled", "interrupted"].includes(run.status), `Task ended before its decision: ${run.status} ${run.error ?? ""}`);
    await new Promise(done => setTimeout(done, 30));
  }
  throw new Error(`Missing blocked configuration ${capabilityId}`);
}
async function decideCard(f: RuntimeFixture, card: ConfigurationRequestView, option: "persist" | "dismiss") {
  const values = Object.fromEntries(card.fields.flatMap(field => field.kind !== "credential" && field.value !== undefined ? [[field.id, field.value]] : []));
  const prepared = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${card.id}/preview`,
    { expectedRevision: card.revision, values, selectedOptionId: option }, "POST", 200);
  return f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${card.id}/decision`,
    { revision: prepared.revision, previewDigest: prepared.previewDigest, selectedOptionId: option, decision: option === "dismiss" ? "dismiss" : "apply" }, "POST", 200);
}

for (const [capabilityId, values] of [
  ["idea_tree.configure", { maxDepth: 4, maxNodes: 20 }],
  ["model.select", { modelId: "$alternative" }],
  ["timeouts.configure", { gatewayIdleTimeoutMs: 50 }],
  ["quotas.configure", { maxConcurrentSubagents: 2 }],
  ["review.configure", { automaticReviewEnabled: false, level: "quick" }],
] as const) {
  test(`CFG-R16-A/F Native /runs: ${capabilityId} waits, keeps the queue blocked and resumes the same task`, async context => {
    const f = await fixture(context, "capability", { capabilityId, values, delayAfterDecisionMs: 250 });
    const original = await f.ok<SessionRun>(`${f.path}/runs`, { content: `R16 configure ${capabilityId} then finish. Do not delegate.` });
    const card = await waitPendingCard(f, original.id, capabilityId);
    assert.equal(card.activation.mode, "next_run");
    const queued = await f.ok<SessionRun>(`${f.path}/runs`, { content: "Independent later task" });
    const count = f.requests.length;
    await new Promise(done => setTimeout(done, 250));
    assert.equal(f.requests.length, count);
    const waiting = await f.ok<SessionRun[]>(`${f.path}/runs`);
    assert.equal(waiting.find(item => item.id === original.id)?.status, "blocked");
    assert.equal(waiting.find(item => item.id === queued.id)?.status, "queued");
    assert.equal(waiting.find(item => item.id === queued.id)?.startedAt, undefined);
    // Cancel this unrelated queued task; it must not invalidate the original decision.
    await f.ok(`${f.path}/runs/${queued.id}/cancel`, {}, "POST", 200);
    const saved = await decideCard(f, card, "persist");
    assert.equal(saved.state, "applied");
    assert.equal(saved.activation.state, "needs_user_action", "Do not pretend future settings were activated in this task");
    const completed = await f.waitRun(original.id);
    assert.equal(completed.id, original.id);
    assert.deepEqual(completed.settingsSnapshot, original.settingsSnapshot);
    assert.equal(completed.userMessageId !== undefined, true);
    const events = await f.ok<Array<{ event: { type: string } }>>(`${f.path}/runs/${original.id}/events?after=0`);
    assert.equal(events.filter(entry => entry.event.type === "run.completed").length, 1);
    assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes("The pending configuration interaction is resolved")));
  });
}

test("CFG-R16-B Native /runs: declining ordinary configuration returns the decision to the original task", async context => {
  const f = await fixture(context, "capability", { capabilityId: "idea_tree.configure", values: { maxDepth: 4, maxNodes: 20 } });
  const original = await f.ok<SessionRun>(`${f.path}/runs`, { content: "R16 ask for an Idea Tree change" });
  const card = await waitPendingCard(f, original.id, "idea_tree.configure");
  const result = await decideCard(f, card, "dismiss");
  assert.equal(result.state, "dismissed");
  await f.waitRun(original.id);
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes("The user declined the configuration")));
});

test("CFG-R16-C/E Native /runs: collecting a model credential waits and Stop invalidates the decision", async context => {
  const f = await fixture(context, "capability", { capabilityId: "model.connect", values: { name: "Mock connection", model: "mock-new", baseUrl: "https://api.openai.com/v1" } });
  const original = await f.ok<SessionRun>(`${f.path}/runs`, { content: "R16 connect a new model using secure input" });
  const card = await waitPendingCard(f, original.id, "model.connect");
  assert.equal(card.state, "collecting_input");
  const count = f.requests.length;
  await new Promise(done => setTimeout(done, 250));
  assert.equal(f.requests.length, count);
  await f.ok(`${f.path}/runs/${original.id}/cancel`, {}, "POST", 200);
  const response = await fetch(f.origin + `${f.path}/configuration-requests/${card.id}/preview`, { method: "POST",
    headers: { authorization: "Bearer configuration-p1-runtime-token", "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: card.revision, values: {}, selectedOptionId: "dismiss" }) });
  assert.equal(response.status, 409);
  assert.equal((await f.ok<SessionRun[]>(`${f.path}/runs`)).find(item => item.id === original.id)?.status, "cancelled");
  assert.equal(f.requests.length, count);
});


for (const capabilityId of ["model.connect", "model.repair_credential"] as const) {
  test(`CFG-R16-C Native /runs: ${capabilityId} keeps waiting through credential failure then resumes after verified repair`, async context => {
    const values = capabilityId === "model.connect" ? { name: "New local mock", model: "new-local-mock", apiVariant: "deepseek" } : { modelId: "$current" };
    const f = await fixture(context, "capability", { capabilityId, values });
    const original = await f.ok<SessionRun>(`${f.path}/runs`, { content: `R16 prepare ${capabilityId} using secure credentials` });
    let card = await waitPendingCard(f, original.id, capabilityId);
    const count = f.requests.length;
    if (capabilityId === "model.connect") {
      const fields = Object.fromEntries(card.fields.flatMap(field => field.kind !== "credential" && field.value !== undefined ? [[field.id, field.value]] : []));
      card = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${card.id}/preview`,
        { expectedRevision: card.revision, values: { ...fields, baseUrl: f.model.baseUrl }, selectedOptionId: "persist" }, "POST", 200);
    }
    if (card.endpointAuthorization?.status === "required") card = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${card.id}/endpoint-consent`,
      { revision: card.revision, endpointTarget: card.endpointAuthorization.endpointTarget }, "POST", 200);
    for (const secret of ["r16-bad-local-key", "r16-good-local-key"]) {
      const draft = await f.ok<{ handle: string }>(`${f.path}/configuration-requests/${card.id}/credentials`,
        { expectedRevision: card.revision, fieldId: "apiToken", secret }, "POST", 200);
      const fields = Object.fromEntries(card.fields.flatMap(field => field.kind !== "credential" && field.value !== undefined ? [[field.id, field.value]] : []));
      card = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${card.id}/preview`,
        { expectedRevision: card.revision, values: fields, credentialHandle: draft.handle, selectedOptionId: "persist" }, "POST", 200);
      card = await f.ok<ConfigurationRequestView>(`${f.path}/configuration-requests/${card.id}/decision`,
        { revision: card.revision, previewDigest: card.previewDigest, selectedOptionId: "persist", decision: "apply" }, "POST", 200);
      if (secret.includes("bad")) {
        assert.equal(card.state, "needs_fix");
        await new Promise(done => setTimeout(done, 150));
        assert.equal(f.requests.length, count, "Credential validation failure must not release the waiting model loop");
        assert.equal((await f.ok<SessionRun[]>(`${f.path}/runs`)).find(run => run.id === original.id)?.status, "blocked");
      }
    }
    assert.equal(card.state, "applied");
    const completed = await f.waitRun(original.id);
    assert.equal(completed.settingsSnapshot.modelId, original.settingsSnapshot.modelId);
    assert.ok(f.requests.every(request => !JSON.stringify(request).includes("r16-good-local-key")));
  });
}

test("CFG-R16-F Native /runs: restart retains the ordinary configuration checkpoint and resumes its original run", async context => {
  const f = await fixture(context, "capability", { capabilityId: "idea_tree.configure", values: { maxDepth: 4, maxNodes: 20 } });
  const original = await f.ok<SessionRun>(`${f.path}/runs`, { content: "R16 ordinary configuration surviving API restart" });
  const before = await waitPendingCard(f, original.id, "idea_tree.configure");
  const count = f.requests.length;
  await f.restart();
  const after = await waitPendingCard(f, original.id, "idea_tree.configure");
  assert.equal(after.id, before.id);
  assert.equal(f.requests.length, count);
  await decideCard(f, after, "persist");
  await f.waitRun(original.id);
  assert.equal((await f.ok<SessionRun[]>(`${f.path}/runs`)).length, 1, "Recovery does not create a replacement run");
});
