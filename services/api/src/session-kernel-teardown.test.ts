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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import type { CreateProjectResponse, Project, Session } from "@sciencediscovery/schema";

import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import { createApiServer, type ServerConfig } from "./server.js";

const authorization = { authorization: "Bearer test-token" };
const jsonHeaders = { ...authorization, "content-type": "application/json" };

function testConfig(dataDir: string, runnerUrl: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 120_000,
    gatewayTurnTimeoutMs: 300_000,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 300_000,
    modelCatalogPath: resolve(dataDir, "model-catalog/absent.json"),
    paperPythonPath: resolve(process.cwd(), "../paper/.venv/bin/python"),
    paperWorkerPath: resolve(process.cwd(), "../paper/paper_worker.py"),
    permissionWaitTimeoutMs: 300_000,
    port: 0,
    runnerExecTimeoutMs: 300_000,
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
    evolve: { url: "", internalToken: "" },
  };
}

interface TeardownRequest {
  reason: string;
  sessionId: string;
}

interface RunnerStubOptions {
  /** Status the Runner answers `/health` with; a non-200 is an unreachable probe. */
  healthStatus?: 200 | 503;
  /** Status the Runner answers `POST /kernels/teardown` with. */
  teardownStatus?: 200 | 503;
}

/** A Runner stub that records every teardown request, whether it answers it or not. */
async function startRunnerStub(
  context: TestContext,
  options: RunnerStubOptions = {},
): Promise<{ origin: string; teardowns: TeardownRequest[] }> {
  const teardowns: TeardownRequest[] = [];
  const runner = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://runner.test");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(`${JSON.stringify(body)}\n`);
    };
    if (url.pathname === "/health") {
      if ((options.healthStatus ?? 200) !== 200) return send(options.healthStatus!, { error: "Runner is unavailable" });
      return send(200, { status: "ok", scientificEnvs: { available: true } });
    }
    if (url.pathname === "/kernels/teardown" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TeardownRequest;
      teardowns.push(body);
      if ((options.teardownStatus ?? 200) !== 200) return send(options.teardownStatus!, { error: "Kernel teardown failed" });
      return send(200, { count: 1, reason: body.reason });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((ready) => runner.listen(0, "127.0.0.1", ready));
  context.after(() => new Promise<void>((done) => {
    runner.close(() => done());
    runner.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`, teardowns };
}

async function startApi(context: TestContext, runnerUrl: string): Promise<{ origin: string; dataDir: string }> {
  const dataDir = resolve(process.cwd(), ".tmp", `session-kernel-teardown-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 }));
  // Pin the operational log to this fixture. `createApiServer` reads the
  // directory and the threshold once, when it builds its logger, so the
  // variables only have to live for that call.
  const previousLogDir = process.env.SCIENCE_AGENT_LOG_DIR;
  const previousLogLevel = process.env.SCIENCE_AGENT_LOG_LEVEL;
  process.env.SCIENCE_AGENT_LOG_DIR = resolve(dataDir, "logs");
  process.env.SCIENCE_AGENT_LOG_LEVEL = "warn";
  let api: ReturnType<typeof createApiServer>;
  try {
    api = createApiServer(testConfig(dataDir, runnerUrl), { mcpTransport: offlineMcpTransport });
  } finally {
    if (previousLogDir === undefined) delete process.env.SCIENCE_AGENT_LOG_DIR;
    else process.env.SCIENCE_AGENT_LOG_DIR = previousLogDir;
    if (previousLogLevel === undefined) delete process.env.SCIENCE_AGENT_LOG_LEVEL;
    else process.env.SCIENCE_AGENT_LOG_LEVEL = previousLogLevel;
  }
  await new Promise<void>((ready) => api.listen(0, "127.0.0.1", ready));
  context.after(() => new Promise<void>((done) => {
    api.close(() => done());
    api.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, dataDir };
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<{ body: T; response: Response }> {
  const response = await fetch(url, init);
  return { body: (await response.json()) as T, response };
}

/** One Project with one Session per title, all created through the public API. */
async function createSessions(origin: string, titles: string[]): Promise<string[]> {
  const project = await jsonRequest<CreateProjectResponse>(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Kernel teardown" }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(project.response.status, 201);
  const sessionIds = [project.body.firstSession.id];
  for (const title of titles.slice(1)) {
    const session = await jsonRequest<Session>(`${origin}/api/projects/${(project.body as Project).id}/sessions`, {
      body: JSON.stringify({ title }),
      headers: jsonHeaders,
      method: "POST",
    });
    assert.equal(session.response.status, 201);
    sessionIds.push(session.body.id);
  }
  return sessionIds;
}

async function readRunLog(dataDir: string): Promise<string> {
  return await readFile(resolve(dataDir, "logs", "run.log"), "utf8");
}

test("archiving, deleting and switching approval mode tear kernels down even when the Runner health probe fails", async (context) => {
  const runner = await startRunnerStub(context, { healthStatus: 503 });
  const { origin } = await startApi(context, runner.origin);
  const [archivedSessionId, approvalSessionId, deletedSessionId] = await createSessions(origin, [
    "Archived Session", "Approval Session", "Deleted Session",
  ]) as [string, string, string];

  const archived = await jsonRequest<Session>(`${origin}/api/sessions/${archivedSessionId}/archive`, {
    headers: authorization,
    method: "POST",
  });
  assert.equal(archived.response.status, 200);
  assert.ok(archived.body.archivedAt);

  const approvalMode = await jsonRequest<Session>(`${origin}/api/sessions/${approvalSessionId}`, {
    body: JSON.stringify({ approvalMode: "always_allow" }),
    headers: jsonHeaders,
    method: "PATCH",
  });
  assert.equal(approvalMode.response.status, 200);
  assert.equal(approvalMode.body.approvalMode, "always_allow");

  const deleted = await fetch(`${origin}/api/sessions/${deletedSessionId}`, {
    body: JSON.stringify({ confirmationId: deletedSessionId }),
    headers: jsonHeaders,
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${origin}/api/sessions/${deletedSessionId}`, { headers: authorization })).status, 404);

  // The unreachable health probe used to be read as "this Session has no
  // kernels", which skipped all three teardowns while still answering 200.
  assert.deepEqual(runner.teardowns.map((request) => request.sessionId).toSorted(),
    [archivedSessionId, approvalSessionId, deletedSessionId].toSorted());
  const reasons = new Map(runner.teardowns.map((request) => [request.sessionId, request.reason]));
  assert.match(reasons.get(archivedSessionId)!, /Session was archived/);
  assert.match(reasons.get(approvalSessionId)!, /Approval mode changed/);
  assert.match(reasons.get(deletedSessionId)!, /Session was deleted/);
});

test("a failed kernel teardown keeps the route's success response and records a structured warn", async (context) => {
  const runner = await startRunnerStub(context, { healthStatus: 200, teardownStatus: 503 });
  const { origin, dataDir } = await startApi(context, runner.origin);
  const [archivedSessionId, approvalSessionId, deletedSessionId] = await createSessions(origin, [
    "Archived Session", "Approval Session", "Deleted Session",
  ]) as [string, string, string];

  const archived = await jsonRequest<Session>(`${origin}/api/sessions/${archivedSessionId}/archive`, {
    headers: authorization,
    method: "POST",
  });
  assert.equal(archived.response.status, 200);

  const approvalMode = await jsonRequest<Session>(`${origin}/api/sessions/${approvalSessionId}`, {
    body: JSON.stringify({ approvalMode: "always_allow" }),
    headers: jsonHeaders,
    method: "PATCH",
  });
  assert.equal(approvalMode.response.status, 200);

  const deleted = await fetch(`${origin}/api/sessions/${deletedSessionId}`, {
    body: JSON.stringify({ confirmationId: deletedSessionId }),
    headers: jsonHeaders,
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.equal((await fetch(`${origin}/api/sessions/${deletedSessionId}`, { headers: authorization })).status, 404);

  assert.deepEqual(runner.teardowns.map((request) => request.sessionId).toSorted(),
    [archivedSessionId, approvalSessionId, deletedSessionId].toSorted());
  const log = await readRunLog(dataDir);
  for (const sessionId of [archivedSessionId, approvalSessionId, deletedSessionId]) {
    const line = log.split("\n").find((entry) =>
      entry.includes("event=session_kernel_teardown_failed") && entry.includes(`sessionId=${sessionId}`));
    assert.ok(line, `expected a teardown warning naming ${sessionId}:\n${log}`);
    assert.match(line!, /errorMessage=/);
  }
});
