// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { OperationalLogger } from "@sciencediscovery/operational-logging";
import { createTest } from "../../../../test/support/tagged/compat.mjs";
import type { ExtensionsConfigFile, McpServerEntry } from "./extensions-config.js";
import { McpNodeClient } from "./node-client.js";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "arch:amd64", "arch:arm64"] });
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const state = { initializations: 0, toolLists: 0, deletes: 0, holdNextList: false, authorizedWithSecondKey: false }, events: string[] = [];
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const http = createServer(async (request, response) => {
    if (request.method === "DELETE") { state.deletes++; response.writeHead(200); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let text = ""; for await (const part of request) { text += String(part); } const rpc = JSON.parse(text);
    if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
    let result: unknown;
    if (rpc.method === "initialize") { state.initializations++; state.authorizedWithSecondKey = request.headers.authorization === "Bearer synthetic-second"; result = { protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Owned fixture", version: "1" } }; }
    else if (rpc.method === "tools/list") { state.toolLists++; if (state.holdNextList) { state.holdNextList = false; entered(); await gate; } result = { tools: [{ name: "owned_echo", description: "Owned read-only tool", inputSchema: { type: "object", properties: {} } }] }; }
    else { response.writeHead(400); response.end(); return; }
    if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "owned-cache-session" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })); }
  }); await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve)); const address = http.address(); assert.ok(address && typeof address !== "string");
  const server: McpServerEntry & { name: string } = { name: "Owned before", description: "Old metadata", transport: "http", enabled: true, url: `http://127.0.0.1:${address.port}/mcp`, args: [], env: {}, headers: { Authorization: "Bearer synthetic-first" }, routing: { mode: "off", priority: 0, keywords: [] }, toolOverrides: {} };
  const config: ExtensionsConfigFile = { path: undefined, signature: "owned-config", servers: { owned: server } }, logger: OperationalLogger = { path: "owned-memory", debug() {}, info(event, fields) { events.push(`${event}:${String(fields?.reason ?? "")}`); }, warn() {}, error() {} }, client = new McpNodeClient(() => config, undefined, logger);
  context.after(async () => { release(); await client.close(); await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }); });
  const metadata = () => { server.name = "Renamed owned"; server.description = "Changed display metadata"; config.signature = "new-display-signature"; };
  return { state, events, client, server, config, metadata, held, release };
}

test("CFG-XBUG-11: display metadata does not reconnect an unchanged MCP transport on the next catalog read", async context => {
  const h = await fixture(context); assert.equal((await h.client.catalog()).servers[0]?.tools.length, 1); assert.equal(h.state.initializations, 1); h.metadata();
  assert.equal((await h.client.catalog()).servers[0]?.tools.length, 1); assert.equal(h.state.initializations, 1); assert.equal(h.state.deletes, 0); assert.ok(!h.events.some(event => event === "mcp_connection_closed:configuration_changed"));
});

test("CFG-XBUG-11: changing an actual authorization header still reconnects with the new credential", async context => {
  const h = await fixture(context); await h.client.catalog(); h.server.headers = { Authorization: "Bearer synthetic-second" }; await h.client.catalog(); assert.equal(h.state.initializations, 2); assert.equal(h.state.authorizedWithSecondKey, true); assert.ok(h.events.some(event => event === "mcp_connection_closed:configuration_changed"));
});

test("CFG-XBUG-11: metadata changes do not close an existing in-flight catalog request when another read arrives", async context => {
  const h = await fixture(context); await h.client.catalog(); h.state.holdNextList = true; const first = h.client.catalog();
  let timer: ReturnType<typeof setTimeout>; await Promise.race([h.held, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned held request not reached")), 5_000); })]).finally(() => clearTimeout(timer));
  h.metadata(); const next = await h.client.catalog(); h.release(); const original = await first;
  assert.equal(next.servers[0]?.tools.length, 1); assert.equal(original.servers[0]?.error, undefined); assert.equal(original.servers[0]?.tools.length, 1); assert.equal(h.state.initializations, 1);
});
