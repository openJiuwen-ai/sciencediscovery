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
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";

import type {
  GlobalModelUsageSummary,
  ModelUsageAnalyticsSummary,
  RunnerHealth,
  SessionUsageSummary,
} from "@sciencediscovery/schema";

import { createApiServer, type ServerConfig } from "./server.js";

const authorization = { authorization: "Bearer test-token" };

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
  platform: "linux",
  runnerVersion: "test",
  sandbox: "bubblewrap",
  sandboxNetwork: { available: true, modes: ["none", "domain-allowlist"] },
  scientificEnvs: { available: false, enabled: false, languages: [], provisioner: "test", startersReady: false },
  seccompBaseline: "multiarch-v1-profile-aware",
  status: "ok",
  workerConcurrency: null,
};

function testConfig(dataDir: string, runnerUrl: string): ServerConfig {
  return {
    authToken: "test-token",
    dataDir,
    gatewayIdleTimeoutMs: 120_000,
    gatewayTurnTimeoutMs: 300_000,
    host: "127.0.0.1",
    kernelIdleTimeoutMs: 300_000,
    // No packaging snapshot in tests: the catalog stays empty unless a test installs one.
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
    evolve: { url: "http://127.0.0.1:4313", internalToken: "test" },
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

async function assertResponseStatus(response: Response, status: number): Promise<void> {
  if (response.status === status) return;
  assert.fail(`Expected ${status}, got ${response.status}: ${await response.text()}`);
}

test("USG-013 session and global usage APIs expose breakdown fields", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `usage-api-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  const now = "2026-01-01T00:00:00.000Z";
  const project = { createdAt: now, id: "project-usage", name: "Usage Project", updatedAt: now };
  const session = {
    approvalMode: "always_allow" as const,
    createdAt: now,
    id: "session-usage",
    projectId: project.id,
    title: "Usage Session",
    updatedAt: now,
  };
  await writeFile(resolve(dataDir, "catalog.json"), `${JSON.stringify({
    projects: [project],
    sessions: [session],
  }, null, 2)}\n`, "utf8");

  const deps = await startStubDeps(context);
  const api = createApiServer(testConfig(dataDir, deps.runnerOrigin));
  await new Promise<void>((resolveListen) => api.listen(0, "127.0.0.1", resolveListen));
  context.after(() => new Promise<void>((done) => {
    api.close(() => done());
    api.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

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
      model: "usage-model",
      modelProfileId: "usage-model-profile",
      modelProfileName: "Usage Model",
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
      model: "usage-model",
      modelProfileId: "usage-model-profile",
      modelProfileName: "Usage Model",
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
  await assertResponseStatus(sessionUsageResponse, 200);
  const sessionUsage = await sessionUsageResponse.json() as SessionUsageSummary;
  assert.equal(sessionUsage.totals.totalTokens, 15);
  assert.equal(sessionUsage.totals.cacheReadTokens, 4);
  assert.equal(sessionUsage.totals.cacheWriteTokens, 1);
  assert.equal(sessionUsage.totals.unreportedInvocationCount, 1);
  assert.equal(sessionUsage.latestInvocation?.id, "usage-2");
  assert.equal(sessionUsage.byRun[0]?.key, "run-1");

  const globalUsageResponse = await fetch(`${origin}/api/usage/models`, { headers: authorization });
  await assertResponseStatus(globalUsageResponse, 200);
  const globalUsage = await globalUsageResponse.json() as GlobalModelUsageSummary;
  assert.equal(globalUsage.totals.invocationCount, 2);
  assert.equal(globalUsage.byModel[0]?.modelProfileId, "usage-model-profile");
  assert.equal(globalUsage.byModel[0]?.projects[0]?.projectId, project.id);
  assert.equal(globalUsage.byModel[0]?.projects[0]?.sessions[0]?.sessionId, session.id);
  assert.equal(globalUsage.byModel[0]?.projects[0]?.sessions[0]?.runs[0]?.runId, "run-1");

  const analyticsResponse = await fetch(`${origin}/api/usage/analytics?from=2026-01-01&to=2026-01-01`, { headers: authorization });
  await assertResponseStatus(analyticsResponse, 200);
  const analytics = await analyticsResponse.json() as ModelUsageAnalyticsSummary;
  assert.equal(analytics.overview.totalTokens, 15);
  assert.equal(analytics.dailyByModel.length, 1);
  assert.equal(analytics.dailyByModel[0]?.date, "2026-01-01");
  assert.equal(analytics.dailyByModel[0]?.cacheReadTokens, 4);
  assert.equal(analytics.dailyByModel[0]?.estimatedCost, undefined);

  const csvResponse = await fetch(`${origin}/api/usage/analytics/export?format=csv&from=2026-01-01&to=2026-01-01`, { headers: authorization });
  await assertResponseStatus(csvResponse, 200);
  assert.match(csvResponse.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await csvResponse.text();
  assert.match(csv, /"2026-01-01","Usage Model"/);
  assert.match(csv, /"15","","","","","","",""$/m);

  const jsonResponse = await fetch(`${origin}/api/usage/analytics/export?format=json&from=2026-01-01&to=2026-01-01`, { headers: authorization });
  await assertResponseStatus(jsonResponse, 200);
  const exported = await jsonResponse.json() as ModelUsageAnalyticsSummary;
  assert.equal(exported.overview.totalTokens, 15);
});
