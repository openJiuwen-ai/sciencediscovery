// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { ModelProfile, PermissionRequest, Project, RunnerHealth, Session, SessionRun } from "@sciencediscovery/schema";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import { createApiServer, closeApiServer } from "../http/index.js";
import type { ServerConfig } from "../bootstrap/config.js";
import { offlineMcpTransport } from "../mcp/offline-transport.fixture.js";

const { test } = createTest(import.meta.url, { tags: ["category:st", "os:linux", "arch:amd64", "arch:arm64", "model:mock", "isolation:fresh"] });
const headers = { authorization: "Bearer registration-fixture", "content-type": "application/json" };
type AdapterRun = { runId: string; tools: Array<{ name: string; approval: string }>; bridge: { url: string; token: string } };
const health: RunnerHealth = {
  status: "ok", platform: "linux", runnerVersion: "fixture", sandbox: "bubblewrap", executionUser: "fixture",
  executionAuth: "bearer+hmac-sha256", executionTimeoutMs: 60_000, networkPolicy: "none", noNewPrivileges: true,
  cgroupDelegated: false, cgroupMode: "none", cgroupRoot: "", seccompBaseline: "multiarch-v1-profile-aware",
  maxFileBytes: 1_000_000, maxOutputBytes: 1_000_000, maxWorkspaceBytes: 10_000_000, workerConcurrency: null,
  npuBroker: { enabled: false, queueConcurrency: 1, workloads: [] },
  sandboxNetwork: { available: true, modes: ["none"] },
  scientificEnvs: { available: false, enabled: false, languages: [], provisioner: "fixture", startersReady: false },
};
async function listen(server: Server): Promise<string> {
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
}
async function readBody(request: IncomingMessage): Promise<AdapterRun> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AdapterRun;
}
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fixture(context: TestContext, enabled: boolean) {
  const root = await mkdtemp(resolve(tmpdir(), "mcp-registration-"));
  const captured: AdapterRun[] = [];
  let bridgeResult: { isError: boolean; text: string } | undefined;
  let adapterError: unknown;
  let invocations = 0;
  const adapter = createServer((request, response) => {
    if (request.url === "/agent/jiuwenswarm-config") {
      request.resume(); response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
    }
    if (request.url !== "/agent/runs") { request.resume(); response.writeHead(404).end(); return; }
    void (async () => {
      const body = await readBody(request); captured.push(body);
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      if (enabled) {
        const args = { sourceId: "pubmed", toolId: "search", input: {} };
        response.write(JSON.stringify({ event: { type: "tool.started", trace: { id: "recovery-probe", name: "mcp_recovered_call", args, status: "running" } } }) + "\n");
        const reply = await fetch(body.bridge.url, { method: "POST", headers: { authorization: `Bearer ${body.bridge.token}` },
          body: JSON.stringify({ name: "mcp_recovered_call", arguments: args }), signal: AbortSignal.timeout(15_000) });
        bridgeResult = await reply.json() as typeof bridgeResult;
      }
      response.end(JSON.stringify({ done: { finalText: "Registration checked." } }) + "\n");
    })().catch(error => { adapterError = error; response.destroy(); });
  });
  // Only health is used: no Runner execution, external model, or MCP server.
  const runner = createServer((request, response) => {
    request.resume(); response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health" ? health : { error: "Unexpected Runner execution" }));
  });
  const adapterUrl = await listen(adapter), runnerUrl = await listen(runner);
  const overrides = { SCIENCE_AGENT_EXECUTOR: "jiuwenswarm", SCIENCE_AGENT_ADAPTER_URL: adapterUrl,
    SCIENCE_AGENT_JIUWENSWARM_TOOLS: "ours", SCIENCE_AGENT_JIUWENSWARM_SKILLS: "ours", SCIENCE_AGENT_JIUWENSWARM_SUBAGENTS: "task" };
  const previous = new Map(Object.keys(overrides).map(name => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  const config: ServerConfig = {
    authToken: "registration-fixture", dataDir: root, host: "127.0.0.1", port: 0,
    modelCatalogPath: resolve(root, "no-model-catalog"), paperPythonPath: resolve(root, "no-python"), paperWorkerPath: resolve(root, "no-paper-worker"),
    gatewayIdleTimeoutMs: 30_000, gatewayTurnTimeoutMs: 0, kernelIdleTimeoutMs: 0, permissionWaitTimeoutMs: 0,
    runnerExecTimeoutMs: 0, runnerMaxOutputBytes: 1_000_000, runnerMaxWorkspaceBytes: 10_000_000,
    runnerToken: "runner-fixture", runnerUrl, sshConfigPath: resolve(root, "ssh-config"), staticDir: resolve(root, "no-web"),
    workspaceUpload: { maxFileBytes: 1_000_000, maxRequestBytes: 10_000_000, maxWorkspaceBytes: 10_000_000 },
    memoryGraph: { url: "", internalToken: "" }, evolve: { url: "", internalToken: "" },
  };
  const server = createApiServer(config, { mcpTransport: { ...offlineMcpTransport,
    invoke: async () => { invocations++; throw new Error("Registration does not authorize an MCP invocation"); } } });
  context.after(async () => {
    try { await closeApiServer(server); }
    finally {
      await close(adapter); await close(runner);
      for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      await rm(root, { recursive: true, force: true });
    }
  });
  const origin = await listen(server);
  async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }
  const model = await api<ModelProfile>("/api/models", { name: "Unused loopback model", model: "fixture", apiToken: "synthetic-fixture",
    baseUrl: `${adapterUrl}/unused-model`, apiProtocol: "openai-chat-completions", apiVariant: "openai", proxyPolicy: "none" });
  const project = await api<Project>("/api/projects", { name: "MCP registration fixture" });
  const session = await api<Session>(`/api/projects/${project.id}/sessions`, { title: "Registration subject", modelId: model.id,
    approvalMode: "ask_for_dangerous", settingsOverrides: { enabledConnectorIds: [], plugins: { mcp: { enabled } } } });
  return { origin, api, session, captured, result: () => bridgeResult, error: () => adapterError, invocations: () => invocations };
}

for (const enabled of [false, true]) {
  test(`API run registration ${enabled ? "exposes" : "omits"} configuration recovery for frozen MCP ${enabled ? "on" : "off"}`, { timeout: 30_000 }, async context => {
    const f = await fixture(context, enabled);
    const response = await fetch(`${f.origin}/api/sessions/${f.session.id}/messages`, { method: "POST", headers,
      body: JSON.stringify({ content: "Inspect the registration fixture without running any host command." }), signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200);
    const stream = response.text();
    // Keep an early registration assertion failure from leaving an unhandled
    // stream rejection during teardown; the awaited stream still rejects.
    void stream.catch(() => {});
    // Exercise runs/index.ts and its actual tool registry, not a copied gate or
    // a factory mock. With no selected sources, no unhealthy-source fallback
    // can create readiness: these tools come only from configuration activation.
    const registered = await until(async () => f.captured[0], "the API's adapter registration");
    const names = registered.tools.map(tool => tool.name);
    assert.ok(names.includes("configuration"));
    for (const name of ["mcp_readiness", "mcp_recovered_call"]) assert.equal(names.includes(name), enabled, name);
    assert.ok(!names.some(name => name.startsWith("mcp__")), "No source was selected before configuration");
    const runs = await f.api<SessionRun[]>(`/api/sessions/${f.session.id}/runs`);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.settingsSnapshot.plugins?.mcp?.enabled, enabled);
    assert.deepEqual(runs[0]!.settingsSnapshot.enabledConnectorIds, []);
    if (enabled) {
      const permission = await until(async () => (await f.api<PermissionRequest[]>(`/api/permission-requests?sessionId=${f.session.id}`))
        .find(item => item.state === "pending"), "a concrete recovered-tool approval");
      assert.equal(permission.resource, "mcp__pubmed__search");
      assert.equal(permission.executionId, runs[0]!.id);
      assert.equal(f.invocations(), 0, "Enabling recovery must not grant execution permission");
      await f.api(`/api/permission-requests/${permission.id}/decision`, { decision: "deny" });
    }
    await stream;
    assert.equal(f.error(), undefined);
    if (enabled) { assert.equal(f.result()?.isError, true); assert.match(f.result()!.text, /MCP recovery approval denied/); }
    assert.equal(f.invocations(), 0);
    assert.deepEqual(await f.api("/api/permission-grants"), []);
    const finished = await until(async () => (await f.api<SessionRun[]>(`/api/sessions/${f.session.id}/runs`)).find(run => run.status === "completed"), "the original completed run");
    assert.equal(finished.id, runs[0]!.id);
  });
}
