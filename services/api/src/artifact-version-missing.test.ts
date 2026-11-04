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
  const root = resolve(process.cwd(), ".tmp", `artifact-version-missing-${Date.now()}-${process.pid}`);
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
  const created = await fetch(`${origin}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Artifact version miss" }) });
  assert.equal(created.status, 201);
  const project = await created.json() as { firstSession: { id: string } };
  return { origin, sessionId: project.firstSession.id };
}

test("a sibling artifact-version route answers a missing version like content does", async (context) => {
  const { origin, sessionId } = await listen(context);
  const headers = { authorization: "Bearer test-token" };
  const versionId = randomUUID();
  // content already answers 404 for a version that does not exist; provenance and diff are
  // its siblings under the same path prefix, so a client cannot be told 500 for one of them:
  // that reads as "the server is broken", is logged as unclassified_request_error, and hides
  // the plain fact that the version id is stale.
  const seen: Record<string, { error?: string; status: number }> = {};
  for (const route of ["content", "provenance", "diff"] as const) {
    const response = await fetch(`${origin}/api/sessions/${sessionId}/artifact-versions/${versionId}/${route}`, { headers });
    const body = await response.json().catch(() => ({})) as { error?: string };
    seen[route] = { status: response.status, ...(body.error ? { error: body.error } : {}) };
  }
  assert.deepEqual(seen, {
    content: { status: 404, error: "Artifact version not found" },
    provenance: { status: 404, error: "Artifact version not found" },
    diff: { status: 404, error: "Artifact version not found" },
  });
});
