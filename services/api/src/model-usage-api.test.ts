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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";

import type { GlobalModelUsageSummary, ModelProfile, Project, RunnerHealth, Session, SessionUsageSummary } from "@science-agent/schema";

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
  sandboxNetwork: { available: true, modes: ["none", "domain-allowlist"] },
  scientificEnvs: { available: false, enabled: false, languages: [], provisioner: "test", startersReady: false },
  seccompBaseline: "multiarch-v1-profile-aware",
  status: "ok",
  workerConcurrency: null,
};

function testConfig(dataDir: string, runnerUrl: string, gatewayUrl: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayUrl,
    gatewayInternalToken: "test-gateway-token",
    gatewayIdleTimeoutMs: 120_000,
    gatewayTurnTimeoutMs: 300_000,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 300_000,
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
  };
}

function startStubDeps(context: TestContext): Promise<{ gatewayOrigin: string; runnerOrigin: string }> {
  const gateway = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404).end();
  });
  const runner = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(RUNNER_HEALTH));
      return;
    }
    response.writeHead(404).end();
  });
  context.after(() => new Promise<void>((done) => {
    gateway.close(() => runner.close(() => done()));
    gateway.closeAllConnections();
    runner.closeAllConnections();
  }));
  return new Promise((ready) => {
    gateway.listen(0, "127.0.0.1", () => {
      runner.listen(0, "127.0.0.1", () => {
        ready({
          gatewayOrigin: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
          runnerOrigin: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`,
        });
      });
    });
  });
}

test("USG-013 session and global usage APIs expose breakdown fields", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `usage-api-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));

  const deps = await startStubDeps(context);
  const api = createApiServer(testConfig(dataDir, deps.runnerOrigin, deps.gatewayOrigin));
  await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((done) => {
    api.close(() => done());
    api.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const modelResponse = await fetch(`${origin}/api/models`, {
    body: JSON.stringify({
      apiToken: "token",
      baseUrl: "https://models.example.test/v1",
      model: "usage-model",
      name: "Usage Model",
      vision: false,
    }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(modelResponse.status, 201);
  const model = await modelResponse.json() as ModelProfile;

  const projectResponse = await fetch(`${origin}/api/projects`, {
    body: JSON.stringify({ name: "Usage Project" }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(projectResponse.status, 201);
  const project = await projectResponse.json() as Project;

  const sessionResponse = await fetch(`${origin}/api/projects/${project.id}/sessions`, {
    body: JSON.stringify({ modelId: model.id, title: "Usage Session" }),
    headers: jsonHeaders,
    method: "POST",
  });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json() as Session;

  await mkdir(resolve(dataDir, "model-usage"), { recursive: true });
  await writeFile(resolve(dataDir, "model-usage", `${session.id}.json`), `${JSON.stringify([
    {
      attemptIndex: 0,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      costUsd: null,
      finishedAt: "2026-01-01T00:00:01.000Z",
      id: "usage-1",
      inputTokens: 10,
      invocationId: "inv-1",
      invocationKind: "task",
      model: model.model,
      modelProfileId: model.id,
      modelProfileName: model.name,
      outputTokens: 5,
      projectId: project.id,
      runId: "run-1",
      sessionId: session.id,
      startedAt: "2026-01-01T00:00:00.000Z",
      totalTokens: 15,
      usageStatus: "reported",
    },
    {
      attemptIndex: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      finishedAt: "2026-01-01T00:00:02.000Z",
      id: "usage-2",
      inputTokens: null,
      invocationId: "inv-2",
      invocationKind: "semantic-review",
      model: model.model,
      modelProfileId: model.id,
      modelProfileName: model.name,
      outputTokens: null,
      projectId: project.id,
      runId: "run-1",
      sessionId: session.id,
      startedAt: "2026-01-01T00:00:01.500Z",
      totalTokens: null,
      usageStatus: "provider-not-reported",
    },
  ], null, 2)}\n`, "utf8");

  const sessionUsageResponse = await fetch(`${origin}/api/sessions/${session.id}/usage`, { headers: authorization });
  assert.equal(sessionUsageResponse.status, 200);
  const sessionUsage = await sessionUsageResponse.json() as SessionUsageSummary;
  assert.equal(sessionUsage.totals.totalTokens, 15);
  assert.equal(sessionUsage.totals.cacheReadTokens, 4);
  assert.equal(sessionUsage.totals.cacheWriteTokens, 1);
  assert.equal(sessionUsage.totals.unreportedInvocationCount, 1);
  assert.equal(sessionUsage.latestInvocation?.id, "usage-2");
  assert.equal(sessionUsage.byRun[0]?.key, "run-1");

  const globalUsageResponse = await fetch(`${origin}/api/usage/models`, { headers: authorization });
  assert.equal(globalUsageResponse.status, 200);
  const globalUsage = await globalUsageResponse.json() as GlobalModelUsageSummary;
  assert.equal(globalUsage.totals.invocationCount, 2);
  assert.equal(globalUsage.byModel[0]?.modelProfileId, model.id);
  assert.equal(globalUsage.byModel[0]?.projects[0]?.projectId, project.id);
  assert.equal(globalUsage.byModel[0]?.projects[0]?.sessions[0]?.sessionId, session.id);
  assert.equal(globalUsage.byModel[0]?.projects[0]?.sessions[0]?.runs[0]?.runId, "run-1");
});
