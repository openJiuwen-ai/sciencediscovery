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
 * The outbound contract every MCP data source has to satisfy, checked over the
 * whole registry instead of one connector at a time.
 *
 * A source that reaches the network owes three things:
 *
 *  - it declares the MCP server it belongs to, and that server is one the user
 *    can actually configure in `extensions_config.json`;
 *  - its upstream calls carry the proxy resolved from *that* server's policy,
 *    not a hardcoded id and not the global default;
 *  - its artifact bytes are fetched under a dispatcher resolved the same way.
 *
 * These tests enumerate the registry, so a newly registered source is covered
 * the moment it exists. The static check at the end closes the remaining hole:
 * code that pins a dispatcher but fetches with Node's global `fetch`, which
 * rejects workspace dispatchers and turns every proxied request into
 * `TypeError: fetch failed`.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import type {
  JsonValue,
  McpCatalog,
  McpInvocation,
  McpInvokeRequest,
  McpInvokeResponse,
  McpSourceAdapter,
  McpSourceManifest,
  McpToolResult,
} from "@sciencediscovery/schema";
import { createBuiltinMcpSourceRegistry, McpSourceRegistry } from "@sciencediscovery/mcp-sources";
import { GovernedDownloadManager } from "@sciencediscovery/artifact-manager";
import {
  McpGovernanceBroker,
  McpSourceCatalog,
  proxyDispatcher,
  proxyFetch,
  type McpTransportClient,
} from "@sciencediscovery/data-source";

import { loadExtensionsConfig } from "./extensions-config.js";
import { SessionStore } from "../store.js";

/** Tests run from the package directory, so the repository root is two up. */
const REPOSITORY_ROOT = resolve(process.cwd(), "..", "..");

function catalogFor(registry: McpSourceRegistry): McpCatalog {
  const servers = new Map<string, McpCatalog["servers"][number]>();
  for (const manifest of registry.listManifests()) {
    const serverId = manifest.transport.mcpServerId;
    const server = servers.get(serverId)
      ?? { enabled: true, id: serverId, tools: [], transport: "stdio" as const };
    for (const tool of Object.values(manifest.tools)) {
      server.tools.push({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.mcpToolName ?? tool.id,
        schemaHash: "test",
      });
    }
    servers.set(serverId, server);
  }
  return { loadedAt: new Date().toISOString(), revision: "test", servers: [...servers.values()] };
}

/** Records the proxy each invocation carried and answers with a valid envelope. */
function recordingTransport(registry: McpSourceRegistry, seen: McpInvokeRequest[]): McpTransportClient {
  const respond = async (request: McpInvokeRequest): Promise<McpInvokeResponse> => {
    seen.push(request);
    const source = registry.list().find((candidate) =>
      candidate.manifest.transport.mcpServerId === request.serverId
      && Object.values(candidate.manifest.tools).some((tool) => tool.mcpToolName === request.toolName));
    const tool = source && Object.values(source.manifest.tools)
      .find((candidate) => candidate.mcpToolName === request.toolName);
    if (!source || !tool) throw new Error(`Unexpected MCP invocation: ${request.serverId}/${request.toolName}`);
    const payload = {
      attribution: source.manifest.governance.attribution,
      license: source.manifest.governance.license,
      records: [],
      retrievedAt: new Date().toISOString(),
      sourceId: source.manifest.id,
      toolId: tool.id,
      untrusted: true,
      warnings: [],
    };
    return {
      attempts: [],
      content: [{ text: JSON.stringify(payload), type: "text" }],
      durationMs: 1,
      isError: false,
      requestId: request.requestId,
      serverId: request.serverId,
      toolName: request.toolName,
    };
  };
  return {
    catalog: async () => catalogFor(registry),
    invoke: respond,
    reload: async () => catalogFor(registry),
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
  const project = await store.createProject("Egress contract");
  const session = await store.createSession(project.id, "Contract", model.id);
  return { project, session, store };
}

/** One distinct proxy per MCP server, so borrowing another server's policy is
 *  a visible difference rather than an accidental match. */
async function proxyPerServer(store: SessionStore, serverIds: string[]): Promise<Map<string, string>> {
  const policies: Record<string, `proxy:${string}`> = {};
  const urls = new Map<string, string>();
  for (const [index, serverId] of serverIds.entries()) {
    const url = `http://127.0.0.1:${9_000 + index}`;
    const server = await store.createProxyServer({ kind: "custom_url", name: `Proxy ${serverId}`, url });
    policies[serverId] = `proxy:${server.id}`;
    urls.set(serverId, url);
  }
  await store.updateMcpProxyPolicies({ policies });
  return urls;
}

test("every registered MCP source declares a configurable MCP server", () => {
  const configPath = join(REPOSITORY_ROOT, "extensions_config.json");
  assert.ok(existsSync(configPath), `extensions_config.json not found at ${configPath}`);
  const configured = new Set(Object.keys(loadExtensionsConfig(configPath).servers));
  assert.ok(configured.size > 0, "extensions_config.json declares no MCP servers");

  const registry = createBuiltinMcpSourceRegistry();
  const offenders: string[] = [];
  for (const manifest of registry.listManifests()) {
    const serverId = manifest.transport.mcpServerId;
    if (!serverId?.trim()) {
      offenders.push(`${manifest.id}: transport.mcpServerId is empty`);
      continue;
    }
    if (!configured.has(serverId)) {
      // Proxy policies are keyed by MCP server id and only servers from this
      // file are offered in settings, so an unlisted id can never be pointed
      // at a proxy by the user.
      offenders.push(`${manifest.id}: mcpServerId "${serverId}" is not declared in extensions_config.json`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the broker sends each source the proxy resolved from its own MCP server policy", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `egress-broker-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const { project, session, store } = await preparedStore(dataDir);

  const registry = createBuiltinMcpSourceRegistry();
  // A source that does not exist yet: the broker must derive its proxy from the
  // manifest, never from a list of known server ids.
  const pdb = registry.get("pdb").manifest;
  const probeManifest: McpSourceManifest = {
    ...structuredClone(pdb),
    id: "contract-probe",
    tools: {
      probe: {
        ...structuredClone(pdb.tools.lookup_structure!),
        id: "probe",
        mcpToolName: "probe_lookup",
      },
    },
    transport: { mcpServerId: "probe-server", type: "mcp" },
  };
  const probe: McpSourceAdapter = {
    manifest: probeManifest,
    normalizeResult: async (_context, raw) => JSON.parse(
      raw.content[0]?.type === "text" ? raw.content[0].text : "{}",
    ) as McpToolResult,
    validateInput: () => ({ input: { pdb_id: "1CRN" } as JsonValue, valid: true }),
  };
  registry.upsert(probe);

  const serverIds = ["biomed", "uniprot", "probe-server"];
  const urls = await proxyPerServer(store, serverIds);
  const seen: McpInvokeRequest[] = [];
  const transport = recordingTransport(registry, seen);
  const broker = new McpGovernanceBroker(dataDir, store, registry, new McpSourceCatalog(registry, transport), transport);

  const probes: Array<{ input: JsonValue; sourceId: string; toolId: string }> = [
    { input: { pdb_id: "1CRN" }, sourceId: "pdb", toolId: "lookup_structure" },
    { input: { accession: "P69905" }, sourceId: "uniprot", toolId: "lookup" },
    { input: { pdb_id: "1CRN" }, sourceId: "contract-probe", toolId: "probe" },
  ];
  for (const item of probes) {
    await broker.invoke({
      allowedSourceIds: [item.sourceId],
      input: item.input,
      projectId: project.id,
      sessionId: session.id,
      sourceId: item.sourceId,
      toolCallId: `call-${item.sourceId}`,
      toolId: item.toolId,
      turnId: `turn-${item.sourceId}`,
    });
  }

  assert.equal(seen.length, probes.length);
  for (const [index, item] of probes.entries()) {
    const request = seen[index]!;
    const serverId = registry.get(item.sourceId).manifest.transport.mcpServerId;
    assert.equal(request.serverId, serverId, `${item.sourceId} was invoked on the wrong MCP server`);
    assert.deepEqual(
      request.proxy,
      { mode: "url", url: `${urls.get(serverId)!}/` },
      `${item.sourceId} did not carry the proxy configured for MCP server "${serverId}"`,
    );
  }
});

test("every artifact-producing source downloads bytes under its own MCP server proxy", async (context) => {
  const dataDir = resolve(process.cwd(), ".tmp", `egress-artifacts-${Date.now()}-${process.pid}`);
  await mkdir(dataDir, { recursive: true });
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const { project, session, store } = await preparedStore(dataDir);

  const registry = createBuiltinMcpSourceRegistry();
  const artifactSources = registry.listManifests().filter((manifest) =>
    Object.values(manifest.tools).some((tool) => tool.kind === "artifact-plan"));
  assert.ok(artifactSources.length > 1, "no artifact-producing MCP sources were found");
  const serverIds = [...new Set(artifactSources.map((manifest) => manifest.transport.mcpServerId))];
  assert.ok(serverIds.length > 1, "artifact sources must span more than one MCP server to be discriminating");
  await proxyPerServer(store, serverIds);

  const transport = recordingTransport(registry, []);
  const broker = new McpGovernanceBroker(dataDir, store, registry, new McpSourceCatalog(registry, transport), transport);
  const bytes = Buffer.from("contract probe payload\n");
  const dispatchers = new Map<string, unknown>();
  const manager = new GovernedDownloadManager(store, registry, broker, async (url, init) => {
    const target = String(url);
    dispatchers.set(target, (init as { dispatcher?: unknown } | undefined)?.dispatcher);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) }, status: 200 });
  });

  for (const manifest of artifactSources) {
    const host = manifest.governance.networkHosts[0]!;
    const sourceUrl = `https://${host}/contract-probe/${manifest.id}.bin`;
    const toolId = Object.values(manifest.tools).find((tool) => tool.kind === "artifact-plan")!.id;
    const result: McpToolResult = {
      artifacts: [{
        attribution: manifest.governance.attribution,
        format: "bin",
        id: `${manifest.id}-candidate`,
        kind: "dataset",
        license: manifest.governance.license,
        logicalName: `${manifest.id}.bin`,
        mimeType: "application/octet-stream",
        sourceId: manifest.id,
        sourceRecordId: "probe",
        sourceUrl,
      }],
      attribution: manifest.governance.attribution,
      license: manifest.governance.license,
      records: [],
      retrievedAt: new Date().toISOString(),
      sourceId: manifest.id,
      toolId,
      untrusted: true,
      warnings: [],
    };
    const timestamp = new Date().toISOString();
    const invocation: McpInvocation = {
      adapterVersion: manifest.version,
      attempts: [],
      attribution: manifest.governance.attribution,
      cache: { hit: false, key: `${manifest.id}-probe`, scope: manifest.cache.scope },
      finishedAt: timestamp,
      id: `invocation-${manifest.id}`,
      license: manifest.governance.license,
      mcpServerId: manifest.transport.mcpServerId,
      normalizedResult: await broker.cas.put(JSON.stringify(result)),
      projectId: project.id,
      request: await broker.cas.put("{}"),
      resultCount: 0,
      sessionId: session.id,
      sourceId: manifest.id,
      startedAt: timestamp,
      status: "succeeded",
      toolCallId: `call-${manifest.id}`,
      toolId,
      transport: "mcp",
      turnId: `turn-${manifest.id}`,
    };
    await store.appendMcpInvocation(invocation);

    const creation = await manager.prepare(session.id, {
      candidateId: `${manifest.id}-candidate`,
      destination: { path: `downloads/${manifest.id}.bin`, type: "workspace" },
      mcpInvocationId: invocation.id,
    });
    assert.ok(creation.permissionRequest, `${manifest.id} did not ask for download permission`);
    const terminalPromise = manager.waitForPlanTerminal(session.id, creation.plan.id);
    await store.decidePermissionRequest(creation.permissionRequest.id, "allow_once");
    await manager.approveByPermissionRequest(creation.permissionRequest.id);
    const terminal = await terminalPromise;
    assert.equal(terminal.status, "completed", `${manifest.id} download did not complete`);

    const expected = proxyDispatcher(
      store.resolveProxy(store.mcpProxyPolicy(manifest.transport.mcpServerId)),
      sourceUrl,
    );
    assert.ok(expected, `${manifest.id}: the test policy must resolve to a real proxy`);
    assert.equal(
      dispatchers.get(sourceUrl),
      expected,
      `${manifest.id} bytes did not use the proxy of MCP server "${manifest.transport.mcpServerId}"`,
    );
  }
});

test("outbound code that pins a proxy dispatcher does not use Node's global fetch", async () => {
  // Node's global fetch is bound to the runtime's bundled undici copy and
  // rejects dispatchers built from the workspace's undici package, so pairing
  // the two fails every proxied request while direct requests keep working.
  const roots = ["packages", "services"].map((name) => join(REPOSITORY_ROOT, name));
  const globalFetchCall = /(?<![.\w$])fetch\s*\(/u;
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      if (file.endsWith(".test.ts")) continue;
      const source = await readFile(file, "utf8");
      if (!source.includes("proxyDispatcher(")) continue;
      if (globalFetchCall.test(source)) {
        offenders.push(`${file.slice(REPOSITORY_ROOT.length + 1)}: fetch through undici (proxyFetch) instead`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the shared proxy fetch accepts the dispatchers the workspace builds", async (context) => {
  const received: string[] = [];
  const proxy = createServer((request, response) => {
    received.push(String(request.url));
    response.writeHead(200, { "content-length": "2" });
    response.end("ok");
  });
  await new Promise<void>((listening) => proxy.listen(0, "127.0.0.1", listening));
  context.after(() => new Promise<void>((closed) => {
    proxy.closeAllConnections();
    proxy.close(() => closed());
  }));
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("Proxy did not bind a port");

  const target = "http://files.rcsb.org/download/1CRN.cif";
  const dispatcher = proxyDispatcher({ mode: "url", url: `http://127.0.0.1:${address.port}` }, target);
  assert.ok(dispatcher);
  const response = await proxyFetch(target, { dispatcher } as RequestInit);
  assert.equal(await response.text(), "ok");
  assert.deepEqual(received, [target]);

  // The guard this whole contract exists for: the global client cannot consume
  // the same dispatcher, so outbound code must not fall back to it.
  await assert.rejects(() => globalThis.fetch(target, { dispatcher } as RequestInit), /fetch failed/);
});

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["dist", "node_modules", ".tmp"].includes(entry.name)) continue;
    const child = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (extname(entry.name) === ".ts") files.push(child);
  }
  return files;
}
