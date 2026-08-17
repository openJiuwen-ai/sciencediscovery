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

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";

import type { CancelRunResult, ModelProfile, Project, RunnerHealth, Session, SessionDetail, SessionRun, SessionRunEvent, SessionUsageSummary } from "@science-agent/schema";

import { createApiServer, type ServerConfig } from "./server.js";

const authorization = { authorization: "Bearer test-token" };
const jsonHeaders = { ...authorization, "content-type": "application/json" };

const RUNNER_HEALTH: RunnerHealth = {
  cgroupDelegated: false,
  cgroupMode: "none",
  cgroupRoot: "",
  executionAuth: "bearer+hmac-sha256",
  executionUser: "test",
  executionTimeoutMs: 60_000,
  maxFileBytes: 0,
  maxOutputBytes: 1_000_000,
  maxWorkspaceBytes: 1024,
  networkPolicy: "none",
  noNewPrivileges: true,
  npuBroker: { enabled: false, queueConcurrency: 1, workloads: [] },
  runnerVersion: "test",
  sandbox: "bubblewrap",
  scientificEnvs: { available: false, enabled: false, languages: [], provisioner: "test", startersReady: false },
  seccompBaseline: "multiarch-v1-profile-aware",
  status: "ok",
  workerConcurrency: null,
};

function testConfig(dataDir: string, runnerUrl: string, gatewayUrl: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 240_000,
    gatewayUrl,
    gatewayInternalToken: "test-gateway-token",
    gatewayTurnTimeoutMs: 0,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 0,
    paperPythonPath: resolve(process.cwd(), "../paper/.venv/bin/python"),
    paperWorkerPath: resolve(process.cwd(), "../paper/paper_worker.py"),
    permissionWaitTimeoutMs: 0,
    port: 0,
    runnerExecTimeoutMs: 0,
    runnerMaxOutputBytes: 1_000_000,
    runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token",
    runnerUrl,
    sshConfigPath: resolve(dataDir, "ssh-config"),
    staticDir: resolve(dataDir, "missing-web-dist"),
    workspaceUpload: {
      maxFileBytes: 1_000_000,
      maxRequestBytes: 10_000_000,
      maxWorkspaceBytes: 10_737_418_240,
    },
    memoryGraph: { url: "http://127.0.0.1:17674", internalToken: "test" },
  };
}

/**
 * Reproduces a stuck run: the model endpoint accepts `POST /chat/completions`
 * and never answers, so the agent turn hangs and the SSE stream produces no
 * terminal event until something aborts it.
 */
function startHangingGateway(context: TestContext): Promise<{ origin: string; runCount: () => number }> {
  let runCount = 0;
  const openRuns: ServerResponse[] = [];
  const server = createHttpServer((request, response) => {
    if (request.url === "/chat/completions" && request.method === "POST") {
      runCount += 1;
      request.resume();
      openRuns.push(response);
      return; // never respond
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise<void>((done) => {
    for (const open of openRuns) open.destroy();
    server.close(() => done());
    server.closeAllConnections();
  }));
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready({
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      runCount: () => runCount,
    }));
  });
}

function writeSseEvent(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** The scripted model calls run_python, so the REAL in-process tool execution
 *  hits the permission gate and the run blocks awaiting the user's decision. */
function startBlockingPermissionGateway(context: TestContext): Promise<{ origin: string; runCount: () => number }> {
  let runCount = 0;
  const server = createHttpServer((request, response) => {
    if (request.url === "/chat/completions" && request.method === "POST") {
      runCount += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        writeSseEvent(response, {
          choices: [{ delta: { tool_calls: [{ index: 0, id: `call-python-${runCount}`, type: "function", function: { name: "run_python", arguments: JSON.stringify({ code: "print(1)" }) } }] } }],
        });
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready({
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      runCount: () => runCount,
    }));
  });
}

function startUsageGateway(context: TestContext): Promise<{ origin: string; runCount: () => number }> {
  let runCount = 0;
  const server = createHttpServer((request, response) => {
    if (request.url === "/chat/completions" && request.method === "POST") {
      runCount += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        writeSseEvent(response, { choices: [{ delta: { content: "Done" } }] });
        writeSseEvent(response, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready({
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      runCount: () => runCount,
    }));
  });
}

/** Only `/health` is reached in these tests; no Runner execution is started. */
function startStubRunner(context: TestContext): Promise<string> {
  const server = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(RUNNER_HEALTH));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  context.after(() => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

interface TestApi {
  gatewayRunCount: () => number;
  modelId: string;
  origin: string;
  projectId: string;
}

async function startApi(
  context: TestContext,
  name: string,
  startGateway: (context: TestContext) => Promise<{ origin: string; runCount: () => number }> = startHangingGateway,
): Promise<TestApi> {
  const dataDir = resolve(process.cwd(), ".tmp", `${name}-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const [runnerUrl, gateway] = await Promise.all([startStubRunner(context), startGateway(context)]);
  const server = createApiServer(testConfig(dataDir, runnerUrl, gateway.origin));
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  context.after(() => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const modelResponse = await fetch(`${origin}/api/models`, {
    body: JSON.stringify({
      apiToken: "test-model-token",
      baseUrl: gateway.origin,
      model: "test-model",
      name: "Test model",
      vision: false,
    }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(modelResponse.status, 201);
  const projectResponse = await fetch(`${origin}/api/projects`, {
    body: JSON.stringify({ name: `Project ${name}` }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(projectResponse.status, 201);
  return {
    gatewayRunCount: gateway.runCount,
    modelId: (await modelResponse.json() as ModelProfile).id,
    origin,
    projectId: (await projectResponse.json() as Project).id,
  };
}

async function createSession(api: TestApi, title: string, overrides: Partial<Pick<Session, "approvalMode">> = {}): Promise<string> {
  const response = await fetch(`${api.origin}/api/projects/${api.projectId}/sessions`, {
    body: JSON.stringify({ ...overrides, modelId: api.modelId, title }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(response.status, 201);
  return (await response.json() as Session).id;
}

function startRun(api: TestApi, sessionId: string, content: string): Promise<Response> {
  return fetch(`${api.origin}/api/sessions/${sessionId}/messages`, {
    body: JSON.stringify({ content }),
    headers: jsonHeaders,
    method: "POST",
  });
}

async function createRun(api: TestApi, sessionId: string, content: string): Promise<SessionRun> {
  const response = await fetch(`${api.origin}/api/sessions/${sessionId}/runs`, {
    body: JSON.stringify({ content }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(response.status, 201);
  return await response.json() as SessionRun;
}

function cancelRun(api: TestApi, sessionId: string): Promise<Response> {
  return fetch(`${api.origin}/api/sessions/${sessionId}/runs/current/cancel`, {
    headers: authorization,
    method: "POST",
  });
}

function cancelRunById(api: TestApi, sessionId: string, runId: string): Promise<Response> {
  return fetch(`${api.origin}/api/sessions/${sessionId}/runs/${runId}/cancel`, {
    headers: authorization,
    method: "POST",
  });
}

async function listRuns(api: TestApi, sessionId: string): Promise<SessionRun[]> {
  const response = await fetch(`${api.origin}/api/sessions/${sessionId}/runs`, { headers: authorization });
  assert.equal(response.status, 200);
  return await response.json() as SessionRun[];
}

async function getSession(api: TestApi, sessionId: string): Promise<SessionDetail> {
  const response = await fetch(`${api.origin}/api/sessions/${sessionId}`, { headers: authorization });
  assert.equal(response.status, 200);
  return await response.json() as SessionDetail;
}

async function getUsage(api: TestApi, sessionId: string): Promise<SessionUsageSummary> {
  const response = await fetch(`${api.origin}/api/sessions/${sessionId}/usage`, { headers: authorization });
  assert.equal(response.status, 200);
  return await response.json() as SessionUsageSummary;
}

/** Collect SSE event types until the stream ends or a terminal run event arrives. */
async function readUntilTerminal(response: Response): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const types: string[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const payload = frame.split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (payload) types.push((JSON.parse(payload) as { type: string }).type);
    }
    if (done) return types;
  }
}

/** Give the hung gateway turn time to actually be in flight before stopping it. */
async function waitForGatewayTurn(api: TestApi, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && api.gatewayRunCount() < expected; attempt += 1) {
    await new Promise((wait) => setTimeout(wait, 25));
  }
  assert.equal(api.gatewayRunCount(), expected, "the agent turn reached the gateway and hung there");
}

async function waitForRunStatus(api: TestApi, sessionId: string, runId: string, status: SessionRun["status"]): Promise<SessionRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = (await listRuns(api, sessionId)).find((candidate) => candidate.id === runId);
    if (run?.status === status) return run;
    await new Promise((wait) => setTimeout(wait, 25));
  }
  const current = (await listRuns(api, sessionId)).find((candidate) => candidate.id === runId);
  assert.equal(current?.status, status, `expected run ${runId} to become ${status}`);
  return current!;
}

test("cancelling a queued run does not start it or append it to Session context", async (context) => {
  const api = await startApi(context, "queued-cancel");
  const sessionId = await createSession(api, "Queued cancellation");

  const active = await createRun(api, sessionId, "Keep the gateway busy");
  await waitForGatewayTurn(api, 1);

  const queued = await createRun(api, sessionId, "Do not write this queued prompt");
  assert.equal(queued.status, "queued");

  const cancel = await cancelRunById(api, sessionId, queued.id);
  assert.equal(cancel.status, 200);
  assert.equal(((await cancel.json()) as SessionRun).status, "cancelled");

  await new Promise((wait) => setTimeout(wait, 150));
  assert.equal(api.gatewayRunCount(), 1, "the cancelled queued run was never admitted to the gateway");
  const detail = await getSession(api, sessionId);
  assert.deepEqual(detail.messages.map((message) => message.content), ["Keep the gateway busy"]);

  assert.equal((await cancelRunById(api, sessionId, active.id)).status, 202);
  await waitForRunStatus(api, sessionId, active.id, "cancelled");
});

test("a blocked run holds its Session queue until the user decides permission", async (context) => {
  const api = await startApi(context, "blocked-queue", startBlockingPermissionGateway);
  const sessionId = await createSession(api, "Blocked queue", { approvalMode: "ask_for_dangerous" });

  const blocked = await createRun(api, sessionId, "Run code and wait for approval");
  await waitForGatewayTurn(api, 1);
  await waitForRunStatus(api, sessionId, blocked.id, "blocked");

  const queued = await createRun(api, sessionId, "This must not overtake the blocked run");
  assert.equal(queued.status, "queued");
  await new Promise((wait) => setTimeout(wait, 250));
  assert.equal(api.gatewayRunCount(), 1, "queued work did not overtake a blocked run in the same Session");
  const runs = await listRuns(api, sessionId);
  assert.equal(runs.find((run) => run.id === blocked.id)?.status, "blocked");
  assert.equal(runs.find((run) => run.id === queued.id)?.status, "queued");

  assert.equal((await cancelRunById(api, sessionId, queued.id)).status, 200);
  assert.equal((await cancelRunById(api, sessionId, blocked.id)).status, 202);
  await waitForRunStatus(api, sessionId, blocked.id, "cancelled");
});

test("GET session usage reports gateway token usage for a completed run", async (context) => {
  const api = await startApi(context, "usage-http", startUsageGateway);
  const sessionId = await createSession(api, "Usage HTTP");

  const run = await createRun(api, sessionId, "Measure usage");
  await waitForRunStatus(api, sessionId, run.id, "completed");

  const usage = await getUsage(api, sessionId);
  assert.equal(usage.sessionId, sessionId);
  assert.equal(usage.totals.invocationCount, 1);
  assert.equal(usage.totals.inputTokens, 7);
  assert.equal(usage.totals.outputTokens, 3);
  assert.equal(usage.totals.totalTokens, 10);
  assert.equal(usage.totals.unreportedInvocationCount, 0);
});

test("stopping a stuck run ends the stream as cancelled and frees the Session", async (context) => {
  const api = await startApi(context, "run-cancel");
  const sessionId = await createSession(api, "Stuck session");

  const cancelBeforeRun = await cancelRun(api, sessionId);
  assert.equal(cancelBeforeRun.status, 409, "cancelling with no active run is an explicit conflict");
  assert.match((await cancelBeforeRun.json() as { error: string }).error, /No run is active/);

  const run = await startRun(api, sessionId, "Analyze the dataset");
  assert.equal(run.status, 200);
  const streamed = readUntilTerminal(run);
  await waitForGatewayTurn(api, 1);

  const queued = await startRun(api, sessionId, "Second run while the first is stuck");
  assert.equal(queued.status, 200, "a second prompt queues behind the active run");
  const queuedStream = readUntilTerminal(queued);

  const cancel = await cancelRun(api, sessionId);
  assert.equal(cancel.status, 200);
  const cancelResult = await cancel.json() as CancelRunResult;
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.sessionId, sessionId);

  const types = await streamed;
  assert.equal(types.at(0), "run.queued");
  assert.ok(types.includes("run.started"), `expected a started event, saw ${types.join(",")}`);
  assert.ok(types.includes("run.cancelled"), `expected a cancel terminal event, saw ${types.join(",")}`);
  assert.ok(!types.includes("run.failed"), "a user stop is not reported as a run failure");

  await waitForGatewayTurn(api, 2);
  const queuedCancel = await cancelRun(api, sessionId);
  assert.equal(queuedCancel.status, 200, "the queued follow-up becomes the current run and can be stopped");
  assert.ok((await queuedStream).includes("run.cancelled"));
  assert.equal((await cancelRun(api, sessionId)).status, 409, "a repeated Stop after the queue drains is a safe no-op");
});

test("a stuck Session does not block runs in another Session", async (context) => {
  const api = await startApi(context, "run-isolation");
  const stuckSessionId = await createSession(api, "Session A");
  const otherSessionId = await createSession(api, "Session B");

  const stuckRun = await startRun(api, stuckSessionId, "Hang here");
  assert.equal(stuckRun.status, 200);
  const stuckStream = readUntilTerminal(stuckRun);
  await waitForGatewayTurn(api, 1);

  const otherRun = await startRun(api, otherSessionId, "Run in the other Session");
  assert.equal(otherRun.status, 200, "the server isolates run admission per Session");
  const otherStream = readUntilTerminal(otherRun);
  await waitForGatewayTurn(api, 2);

  assert.equal((await cancelRun(api, otherSessionId)).status, 200, "each Session cancels its own run");
  assert.ok((await otherStream).includes("run.cancelled"));

  // Session A was never touched by Session B's cancel and is still running.
  assert.equal((await cancelRun(api, stuckSessionId)).status, 200);
  assert.ok((await stuckStream).includes("run.cancelled"));
});

test("cancelling a blocked run persists the approval's terminal state and the tool input in the replay", async (context) => {
  const api = await startApi(context, "blocked-cancel-replay", startBlockingPermissionGateway);
  const sessionId = await createSession(api, "Blocked cancel replay", { approvalMode: "ask_for_dangerous" });

  const blocked = await createRun(api, sessionId, "Run code and wait for approval");
  await waitForGatewayTurn(api, 1);
  await waitForRunStatus(api, sessionId, blocked.id, "blocked");
  assert.equal((await cancelRunById(api, sessionId, blocked.id)).status, 202);
  await waitForRunStatus(api, sessionId, blocked.id, "cancelled");

  const eventsResponse = await fetch(
    `${api.origin}/api/sessions/${sessionId}/runs/${blocked.id}/events`,
    { headers: authorization },
  );
  assert.equal(eventsResponse.status, 200);
  const events = await eventsResponse.json() as SessionRunEvent[];

  const started = events.find((record) => record.event.type === "tool.started");
  assert.ok(started?.event.type === "tool.started");
  assert.match(JSON.stringify(started.event.trace.args ?? {}), /print\(1\)/, "the replayed tool call keeps its arguments");

  const requiredIndex = events.findIndex((record) => record.event.type === "permission.required");
  assert.ok(requiredIndex >= 0, "the approval request itself is part of the replay");

  const resolvedRecords = events.filter((record) => record.event.type === "permission.resolved");
  assert.equal(resolvedRecords.length, 1, "the terminal state is published exactly once");
  const resolved = resolvedRecords[0]!;
  assert.ok(resolved.event.type === "permission.resolved", "an undecided approval still reaches a terminal event");
  assert.equal(resolved.event.request.state, "cancelled");
  assert.ok(resolved.event.request.decidedAt, "the terminal state carries its decision time");
  assert.ok(resolved.sequence > events[requiredIndex]!.sequence);
});

test("run child stream endpoint serves empty streams and rejects invalid ids", async (context) => {
  const api = await startApi(context, "stream-endpoint", startBlockingPermissionGateway);
  const sessionId = await createSession(api, "Stream endpoint", { approvalMode: "ask_for_dangerous" });
  const blocked = await createRun(api, sessionId, "Run code and wait for approval");
  await waitForGatewayTurn(api, 1);
  await waitForRunStatus(api, sessionId, blocked.id, "blocked");

  const empty = await fetch(
    `${api.origin}/api/sessions/${sessionId}/runs/${blocked.id}/streams/tool-missing/events`,
    { headers: authorization },
  );
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), [], "a dangling stream reference reads as an empty stream");

  const invalid = await fetch(
    `${api.origin}/api/sessions/${sessionId}/runs/${blocked.id}/streams/..%2Fescape/events`,
    { headers: authorization },
  );
  assert.equal(invalid.status, 400);

  assert.equal((await cancelRunById(api, sessionId, blocked.id)).status, 202);
  await waitForRunStatus(api, sessionId, blocked.id, "cancelled");
});
