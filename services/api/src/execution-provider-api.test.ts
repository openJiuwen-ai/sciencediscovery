// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import type { TestContext } from "node:test";
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { RunnerExecutionCapability } from "@sciencediscovery/schema";

import { createApiServer } from "./http/index.js";
import type { ServerConfig } from "./bootstrap/config.js";

interface Harness {
  origin: string;
  request: <T>(path: string, body?: unknown, method?: string) => Promise<{ status: number; body: T }>;
  capabilityCalls: () => number;
}

/** 起一个真 API server + 剧本 runner 桩（/execution-capability + /health）。 */
async function startHarness(context: TestContext, runnerSandbox: "none" | "bubblewrap"): Promise<Harness> {
  const root = resolve(process.cwd(), ".tmp", `execution-provider-api-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });

  let capabilityCalls = 0;
  const runnerStub: Server = createServer((request, response) => {
    if (request.url?.startsWith("/kernels/teardown") && request.method === "POST") {
      // PATCH approvalMode 在 scientificEnvs 可用时会拆除内核（epoch 语义）。
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ count: 0, reason: "stub" }));
      return;
    }
    if (request.url === "/execution-capability") {
      capabilityCalls += 1;
      const capability: RunnerExecutionCapability = {
        checkedAt: new Date().toISOString(), dependencyAvailable: true, instanceId: "stub-runner",
        ready: true, reason: "ready", sandbox: runnerSandbox,
        sandboxUsable: runnerSandbox !== "none",
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(capability));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        cgroupDelegated: false, cgroupMode: "none", cgroupRoot: "", executionAuth: "bearer+hmac-sha256",
        executionTimeoutMs: 0, executionUser: "u", maxFileBytes: 0, maxOutputBytes: 0,
        platform: "win32",
        scientificEnvs: { available: true, enabled: true, languages: ["python"], provisioner: "micromamba", startersReady: true },
        service: "runner", version: "stub",
      }));
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise<void>((done) => runnerStub.listen(0, "127.0.0.1", done));
  const runnerPort = (runnerStub.address() as AddressInfo).port;

  const config: ServerConfig = {
    authToken: "test-token", dataDir: root, host: "127.0.0.1", port: 0,
    gatewayIdleTimeoutMs: 240_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0,
    modelCatalogPath: resolve(root, "absent.json"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-worker"),
    permissionWaitTimeoutMs: 0, runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_737_418_240,
    runnerToken: "runner-test-token", runnerUrl: `http://127.0.0.1:${runnerPort}`, sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_737_418_240 },
    memoryGraph: { url: "http://127.0.0.1:1", internalToken: "test" },
    evolve: { url: "http://127.0.0.1:1", internalToken: "test" },
  };
  const catalog = { loadedAt: new Date().toISOString(), revision: "f5-api-test", servers: [] };
  const server = createApiServer(config, {
    mcpTransport: {
      catalog: async () => catalog, reload: async () => catalog, invoke: async () => { throw new Error("No MCP in this test"); },
    },
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  context.after(async () => {
    await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
    await new Promise<void>((done) => { runnerStub.close(() => done()); runnerStub.closeAllConnections(); });
    await rm(root, { force: true, recursive: true });
  });

  return {
    capabilityCalls: () => capabilityCalls,
    origin,
    request: async <T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; body: T }> => {
      const response = await fetch(origin + path, {
        method,
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() as T };
    },
  };
}

test("GET /api/execution-provider 返回能力视图与 B/C 留桩", async (context) => {
  const harness = await startHarness(context, "none");
  const { status, body } = await harness.request<{
    capability: { provider: string; sandboxed: boolean; scientificEnvs: { available: boolean; provisioner: string | null } };
    providers: Array<{ id: string; available: boolean; unavailableReason?: string }>;
  }>("/api/execution-provider");
  assert.equal(status, 200);
  assert.equal(body.capability.provider, "windows-direct");
  assert.equal(body.capability.sandboxed, false);
  assert.equal(body.capability.scientificEnvs.available, true);
  assert.equal(body.capability.scientificEnvs.provisioner, "micromamba");
  assert.equal(body.providers.length, 3);
  const wsl = body.providers.find((entry) => entry.id === "wsl")!;
  const remote = body.providers.find((entry) => entry.id === "remote")!;
  assert.equal(wsl.available, false);
  assert.match(wsl.unavailableReason ?? "", /本地沙箱引擎插件未安装/);
  assert.equal(remote.available, false);
  assert.match(remote.unavailableReason ?? "", /远程执行未配置/);
});

test("POST refresh 重新探测 runner（F5.5 热切换通路）", async (context) => {
  const harness = await startHarness(context, "none");
  const before = harness.capabilityCalls();
  const { status } = await harness.request("/api/execution-provider", { refresh: true });
  assert.equal(status, 200);
  assert.equal(harness.capabilityCalls(), before + 1);
});

test("创建会话 always_allow → 201 即使无沙箱也放行", async (context) => {
  const harness = await startHarness(context, "none");
  const project = await harness.request<{ id: string }>("/api/projects", { name: "f5-enforcement" });
  assert.equal(project.status, 201);
  const created = await harness.request<{ id: string; approvalMode: string }>(`/api/projects/${project.body.id}/sessions`, { title: "allowed", approvalMode: "always_allow" });
  assert.equal(created.status, 201);
  assert.equal(created.body.approvalMode, "always_allow");
});

test("运行期切换 always_allow → 200 即使无沙箱也放行", async (context) => {
  const harness = await startHarness(context, "none");
  const project = await harness.request<{ id: string }>("/api/projects", { name: "f5-patch-guard" });
  const session = await harness.request<{ id: string }>(`/api/projects/${project.body.id}/sessions`, { title: "patch" });
  assert.equal(session.status, 201);
  const updated = await harness.request<{ approvalMode: string }>(`/api/sessions/${session.body.id}`, { approvalMode: "always_allow" }, "PATCH");
  assert.equal(updated.status, 200);
  assert.equal(updated.body.approvalMode, "always_allow");
});

test("bwrap usable → 创建与切换 always_allow 均放行（谓词真分支）", async (context) => {
  const harness = await startHarness(context, "bubblewrap");
  const capability = await harness.request<{ capability: { sandboxed: boolean } }>("/api/execution-provider");
  assert.equal(capability.body.capability.sandboxed, true);
  const project = await harness.request<{ id: string }>("/api/projects", { name: "f5-sandboxed" });
  const created = await harness.request<{ approvalMode: string }>(`/api/projects/${project.body.id}/sessions`, { title: "auto", approvalMode: "always_allow" });
  assert.equal(created.status, 201);
  assert.equal(created.body.approvalMode, "always_allow");
  const session = await harness.request<{ id: string }>(`/api/projects/${project.body.id}/sessions`, { title: "patch" });
  const patched = await harness.request<{ approvalMode: string }>(`/api/sessions/${session.body.id}`, { approvalMode: "always_allow" }, "PATCH");
  assert.equal(patched.status, 200);
  assert.equal(patched.body.approvalMode, "always_allow");
});
