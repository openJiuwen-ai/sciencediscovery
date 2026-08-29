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

/**
 * A PDB structure download makes two independent outbound hops, and both must
 * obey the effective proxy policy of the MCP server that owns the source
 * (`biomed`):
 *
 *  1. the metadata / candidate hop, made by the stdio MCP subprocess against
 *     `data.rcsb.org` under the proxy environment Node injects into it;
 *  2. the structure-file byte hop, made by `GovernedDownloadManager` against
 *     `files.rcsb.org` under an undici dispatcher.
 *
 * Both hops are asserted here against a real loopback forward proxy, so the
 * evidence is observed proxy traffic rather than the shape of a helper's
 * return value. `biomed = none` is asserted on both hops as well, because a
 * proxy that is applied unconditionally is just as wrong as one that is
 * skipped.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { McpInvocation, McpToolResult } from "@sciencediscovery/schema";
import { createBuiltinMcpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { GovernedDownloadManager } from "@sciencediscovery/artifact-manager";
import { McpGovernanceBroker, McpSourceCatalog } from "@sciencediscovery/data-source";
import type { McpTransportClient } from "@sciencediscovery/data-source";

import { loadExtensionsConfig } from "./extensions-config.js";
import { McpNodeClient } from "./node-client.js";
import { SessionStore } from "../store.js";

const SDK_ROOT = pathToFileURL(resolve(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/esm")).href;

/**
 * A real stdio MCP server standing in for the bundled Python `biomed` server.
 *
 * It reproduces the one behaviour this hop depends on: an HTTP client that
 * honours the proxy environment variables of its own process, which is what
 * `httpx.AsyncClient(trust_env=True)` does in `public_biomed_mcp.py`. The
 * assertion is therefore about the environment the Node control plane injected
 * into the subprocess, not about the stub's own routing code. The Python side
 * of the same contract is pinned in
 * `services/gateway/tests/test_public_biomed_mcp.py`.
 */
const BIOMED_FIXTURE_SOURCE = `
import { request as httpRequest } from "node:http";

import { Server } from "${SDK_ROOT}/server/index.js";
import { StdioServerTransport } from "${SDK_ROOT}/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "${SDK_ROOT}/types.js";

function entryLookup(pdbId) {
  const target = new URL("http://data.rcsb.org/rest/v1/core/entry/" + pdbId);
  const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return Promise.resolve("direct");
  const via = new URL(proxy);
  return new Promise((settle, fail) => {
    const client = httpRequest({
      headers: { host: target.host },
      host: via.hostname,
      method: "GET",
      // Absolute-form request target: this is the forward-proxy hop.
      path: target.href,
      port: via.port,
    }, (response) => {
      response.resume();
      response.on("end", () => settle("proxy " + via.origin));
    });
    client.on("error", fail);
    client.end();
  });
}

const server = new Server({ name: "biomed", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "pdb_prepare_structure_download",
    description: "Prepare an mmCIF or PDB structure-file download candidate.",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string" }, pdb_id: { type: "string" } },
      required: ["pdb_id"],
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const pdbId = String(request.params.arguments?.pdb_id ?? "").toUpperCase();
  const format = String(request.params.arguments?.format ?? "cif");
  const egress = await entryLookup(pdbId);
  const payload = {
    artifacts: [{
      attribution: "Structure file provided by RCSB PDB.",
      format,
      id: "pdb:" + pdbId + ":" + format,
      kind: "structure",
      license: "RCSB PDB data usage policy",
      logicalName: pdbId + "." + format,
      mimeType: "chemical/x-mmcif",
      sourceId: "pdb",
      sourceRecordId: pdbId,
      sourceUrl: "https://files.rcsb.org/download/" + pdbId + "." + format,
    }],
    attribution: "PDB",
    license: "Provider terms apply",
    records: [],
    retrievedAt: new Date().toISOString(),
    sourceId: "pdb",
    toolId: "prepare_structure_download",
    untrusted: true,
    // How this subprocess actually reached data.rcsb.org.
    warnings: [egress],
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
});
await server.connect(new StdioServerTransport());
`;

interface RecordingProxy {
  close(): Promise<void>;
  port: number;
  requests: string[];
}

/** A loopback forward proxy that answers absolute-form requests itself, so no
 *  test ever depends on RCSB being reachable or on DNS resolving its hosts. */
async function startRecordingProxy(body: Buffer): Promise<RecordingProxy> {
  const requests: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-length": String(body.length), "content-type": "application/octet-stream" });
    response.end(body);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Proxy did not bind a port");
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    },
    port: address.port,
    requests,
  };
}

async function preparedStore(dataDir: string) {
  const store = new SessionStore(dataDir);
  await store.load();
  const model = await store.createModel({
    apiToken: "token",
    baseUrl: "https://models.example.test/v1",
    model: "model",
    name: "Model",
    vision: false,
  });
  const project = await store.createProject("PDB proxy");
  const session = await store.createSession(project.id, "Download", model.id);
  return { project, session, store };
}

test("the PDB metadata hop reaches data.rcsb.org through the biomed proxy policy", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `pdb-proxy-metadata-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const proxy = await startRecordingProxy(Buffer.from("{}"));
  context.after(() => proxy.close());

  const fixturePath = join(dataDir, "biomed-fixture.mjs");
  await writeFile(fixturePath, BIOMED_FIXTURE_SOURCE);
  const configPath = join(dataDir, "extensions_config.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      biomed: { args: [fixturePath], command: process.execPath, enabled: true, type: "stdio" },
    },
  }));

  const { project, session, store } = await preparedStore(dataDir);
  const proxyServer = await store.createProxyServer({
    kind: "custom_url",
    name: "Lab proxy",
    url: `http://127.0.0.1:${proxy.port}`,
  });
  await store.updateMcpProxyPolicies({ policies: { biomed: `proxy:${proxyServer.id}` } });

  const registry = createBuiltinMcpSourceRegistry();
  const gateway = new McpNodeClient(() => loadExtensionsConfig(configPath));
  context.after(() => gateway.close());
  const broker = new McpGovernanceBroker(dataDir, store, registry, new McpSourceCatalog(registry, gateway), gateway);

  const invoke = (pdbId: string) => broker.invoke({
    allowedSourceIds: ["pdb"],
    input: { format: "cif", pdb_id: pdbId },
    projectId: project.id,
    sessionId: session.id,
    sourceId: "pdb",
    toolCallId: `call-${pdbId}`,
    toolId: "prepare_structure_download",
    turnId: `turn-${pdbId}`,
  });

  const proxied = await invoke("1CRN");
  assert.deepEqual(proxy.requests, ["GET http://data.rcsb.org/rest/v1/core/entry/1CRN"]);
  assert.deepEqual(proxied.result.warnings, [`proxy http://127.0.0.1:${proxy.port}`]);
  assert.equal(proxied.invocation.mcpServerId, "biomed");
  assert.equal(proxied.result.artifacts?.[0]?.sourceUrl, "https://files.rcsb.org/download/1CRN.cif");

  // Switching the same server off must reach the subprocess: an explicit
  // "none" is a user instruction to stop proxying, not a cache miss.
  await store.updateMcpProxyPolicies({ policies: { biomed: "none" } });
  const direct = await invoke("2CRN");
  assert.deepEqual(direct.result.warnings, ["direct"]);
  assert.equal(proxy.requests.length, 1);
});

test("the PDB byte hop downloads files.rcsb.org through the biomed proxy policy", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `pdb-proxy-bytes-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const bytes = Buffer.from("data_1CRN\n# served through the configured proxy\n");
  const proxy = await startRecordingProxy(bytes);
  context.after(() => proxy.close());

  const { project, session, store } = await preparedStore(dataDir);
  const proxyServer = await store.createProxyServer({
    kind: "custom_url",
    name: "Lab proxy",
    url: `http://127.0.0.1:${proxy.port}`,
  });
  await store.updateMcpProxyPolicies({ policies: { biomed: `proxy:${proxyServer.id}` } });

  const registry = createBuiltinMcpSourceRegistry();
  const failingTransport = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, failingTransport),
    failingTransport,
  );
  // The candidate is plain HTTP so the loopback proxy can answer the forwarded
  // request itself; the dispatcher plumbing under test is identical for HTTPS.
  const invocation = await recordPreparedCandidate(broker, store, {
    bytes,
    projectId: project.id,
    sessionId: session.id,
    sourceUrl: "http://files.rcsb.org/download/1CRN.cif",
  });

  // No fetch stub: the real default client must accept the proxy dispatcher.
  const manager = new GovernedDownloadManager(store, registry, broker);
  const creation = await manager.prepare(session.id, {
    candidateId: "pdb:1CRN:cif",
    destination: { path: "structures/1CRN.cif", type: "workspace" },
    mcpInvocationId: invocation.id,
  });
  assert.ok(creation.permissionRequest);
  const terminalPromise = manager.waitForPlanTerminal(session.id, creation.plan.id);
  await store.decidePermissionRequest(creation.permissionRequest.id, "allow_once");
  await manager.approveByPermissionRequest(creation.permissionRequest.id);
  const terminal = await terminalPromise;

  assert.equal(terminal.job?.error?.message, undefined);
  assert.equal(terminal.status, "completed");
  assert.deepEqual(proxy.requests, ["GET http://files.rcsb.org/download/1CRN.cif"]);
  assert.equal(
    await readFile(resolve(store.workspacePath(session.id), "structures/1CRN.cif"), "utf8"),
    bytes.toString("utf8"),
  );
});

test("the PDB byte hop stays direct when biomed proxying is switched off", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `pdb-proxy-bytes-direct-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const bytes = Buffer.from("data_1CRN\n# direct\n");
  const proxy = await startRecordingProxy(bytes);
  context.after(() => proxy.close());

  const { project, session, store } = await preparedStore(dataDir);
  const proxyServer = await store.createProxyServer({
    kind: "custom_url",
    name: "Lab proxy",
    url: `http://127.0.0.1:${proxy.port}`,
  });
  // A proxy that every other module inherits must still not reach PDB once
  // biomed is explicitly set to "none".
  await store.updateProxySettings({ defaultPolicy: `proxy:${proxyServer.id}` });
  await store.updateMcpProxyPolicies({ policies: { biomed: "none" } });

  const registry = createBuiltinMcpSourceRegistry();
  const failingTransport = unusedTransport();
  const broker = new McpGovernanceBroker(
    dataDir,
    store,
    registry,
    new McpSourceCatalog(registry, failingTransport),
    failingTransport,
  );
  const invocation = await recordPreparedCandidate(broker, store, {
    bytes,
    projectId: project.id,
    sessionId: session.id,
    sourceUrl: "http://files.rcsb.org/download/1CRN.cif",
  });

  const dispatchers: unknown[] = [];
  const manager = new GovernedDownloadManager(store, registry, broker, async (_url, init) => {
    dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) }, status: 200 });
  });
  const creation = await manager.prepare(session.id, {
    candidateId: "pdb:1CRN:cif",
    destination: { path: "structures/1CRN.cif", type: "workspace" },
    mcpInvocationId: invocation.id,
  });
  assert.ok(creation.permissionRequest);
  const terminalPromise = manager.waitForPlanTerminal(session.id, creation.plan.id);
  await store.decidePermissionRequest(creation.permissionRequest.id, "allow_once");
  await manager.approveByPermissionRequest(creation.permissionRequest.id);
  const terminal = await terminalPromise;

  assert.equal(terminal.status, "completed");
  assert.deepEqual(dispatchers, [undefined]);
  assert.deepEqual(proxy.requests, []);
});

/** These flows never reach MCP; any call is a test-setup mistake. */
function unusedTransport(): McpTransportClient {
  const boom = (): never => { throw new Error("MCP transport must not be used in this flow"); };
  return { catalog: boom, invoke: boom, reload: boom };
}

/** Persist the artifact-plan invocation a PDB download starts from. */
async function recordPreparedCandidate(
  broker: McpGovernanceBroker,
  store: SessionStore,
  options: { bytes: Buffer; projectId: string; sessionId: string; sourceUrl: string },
): Promise<McpInvocation> {
  const result: McpToolResult = {
    artifacts: [{
      attribution: "Structure file provided by RCSB PDB.",
      checksum: { algorithm: "sha256", value: createHash("sha256").update(options.bytes).digest("hex") },
      expectedBytes: options.bytes.length,
      format: "cif",
      id: "pdb:1CRN:cif",
      kind: "structure",
      license: "RCSB PDB data usage policy",
      logicalName: "1CRN.cif",
      mimeType: "chemical/x-mmcif",
      sourceId: "pdb",
      sourceRecordId: "1CRN",
      sourceUrl: options.sourceUrl,
    }],
    attribution: "PDB",
    license: "RCSB PDB data usage policy",
    records: [],
    retrievedAt: new Date().toISOString(),
    sourceId: "pdb",
    toolId: "prepare_structure_download",
    untrusted: true,
    warnings: [],
  };
  const timestamp = new Date().toISOString();
  const invocation: McpInvocation = {
    adapterVersion: "1.0.0",
    attempts: [],
    attribution: "PDB",
    cache: { hit: false, key: "pdb-prepare", scope: "global-public" },
    finishedAt: timestamp,
    id: "mcp-invocation-pdb",
    license: "RCSB PDB data usage policy",
    mcpServerId: "biomed",
    normalizedResult: await broker.cas.put(JSON.stringify(result)),
    projectId: options.projectId,
    request: await broker.cas.put("{}"),
    resultCount: 0,
    sessionId: options.sessionId,
    sourceId: "pdb",
    startedAt: timestamp,
    status: "succeeded",
    toolCallId: "call-1",
    toolId: "prepare_structure_download",
    transport: "mcp",
    turnId: "turn-1",
  };
  await store.appendMcpInvocation(invocation);
  return invocation;
}
