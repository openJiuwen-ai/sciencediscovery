// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { TestContext } from "node:test";

import { createApiServer } from "./http/index.js";
import { offlineMcpTransport } from "./mcp/offline-transport.fixture.js";
import type { ServerConfig } from "./bootstrap/config.js";

async function listen(context: TestContext) {
  const root = resolve(process.cwd(), ".tmp", `activity-miss-${Date.now()}-${process.pid}`);
  await mkdir(root, { recursive: true });
  const config: ServerConfig = {
    authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: "http://127.0.0.1:1", sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  const server = createApiServer(config, { mcpTransport: offlineMcpTransport });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await rm(root, { force: true, recursive: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  const created = await fetch(`${origin}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Activity miss" }) });
  assert.equal(created.status, 201);
  const project = await created.json() as { firstSession: { id: string } };
  return { origin, sessionId: project.firstSession.id };
}

test("activity 404s name the session or the record that was missing", async (context) => {
  const { origin, sessionId } = await listen(context);
  const headers = { authorization: "Bearer test-token" };
  const missingSession = randomUUID();
  const missingActivity = await fetch(`${origin}/api/sessions/${missingSession}/agent-activity`, { headers });
  assert.equal(missingActivity.status, 404);
  assert.equal((await missingActivity.json() as { error: string }).error, `Session not found: ${missingSession}`);

  const open = await fetch(`${origin}/api/sessions/${sessionId}/agent-activity`, { headers });
  assert.equal(open.status, 200);

  const executionId = randomUUID();
  const missingExecution = await fetch(`${origin}/api/sessions/${sessionId}/agent-activity/executions/${executionId}/logs`, { headers });
  assert.equal(missingExecution.status, 404);
  assert.equal((await missingExecution.json() as { error: string }).error, `Execution not found: ${executionId}`);

  const transferId = "transfer/1";
  const missingTransfer = await fetch(`${origin}/api/sessions/${sessionId}/agent-activity/transfers/${encodeURIComponent(transferId)}/cancel`, { method: "POST", headers });
  assert.equal(missingTransfer.status, 404);
  assert.equal((await missingTransfer.json() as { error: string }).error, `Transfer not found: ${transferId}`);

  const childId = randomUUID();
  const missingChild = await fetch(`${origin}/api/sessions/${sessionId}/subagents/${childId}/resume`, { method: "POST", headers });
  assert.equal(missingChild.status, 404);
  assert.equal((await missingChild.json() as { error: string }).error, `Subagent not found: ${childId}`);

  const missingStop = await fetch(`${origin}/api/sessions/${missingSession}/subagents/${childId}/stop`, { method: "POST", headers });
  assert.equal(missingStop.status, 404);
  assert.equal((await missingStop.json() as { error: string }).error, `Session not found: ${missingSession}`);
});
